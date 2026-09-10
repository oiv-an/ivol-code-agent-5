import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import axios from "axios"

import { type ModelInfo, openAiModelInfoSaneDefaults, LMSTUDIO_DEFAULT_TEMPERATURE } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { NativeToolCallParser } from "../../core/assistant-message/NativeToolCallParser"
import { XmlMatcher } from "../../utils/xml-matcher"

import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"

import { BaseProvider } from "./base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { getModelsFromCache } from "./fetchers/modelCache"
import { getApiRequestTimeout } from "./utils/timeout-config"
import { handleOpenAIError } from "./utils/openai-error-handler"
import { createProviderFetch } from "./utils/provider-tls" // kilocode_change

export class LmStudioHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private client: OpenAI
	private readonly providerName = "LM Studio"

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options

		// LM Studio uses "noop" as a placeholder API key
		const apiKey = "noop"
		// kilocode_change start
		const baseURL = (this.options.lmStudioBaseUrl || "http://localhost:1234") + "/v1"
		const timeout = getApiRequestTimeout()
		// kilocode_change end

		this.client = new OpenAI({
			baseURL,
			apiKey: apiKey,
			timeout,
			// kilocode_change start
			...(this.options.allowInsecureTls === true
				? { fetch: createProviderFetch({ baseUrl: baseURL, allowInsecureTls: true, timeoutMs: timeout }) }
				: {}),
			// kilocode_change end
		})
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// kilocode_change: only diagnostic requests opt into request-local cancellation.
		const signal = this.options.connectionTest ? metadata?.signal : undefined
		signal?.throwIfAborted()
		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		// LM Studio always supports native tools (https://lmstudio.ai/docs/developer/core/tools)
		const useNativeTools = metadata?.tools && metadata.tools.length > 0 && metadata?.toolProtocol !== "xml"

		// -------------------------
		// Track token usage
		// -------------------------
		const toContentBlocks = (
			blocks: Anthropic.Messages.MessageParam[] | string,
		): Anthropic.Messages.ContentBlockParam[] => {
			if (typeof blocks === "string") {
				return [{ type: "text", text: blocks }]
			}

			const result: Anthropic.Messages.ContentBlockParam[] = []
			for (const msg of blocks) {
				if (typeof msg.content === "string") {
					result.push({ type: "text", text: msg.content })
				} else if (Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part.type === "text") {
							result.push({ type: "text", text: part.text })
						}
					}
				}
			}
			return result
		}

		let inputTokens = 0
		try {
			inputTokens = await this.countTokens([{ type: "text", text: systemPrompt }, ...toContentBlocks(messages)])
		} catch (err) {
			if (!this.options.connectionTest) console.error("[LmStudio] Failed to count input tokens:", err) // kilocode_change
			inputTokens = 0
		}

		let assistantText = ""

		try {
			const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming & { draft_model?: string } = {
				model: this.getModel().id,
				messages: openAiMessages,
				temperature: this.options.modelTemperature ?? LMSTUDIO_DEFAULT_TEMPERATURE,
				stream: true,
				...(useNativeTools && { tools: this.convertToolsForOpenAI(metadata.tools) }),
				...(useNativeTools && metadata.tool_choice && { tool_choice: metadata.tool_choice }),
				...(useNativeTools && { parallel_tool_calls: metadata?.parallelToolCalls ?? false }),
			}

			if (this.options.lmStudioSpeculativeDecodingEnabled && this.options.lmStudioDraftModelId) {
				params.draft_model = this.options.lmStudioDraftModelId
			}

			let results
			try {
				// kilocode_change start: diagnostics own the complete timeout/retry budget.
				signal?.throwIfAborted()
				results = this.options.connectionTest
					? await this.client.chat.completions.create(params, { signal, maxRetries: 0 })
					: await this.client.chat.completions.create(params)
				// kilocode_change end
			} catch (error) {
				if (this.options.connectionTest) throw error // kilocode_change: preserve HTTP metadata without raw logging.
				throw handleOpenAIError(error, this.providerName)
			}

			const matcher = new XmlMatcher(
				"think",
				(chunk) =>
					({
						type: chunk.matched ? "reasoning" : "text",
						text: chunk.data,
					}) as const,
			)

			for await (const chunk of results) {
				signal?.throwIfAborted() // kilocode_change
				const delta = chunk.choices[0]?.delta
				const finishReason = chunk.choices[0]?.finish_reason

				if (delta?.content) {
					assistantText += delta.content
					for (const processedChunk of matcher.update(delta.content)) {
						yield processedChunk
					}
				}

				// Handle tool calls in stream - emit partial chunks for NativeToolCallParser
				if (delta?.tool_calls) {
					for (const toolCall of delta.tool_calls) {
						yield {
							type: "tool_call_partial",
							index: toolCall.index,
							id: toolCall.id,
							name: toolCall.function?.name,
							arguments: toolCall.function?.arguments,
						}
					}
				}

				// Process finish_reason to emit tool_call_end events
				if (finishReason && !this.options.connectionTest) {
					// kilocode_change: do not read another Task's tool parser state.
					const endEvents = NativeToolCallParser.processFinishReason(finishReason)
					for (const event of endEvents) {
						yield event
					}
				}
			}
			signal?.throwIfAborted() // kilocode_change: SDK cancellation can silently end an iterator.

			for (const processedChunk of matcher.final()) {
				yield processedChunk
			}

			let outputTokens = 0
			try {
				outputTokens = await this.countTokens([{ type: "text", text: assistantText }])
			} catch (err) {
				if (!this.options.connectionTest) console.error("[LmStudio] Failed to count output tokens:", err) // kilocode_change
				outputTokens = 0
			}

			yield {
				type: "usage",
				inputTokens,
				outputTokens,
			} as const
		} catch (error) {
			if (this.options.connectionTest) throw error // kilocode_change: retain the real diagnostic failure.
			throw new Error(
				"Please check the LM Studio developer logs to debug what went wrong. You may need to load the model with a larger context length to work with IVOL Code's prompts.",
			)
		}
	}

	override getModel(): { id: string; info: ModelInfo } {
		// kilocode_change start: do not read another endpoint's or TLS policy's catalog.
		const models = getModelsFromCache("lmstudio", {
			baseUrl: this.options.lmStudioBaseUrl,
			allowInsecureTls: this.options.allowInsecureTls,
		})
		// kilocode_change end
		if (models && this.options.lmStudioModelId && models[this.options.lmStudioModelId]) {
			return {
				id: this.options.lmStudioModelId,
				info: models[this.options.lmStudioModelId],
			}
		} else {
			return {
				id: this.options.lmStudioModelId || "",
				info: openAiModelInfoSaneDefaults,
			}
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		try {
			// Create params object with optional draft model
			const params: any = {
				model: this.getModel().id,
				messages: [{ role: "user", content: prompt }],
				temperature: this.options.modelTemperature ?? LMSTUDIO_DEFAULT_TEMPERATURE,
				stream: false,
			}

			// Add draft model if speculative decoding is enabled and a draft model is specified
			if (this.options.lmStudioSpeculativeDecodingEnabled && this.options.lmStudioDraftModelId) {
				params.draft_model = this.options.lmStudioDraftModelId
			}

			let response
			try {
				response = await this.client.chat.completions.create(params)
			} catch (error) {
				throw handleOpenAIError(error, this.providerName)
			}
			return response.choices[0]?.message.content || ""
		} catch (error) {
			throw new Error(
				"Please check the LM Studio developer logs to debug what went wrong. You may need to load the model with a larger context length to work with IVOL Code's prompts.",
			)
		}
	}
}

export async function getLmStudioModels(baseUrl = "http://localhost:1234", allowInsecureTls?: boolean) {
	// kilocode_change
	try {
		if (!URL.canParse(baseUrl)) {
			return []
		}

		// kilocode_change start
		if (allowInsecureTls === true) {
			const request = createProviderFetch({ baseUrl, allowInsecureTls: true, timeoutMs: 8_000 })
			const response = await request(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(8_000) })
			if (!response.ok) {
				await response.body?.cancel()
				return []
			}
			const data = await response.json()
			return [...new Set<string>(data?.data?.map((model: { id: string }) => model.id) ?? [])]
		}
		// kilocode_change end
		const response = await axios.get(`${baseUrl}/v1/models`)
		const modelsArray = response.data?.data?.map((model: any) => model.id) || []
		return [...new Set<string>(modelsArray)]
	} catch (error) {
		return []
	}
}
