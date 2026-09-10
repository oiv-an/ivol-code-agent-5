import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI, { AzureOpenAI } from "openai"
import axios from "axios"

import {
	type ModelInfo,
	azureOpenAiDefaultApiVersion,
	DEFAULT_OPENAI_WEB_SEARCH_ENABLED,
	openAiModelInfoSaneDefaults,
	NATIVE_TOOL_DEFAULTS,
	DEEP_SEEK_DEFAULT_TEMPERATURE,
	OPENAI_AZURE_AI_INFERENCE_PATH,
	supportsOpenAiMaxReasoningEffort, // kilocode_change
} from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { XmlMatcher } from "../../utils/xml-matcher"

import { convertToOpenAiMessages } from "../transform/openai-format"
import { convertToR1Format } from "../transform/r1-format"
import { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { getModelParams } from "../transform/model-params"

import { DEFAULT_HEADERS } from "./constants"
import { BaseProvider } from "./base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { getApiRequestTimeout } from "./utils/timeout-config"
import { handleOpenAIError } from "./utils/openai-error-handler"
// kilocode_change start: task-scoped cancellation and transport diagnostics
import { createOpenAiFetch } from "./utils/openai-fetch"
import { createProviderFetch } from "./utils/provider-tls" // kilocode_change
import { isOpenAiAbortError, normalizeOpenAiTransportError } from "./utils/openai-transport-error"
// kilocode_change end

// kilocode_change start: keep normal OpenAI turns on Chat Completions and expose
// native Responses web search as a provider-local function tool. The tool is
// executed by the task pipeline only when the model actually selects it.
export const OPENAI_NATIVE_WEB_SEARCH_TOOL_NAME = "web_search"

const OPENAI_NATIVE_WEB_SEARCH_TOOL: OpenAI.Chat.ChatCompletionFunctionTool = {
	type: "function",
	function: {
		name: OPENAI_NATIVE_WEB_SEARCH_TOOL_NAME,
		strict: true,
		description:
			"Search the live web using the provider's native OpenAI Responses web_search tool. Call this autonomously only when the request depends on current, changing, external, or otherwise unavailable information. Do not use it for facts already present in the conversation or local workspace.",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "A concise, self-contained web search query.",
				},
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
}
// kilocode_change end

// kilocode_change start: personal fork prompt-cache compatibility
type OpenAiChatMessage = OpenAI.Chat.ChatCompletionMessageParam

function buildCacheMarkedOpenAiMessages(
	systemPrompt: string,
	messages: Anthropic.Messages.MessageParam[],
): OpenAiChatMessage[] {
	const systemMessage: OpenAI.Chat.ChatCompletionSystemMessageParam = {
		role: "system",
		content: [
			{
				type: "text",
				text: systemPrompt,
				cache_control: { type: "ephemeral" },
			} as OpenAI.Chat.ChatCompletionContentPartText & { cache_control: { type: "ephemeral" } },
		],
	}

	const convertedMessages: OpenAiChatMessage[] = [systemMessage, ...convertToOpenAiMessages(messages)]

	const lastTwoUserMessages = convertedMessages.filter((message) => message.role === "user").slice(-2)
	for (const message of lastTwoUserMessages) {
		if (typeof message.content === "string") {
			message.content = [{ type: "text", text: message.content }]
		}

		if (!Array.isArray(message.content)) continue
		const lastTextPart = [...message.content].reverse().find((part) => part.type === "text") as
			| (OpenAI.Chat.ChatCompletionContentPartText & { cache_control?: { type: "ephemeral" } })
			| undefined

		// Never alter an image-only prompt merely to attach cache metadata.
		if (!lastTextPart) continue
		lastTextPart.cache_control = { type: "ephemeral" }
	}

	return convertedMessages
}

function isUnsupportedPromptCacheError(error: unknown): boolean {
	const candidate = error as {
		status?: number
		message?: string
		error?: { message?: string }
		response?: { status?: number; data?: { error?: { message?: string }; message?: string } }
	}
	const status = candidate?.status ?? candidate?.response?.status
	if (status !== 400 && status !== 422) return false

	const message = [
		candidate?.message,
		candidate?.error?.message,
		candidate?.response?.data?.error?.message,
		candidate?.response?.data?.message,
	]
		.filter(Boolean)
		.join(" ")

	const rejectedCacheField =
		/cache[_ -]?control/i.test(message) &&
		/(unsupported|unknown|unrecognized|not permitted|not allowed|forbidden|prohibited|disallowed|extra|invalid)/i.test(
			message,
		)
	const rejectedStructuredContent =
		/(?:content|message).*(?:expected|must be|invalid).*(?:string|array)|(?:expected|must be).*string.*content/i.test(
			message,
		)

	return rejectedCacheField || rejectedStructuredContent
}
// kilocode_change end

// TODO: Rename this to OpenAICompatibleHandler. Also, I think the
// `OpenAINativeHandler` can subclass from this, since it's obviously
// compatible with the OpenAI API. We can also rename it to `OpenAIHandler`.
export class OpenAiHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	protected client: OpenAI
	private readonly providerName = "OpenAI"
	private promptCacheBreakpointsUnsupported = false // kilocode_change: remember incompatible endpoints for this profile

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options

		const baseURL = this.options.openAiBaseUrl ?? "https://api.openai.com/v1"
		const apiKey = this.options.openAiApiKey ?? "not-provided"
		const isAzureAiInference = this._isAzureAiInference(this.options.openAiBaseUrl)
		const urlHost = this._getUrlHost(this.options.openAiBaseUrl)
		const isAzureOpenAi = urlHost === "azure.com" || urlHost.endsWith(".azure.com") || options.openAiUseAzure

		const headers = {
			...DEFAULT_HEADERS,
			...(this.options.openAiHeaders || {}),
		}

		const timeout = getApiRequestTimeout()
		// kilocode_change start: TLS opt-out applies only to this profile's API origin.
		const fetch =
			this.options.allowInsecureTls === true
				? createProviderFetch({ baseUrl: baseURL, allowInsecureTls: true, timeoutMs: timeout })
				: createOpenAiFetch(timeout)
		// kilocode_change end

		if (isAzureAiInference) {
			// Azure AI Inference Service (e.g., for DeepSeek) uses a different path structure
			this.client = new OpenAI({
				baseURL,
				apiKey,
				defaultHeaders: headers,
				defaultQuery: { "api-version": this.options.azureApiVersion || "2024-05-01-preview" },
				timeout,
				fetch, // kilocode_change
			})
		} else if (isAzureOpenAi) {
			// Azure API shape slightly differs from the core API shape:
			// https://github.com/openai/openai-node?tab=readme-ov-file#microsoft-azure-openai
			this.client = new AzureOpenAI({
				baseURL,
				apiKey,
				apiVersion: this.options.azureApiVersion || azureOpenAiDefaultApiVersion,
				defaultHeaders: headers,
				timeout,
				fetch, // kilocode_change
			})
		} else {
			this.client = new OpenAI({
				baseURL,
				apiKey,
				defaultHeaders: headers,
				timeout,
				fetch, // kilocode_change
			})
		}
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// kilocode_change start: include iterator failures, not only response headers.
		try {
			yield* this.createMessageInternal(systemPrompt, messages, metadata)
			// The SDK silently ends an aborted SSE iterator. Preserve cancellation
			// instead of letting callers mistake it for a successful empty response.
			metadata?.signal?.throwIfAborted()
		} catch (error) {
			if (metadata?.signal?.aborted) {
				const cancelled = new Error("OpenAI request cancelled.")
				cancelled.name = "AbortError"
				throw cancelled
			}
			if (this.options.connectionTest) throw error // kilocode_change: preserve metadata for the safe report.
			throw normalizeOpenAiTransportError(error) ?? error
		}
		// kilocode_change end
	}

	// kilocode_change start
	private getMainRequestConfig(metadata?: ApiHandlerCreateMessageMetadata): Record<string, unknown> {
		return {
			...(this._isAzureAiInference(this.options.openAiBaseUrl) ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
			...(metadata?.signal ? { signal: metadata.signal } : {}),
			// Task owns the retry budget. Do not multiply it by the SDK's retries.
			maxRetries: 0,
		}
	}

	private handleCompletionError(error: unknown): unknown {
		if (this.options.connectionTest) return error // kilocode_change: no raw SDK logging during diagnostics.
		if (isOpenAiAbortError(error) && error instanceof Error) return error
		return normalizeOpenAiTransportError(error) ?? handleOpenAIError(error, this.providerName)
	}
	// kilocode_change end

	private async *createMessageInternal(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { info: modelInfo, reasoning } = this.getModel()
		const modelUrl = this.options.openAiBaseUrl ?? ""
		const modelId = this.options.openAiModelId ?? ""
		const enabledR1Format = this.options.openAiR1FormatEnabled ?? false
		const deepseekReasoner = modelId.includes("deepseek-reasoner") || enabledR1Format
		const toolRequestOptions = this.getToolRequestOptions(metadata)
		// kilocode_change start: keep a plain payload for incompatible cache dialects
		const plainMessages: OpenAiChatMessage[] = deepseekReasoner
			? convertToR1Format([{ role: "user", content: systemPrompt }, ...messages])
			: [{ role: "system", content: systemPrompt }, ...convertToOpenAiMessages(messages)]
		const usePromptCacheBreakpoints =
			modelInfo.supportsPromptCache && !deepseekReasoner && this.shouldUseLegacyPromptCacheBreakpoints(modelUrl)
		// kilocode_change end
		// kilocode_change removed const ark = modelUrl.includes(".volces.com")

		if (modelId.includes("o1") || modelId.includes("o3") || modelId.includes("o4")) {
			yield* this.handleO3FamilyMessage(modelId, systemPrompt, messages, metadata)
			return
		}

		// kilocode_change start: attach cache breakpoints only for the compatible gateway dialect
		const convertedMessages = usePromptCacheBreakpoints
			? buildCacheMarkedOpenAiMessages(systemPrompt, messages)
			: plainMessages
		// kilocode_change end

		if (this.options.openAiStreamingEnabled ?? true) {
			const isGrokXAI = this._isGrokXAI(this.options.openAiBaseUrl)

			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
				model: modelId,
				temperature: this.options.modelTemperature ?? (deepseekReasoner ? DEEP_SEEK_DEFAULT_TEMPERATURE : 0),
				messages: convertedMessages,
				stream: true as const,
				...(isGrokXAI ? {} : { stream_options: { include_usage: true } }),
				...(reasoning && reasoning),
				...toolRequestOptions,
			}

			// Add max_tokens if needed
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			// kilocode_change start: retry unsupported cache payloads without cache metadata
			const stream = await this.createChatCompletionWithCacheFallback(
				requestOptions,
				this.getMainRequestConfig(metadata), // kilocode_change
				usePromptCacheBreakpoints ? plainMessages : undefined,
			)
			// kilocode_change end

			const matcher = new XmlMatcher(
				"think",
				(chunk) =>
					({
						type: chunk.matched ? "reasoning" : "text",
						text: chunk.data,
					}) as const,
			)

			let lastUsage
			const activeToolCallIds = new Set<string>()

			for await (const chunk of stream) {
				const delta = chunk.choices?.[0]?.delta ?? {}
				const finishReason = chunk.choices?.[0]?.finish_reason

				if (delta.content) {
					for (const chunk of matcher.update(delta.content)) {
						yield chunk
					}
				}

				// kilocode_change start: reasoning
				const reasoningText =
					"reasoning_content" in delta && typeof delta.reasoning_content === "string"
						? delta.reasoning_content
						: "reasoning" in delta && typeof delta.reasoning === "string"
							? delta.reasoning
							: undefined
				if (reasoningText) {
					yield {
						type: "reasoning",
						text: reasoningText,
					}
				}
				// kilocode_change end

				yield* this.processToolCalls(delta, finishReason, activeToolCallIds)

				if (chunk.usage) {
					lastUsage = chunk.usage
				}
			}

			for (const chunk of matcher.final()) {
				yield chunk
			}

			if (lastUsage) {
				yield this.processUsageMetrics(lastUsage, modelInfo)
			}
		} else {
			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: modelId,
				messages: convertedMessages, // kilocode_change: use the selected cache-compatible payload
				...(reasoning && reasoning), // kilocode_change: preserve xhigh/max in non-streaming requests
				...toolRequestOptions,
			}

			// Add max_tokens if needed
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			// kilocode_change start: retry unsupported cache payloads without cache metadata
			const response = await this.createChatCompletionWithCacheFallback(
				requestOptions,
				this.getMainRequestConfig(metadata), // kilocode_change
				usePromptCacheBreakpoints ? plainMessages : undefined,
			)
			// kilocode_change end

			// kilocode_change start: reasoning
			const message = response.choices[0]?.message
			if (message) {
				if ("reasoning" in message && typeof message.reasoning === "string") {
					yield {
						type: "reasoning",
						text: message.reasoning,
					}
				}
				if (message.content) {
					yield {
						type: "text",
						text: message.content || "",
					}
				}
			}
			// kilocode_change end

			if (message?.tool_calls) {
				for (const toolCall of message.tool_calls) {
					if (toolCall.type === "function") {
						yield {
							type: "tool_call",
							id: toolCall.id,
							name: toolCall.function.name,
							arguments: toolCall.function.arguments,
						}
					}
				}
			}

			yield this.processUsageMetrics(response.usage, modelInfo)
		}
	}

	// kilocode_change start: normalize cache usage from compatible gateways
	protected processUsageMetrics(usage: any, _modelInfo?: ModelInfo): ApiStreamUsageChunk {
		return {
			type: "usage",
			inputTokens: usage?.prompt_tokens || 0,
			outputTokens: usage?.completion_tokens || 0,
			cacheWriteTokens:
				usage?.cache_creation_input_tokens || usage?.prompt_tokens_details?.cache_write_tokens || undefined,
			cacheReadTokens: usage?.cache_read_input_tokens || usage?.prompt_tokens_details?.cached_tokens || undefined,
		}
	}
	// kilocode_change end

	// kilocode_change start: compatible-gateway prompt-cache fallback
	private async createChatCompletionWithCacheFallback(
		requestOptions:
			| OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
			| OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
		requestConfig: Record<string, unknown>,
		plainMessages?: OpenAiChatMessage[],
	): Promise<any> {
		try {
			return await this.client.chat.completions.create(requestOptions as any, requestConfig)
		} catch (error) {
			if (this.options.connectionTest) throw error // kilocode_change: one diagnostic request, with its original error.
			if (!plainMessages || !isUnsupportedPromptCacheError(error)) {
				throw this.handleCompletionError(error)
			}

			this.promptCacheBreakpointsUnsupported = true
			const fallbackOptions = {
				...requestOptions,
				// Use the untouched OpenAI-compatible payload. Merely removing the
				// cache field would leave formerly-string content converted to arrays.
				messages: plainMessages,
			}
			try {
				return await this.client.chat.completions.create(fallbackOptions as any, requestConfig)
			} catch (fallbackError) {
				throw this.handleCompletionError(fallbackError)
			}
		}
	}

	private shouldUseLegacyPromptCacheBreakpoints(modelUrl: string): boolean {
		if (this.promptCacheBreakpointsUnsupported) return false

		const effectiveUrl = modelUrl || "https://api.openai.com/v1"
		const host = this._getUrlHost(effectiveUrl)
		const isAzure =
			this.options.openAiUseAzure || this._isAzureAiInference(effectiveUrl) || host.endsWith(".azure.com")

		// OpenAI and Azure cache supported prompts automatically. The user's
		// OpenAI-compatible gateways use the legacy part-level cache_control dialect.
		return !isAzure && host !== "api.openai.com"
	}

	/**
	 * Build the function-tool portion of a normal Chat Completions request.
	 * Enabling web search only advertises a local function to the primary model;
	 * it does not change this request's endpoint or model. The executor for this
	 * function performs the bounded Responses API search request separately.
	 */
	private getToolRequestOptions(
		metadata?: ApiHandlerCreateMessageMetadata,
	): Pick<OpenAI.Chat.Completions.ChatCompletionCreateParams, "tools" | "tool_choice" | "parallel_tool_calls"> {
		const webSearchEnabled = this.options.openAiWebSearchEnabled ?? DEFAULT_OPENAI_WEB_SEARCH_ENABLED
		// Only force the OpenAI-specific serial-call flag when web search was
		// explicitly enabled on the saved provider profile. Some compatible
		// gateways (notably LiteLLM/Bedrock routes) reject the field entirely,
		// so an implicit default must preserve the legacy omit-unless-true rule.
		const forceSerialWebSearch = this.options.openAiWebSearchEnabled === true
		const configuredTools = this.convertToolsForOpenAI(metadata?.tools) ?? []
		const tools = webSearchEnabled
			? [
					...configuredTools.filter(
						(tool) =>
							tool?.type !== "function" || tool.function?.name !== OPENAI_NATIVE_WEB_SEARCH_TOOL_NAME,
					),
					OPENAI_NATIVE_WEB_SEARCH_TOOL,
				]
			: configuredTools

		if (tools.length === 0) {
			return {}
		}

		return {
			tools,
			...(metadata?.tool_choice
				? { tool_choice: metadata.tool_choice }
				: webSearchEnabled
					? { tool_choice: "auto" as const }
					: {}),
			// Never allow a search request and a local side-effecting tool call in
			// the same model response. Without web search, preserve the old opt-in.
			...(forceSerialWebSearch
				? { parallel_tool_calls: false }
				: metadata?.toolProtocol === "native" && metadata.parallelToolCalls === true
					? { parallel_tool_calls: true }
					: {}),
		}
	}
	// kilocode_change end

	override getModel() {
		const id = this.options.openAiModelId ?? ""
		// Ensure OpenAI-compatible models default to supporting native tool calling.
		// This is required for [`Task.attemptApiRequest()`](src/core/task/Task.ts:3817) to
		// include tool definitions in the request.
		const configuredInfo: ModelInfo = {
			...NATIVE_TOOL_DEFAULTS,
			...(this.options.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults),
			// kilocode_change start: force prompt caching for the personal OpenAI-compatible provider
			// The personal build always enables prompt-cache breakpoints for the
			// user's OpenAI-compatible endpoint.
			supportsPromptCache: true,
			// kilocode_change end
		}
		// kilocode_change start: custom capability data may outlive a model change.
		// Trust API `max` only for a recognized request model; otherwise let the
		// common resolver choose the strongest previous declared effort.
		const requestInfo: ModelInfo =
			!supportsOpenAiMaxReasoningEffort(id) && Array.isArray(configuredInfo.supportsReasoningEffort)
				? {
						...configuredInfo,
						supportsReasoningEffort: configuredInfo.supportsReasoningEffort.filter(
							(effort) => effort !== "max",
						),
					}
				: configuredInfo
		const params = getModelParams({ format: "openai", modelId: id, model: requestInfo, settings: this.options })
		// kilocode_change end
		return { id, info: configuredInfo, ...params }
	}

	async completePrompt(prompt: string): Promise<string> {
		try {
			const isAzureAiInference = this._isAzureAiInference(this.options.openAiBaseUrl)
			const model = this.getModel()
			const modelInfo = model.info

			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: model.id,
				messages: [{ role: "user", content: prompt }],
			}

			// Add max_tokens if needed
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			let response
			try {
				response = await this.client.chat.completions.create(
					requestOptions,
					isAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {},
				)
			} catch (error) {
				throw this.handleCompletionError(error) // kilocode_change
			}

			return response.choices?.[0]?.message.content || ""
		} catch (error) {
			// kilocode_change: preserve sanitized transport metadata for completion callers too.
			const transportError = normalizeOpenAiTransportError(error)
			if (transportError) throw transportError
			if (isOpenAiAbortError(error)) throw error
			if (error instanceof Error) {
				throw new Error(`${this.providerName} completion error: ${error.message}`)
			}

			throw error
		}
	}

	private async *handleO3FamilyMessage(
		modelId: string,
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// kilocode_change start: use the request-time resolved effort instead of
		// reading a potentially stale raw value from custom model metadata.
		const model = this.getModel()
		const modelInfo = model.info
		const reasoningEffort = model.reasoningEffort as OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"]
		// kilocode_change end
		const toolRequestOptions = this.getToolRequestOptions(metadata)

		if (this.options.openAiStreamingEnabled ?? true) {
			const isGrokXAI = this._isGrokXAI(this.options.openAiBaseUrl)

			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
				model: modelId,
				messages: [
					{
						role: "developer",
						content: `Formatting re-enabled\n${systemPrompt}`,
					},
					...convertToOpenAiMessages(messages),
				],
				stream: true,
				...(isGrokXAI ? {} : { stream_options: { include_usage: true } }),
				reasoning_effort: reasoningEffort,
				temperature: undefined,
				...toolRequestOptions,
			}

			// O3 family models do not support the deprecated max_tokens parameter
			// but they do support max_completion_tokens (the modern OpenAI parameter)
			// This allows O3 models to limit response length when includeMaxTokens is enabled
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			let stream
			try {
				stream = await this.client.chat.completions.create(
					requestOptions,
					this.getMainRequestConfig(metadata), // kilocode_change
				)
			} catch (error) {
				throw this.handleCompletionError(error) // kilocode_change
			}

			yield* this.handleStreamResponse(stream)
		} else {
			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: modelId,
				messages: [
					{
						role: "developer",
						content: `Formatting re-enabled\n${systemPrompt}`,
					},
					...convertToOpenAiMessages(messages),
				],
				reasoning_effort: reasoningEffort,
				temperature: undefined,
				...toolRequestOptions,
			}

			// O3 family models do not support the deprecated max_tokens parameter
			// but they do support max_completion_tokens (the modern OpenAI parameter)
			// This allows O3 models to limit response length when includeMaxTokens is enabled
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)

			let response
			try {
				response = await this.client.chat.completions.create(
					requestOptions,
					this.getMainRequestConfig(metadata), // kilocode_change
				)
			} catch (error) {
				throw this.handleCompletionError(error) // kilocode_change
			}

			const message = response.choices?.[0]?.message
			if (message?.tool_calls) {
				for (const toolCall of message.tool_calls) {
					if (toolCall.type === "function") {
						yield {
							type: "tool_call",
							id: toolCall.id,
							name: toolCall.function.name,
							arguments: toolCall.function.arguments,
						}
					}
				}
			}

			yield {
				type: "text",
				text: message?.content || "",
			}
			yield this.processUsageMetrics(response.usage)
		}
	}

	private async *handleStreamResponse(stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>): ApiStream {
		const activeToolCallIds = new Set<string>()

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta
			const finishReason = chunk.choices?.[0]?.finish_reason

			if (delta) {
				if (delta.content) {
					yield {
						type: "text",
						text: delta.content,
					}
				}

				yield* this.processToolCalls(delta, finishReason, activeToolCallIds)
			}

			if (chunk.usage) {
				yield {
					type: "usage",
					inputTokens: chunk.usage.prompt_tokens || 0,
					outputTokens: chunk.usage.completion_tokens || 0,
				}
			}
		}
	}

	/**
	 * Helper generator to process tool calls from a stream chunk.
	 * Tracks active tool call IDs and yields tool_call_partial and tool_call_end events.
	 * @param delta - The delta object from the stream chunk
	 * @param finishReason - The finish_reason from the stream chunk
	 * @param activeToolCallIds - Set to track active tool call IDs (mutated in place)
	 */
	private *processToolCalls(
		delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta | undefined,
		finishReason: string | null | undefined,
		activeToolCallIds: Set<string>,
	): Generator<
		| {
				type: "tool_call_partial"
				index: number
				id?: string
				name?: string
				arguments?: string
				extra_content?: Record<string, unknown> // kilocode_change
		  }
		| { type: "tool_call_end"; id: string }
	> {
		if (delta?.tool_calls) {
			for (const toolCall of delta.tool_calls) {
				if (toolCall.id) {
					activeToolCallIds.add(toolCall.id)
				}
				yield {
					type: "tool_call_partial",
					index: toolCall.index,
					id: toolCall.id,
					name: toolCall.function?.name,
					arguments: toolCall.function?.arguments,
					// kilocode_change start: Preserve extra_content for Gemini 3 thought_signature support
					extra_content: (toolCall as any).extra_content,
					// kilocode_change end
				}
			}
		}

		// Emit tool_call_end events when finish_reason is "tool_calls"
		// This ensures tool calls are finalized even if the stream doesn't properly close
		if (finishReason === "tool_calls" && activeToolCallIds.size > 0) {
			for (const id of activeToolCallIds) {
				yield { type: "tool_call_end", id }
			}
			activeToolCallIds.clear()
		}
	}

	protected _getUrlHost(baseUrl?: string): string {
		try {
			return new URL(baseUrl ?? "").host
		} catch (error) {
			return ""
		}
	}

	private _isGrokXAI(baseUrl?: string): boolean {
		const urlHost = this._getUrlHost(baseUrl)
		return urlHost.includes("x.ai")
	}

	protected _isAzureAiInference(baseUrl?: string): boolean {
		const urlHost = this._getUrlHost(baseUrl)
		return urlHost.endsWith(".services.ai.azure.com")
	}

	/**
	 * Adds max_completion_tokens to the request body if needed based on provider configuration
	 * Note: max_tokens is deprecated in favor of max_completion_tokens as per OpenAI documentation
	 * O3 family models handle max_tokens separately in handleO3FamilyMessage
	 */
	protected addMaxTokensIfNeeded(
		requestOptions:
			| OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
			| OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
		modelInfo: ModelInfo,
	): void {
		// Only add max_completion_tokens if includeMaxTokens is true
		if (this.options.includeMaxTokens === true) {
			// Use user-configured modelMaxTokens if available, otherwise fall back to model's default maxTokens
			// Using max_completion_tokens as max_tokens is deprecated
			requestOptions.max_completion_tokens = this.options.modelMaxTokens || modelInfo.maxTokens
		}
	}
}

export async function getOpenAiModels(
	baseUrl?: string,
	apiKey?: string,
	openAiHeaders?: Record<string, string>,
	allowInsecureTls?: boolean, // kilocode_change
) {
	try {
		if (!baseUrl) {
			return []
		}

		// Trim whitespace from baseUrl to handle cases where users accidentally include spaces
		const trimmedBaseUrl = baseUrl.trim()

		if (!URL.canParse(trimmedBaseUrl)) {
			return []
		}

		// kilocode_change: bound each catalog attempt so authenticated and public fallbacks finish in time
		const config: Record<string, any> = { timeout: 8_000 }
		const headers: Record<string, string> = {
			...DEFAULT_HEADERS,
			...(openAiHeaders || {}),
		}

		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`
		}

		if (Object.keys(headers).length > 0) {
			config["headers"] = headers
		}

		// kilocode_change start: retain the existing strict axios/proxy path unless explicitly opted in.
		const response =
			allowInsecureTls === true
				? await (async () => {
						const request = createProviderFetch({
							baseUrl: trimmedBaseUrl,
							allowInsecureTls: true,
							timeoutMs: 8_000,
						})
						const result = await request(`${trimmedBaseUrl}/models`, {
							headers,
							signal: AbortSignal.timeout(8_000),
						})
						if (!result.ok) {
							await result.body?.cancel()
							throw new Error(`Model catalog request failed (${result.status})`)
						}
						return { data: await result.json() }
					})()
				: await axios.get(`${trimmedBaseUrl}/models`, config)
		// kilocode_change end
		const modelsArray = response.data?.data?.map((model: any) => model.id) || []
		return [...new Set<string>(modelsArray)]
	} catch (error) {
		return []
	}
}
