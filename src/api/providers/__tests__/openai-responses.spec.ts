// kilocode_change - new file
// npx vitest run api/providers/__tests__/openai-responses.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI, { AzureOpenAI } from "openai"

import { OpenAiCompatibleResponsesHandler } from "../openai-responses"
import { OpenAiHandler } from "../openai"
import { ApiHandlerOptions } from "../../../shared/api"
import { buildApiHandler } from "../../index"
import { NonRetryableApiError } from "../utils/non-retryable-api-error"

const mockResponsesCreate = vi.fn()

vitest.mock("openai", () => {
	return {
		__esModule: true,
		default: vi.fn().mockImplementation(() => ({
			responses: {
				create: mockResponsesCreate,
			},
		})),
		AzureOpenAI: vi.fn().mockImplementation(() => ({
			responses: {
				create: mockResponsesCreate,
			},
		})),
	}
})

describe("OpenAiCompatibleResponsesHandler", () => {
	const systemPrompt = "You are a helpful assistant."
	const messages: Anthropic.Messages.MessageParam[] = [
		{
			role: "user",
			content: "Hello!",
		},
	]

	const createMockSseResponse = () => ({
		ok: true,
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('data: {"type":"response.text.delta","delta":"Hello"}\n\n'))
				controller.enqueue(
					new TextEncoder().encode('data: {"type":"response.text.delta","delta":" world"}\n\n'),
				)
				controller.enqueue(
					new TextEncoder().encode(
						'data: {"type":"response.done","response":{"usage":{"prompt_tokens":10,"completion_tokens":2}}}\n\n',
					),
				)
				controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
				controller.close()
			},
		}),
	})

	beforeEach(() => {
		mockResponsesCreate.mockReset()
		vi.mocked(OpenAI).mockClear()
		vi.mocked(AzureOpenAI).mockClear()
		if ((global as any).fetch) {
			delete (global as any).fetch
		}
	})

	afterEach(() => {
		if ((global as any).fetch) {
			delete (global as any).fetch
		}
	})

	it("initializes with provided options", () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "gpt-4o",
		} satisfies ApiHandlerOptions)

		expect(handler.getModel().id).toBe("gpt-4o")
		expect(handler.getModel().info.supportsPromptCache).toBe(true)
	})

	it("sends a plain user prompt as a structured Responses input list", async () => {
		mockResponsesCreate.mockResolvedValue({
			[Symbol.asyncIterator]: async function* () {
				yield { type: "response.output_text.delta", delta: "ok" }
				yield { type: "response.done", response: {} }
			},
		})

		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "gpt-5.6-sol-void",
		} satisfies ApiHandlerOptions)

		for await (const _chunk of handler.createMessage(systemPrompt, messages)) {
		}

		const requestBody = mockResponsesCreate.mock.calls[0][0]
		expect(Array.isArray(requestBody.input)).toBe(true)
		expect(requestBody.input).toEqual([
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Hello!" }],
			},
		])
	})

	it("normalizes a legacy string input at the streaming transport boundary", async () => {
		mockResponsesCreate.mockResolvedValue({
			[Symbol.asyncIterator]: async function* () {
				yield { type: "response.output_text.delta", delta: "ok" }
				yield { type: "response.done", response: {} }
			},
		})

		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "gpt-5.6-sol-void",
		} satisfies ApiHandlerOptions)

		for await (const _chunk of (handler as any).executeRequest({
			model: "gpt-5.6-sol-void",
			input: "Текст запроса",
			stream: true,
		})) {
		}

		expect(mockResponsesCreate.mock.calls[0][0].input).toEqual([
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Текст запроса" }],
			},
		])
	})

	it("normalizes a legacy string input before the non-streaming fetch request", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://prox.example.com",
			openAiModelId: "gpt-5.6-sol-void",
		} satisfies ApiHandlerOptions)
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			body: new ReadableStream(),
			json: async () => ({
				status: "completed",
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "ok" }],
					},
				],
			}),
		})
		global.fetch = mockFetch as any

		for await (const _chunk of (handler as any).executeRequest({
			model: "gpt-5.6-sol-void",
			input: "Текст запроса",
			stream: false,
		})) {
		}

		const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body)
		expect(Array.isArray(requestBody.input)).toBe(true)
		expect(requestBody.input).toEqual([
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Текст запроса" }],
			},
		])
	})

	it("keeps conversation messages, tool calls, and tool results as separate input items", async () => {
		mockResponsesCreate.mockResolvedValue({
			[Symbol.asyncIterator]: async function* () {
				yield { type: "response.output_text.delta", delta: "done" }
				yield { type: "response.done", response: {} }
			},
		})

		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "gpt-5.6-sol-void",
		} satisfies ApiHandlerOptions)
		const conversation: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: "Find the file" },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call_1",
						name: "read_file",
						input: { path: "README.md" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_1",
						content: "file contents",
					},
					{ type: "text", text: "Summarize it" },
				],
			},
		]

		for await (const _chunk of handler.createMessage(systemPrompt, conversation)) {
		}

		expect(mockResponsesCreate.mock.calls[0][0].input).toEqual([
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Find the file" }],
			},
			{
				type: "function_call",
				call_id: "call_1",
				name: "read_file",
				arguments: JSON.stringify({ path: "README.md" }),
			},
			{
				type: "function_call_output",
				call_id: "call_1",
				output: "file contents",
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Summarize it" }],
			},
		])
	})

	it("normalizes a bare custom host before the Responses SDK appends its route", () => {
		new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://prox.example.com",
			openAiModelId: "gpt-5.6",
		} satisfies ApiHandlerOptions)

		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://prox.example.com/v1",
			}),
		)
	})

	it("keeps the visible OpenAI provider on Chat Completions regardless of the search preference", () => {
		const defaultHandler = buildApiHandler({
			apiProvider: "openai",
			openAiApiKey: "test-key",
			openAiModelId: "gpt-5.6",
		})
		const optedOutHandler = buildApiHandler({
			apiProvider: "openai",
			openAiApiKey: "test-key",
			openAiModelId: "gpt-5.6",
			openAiWebSearchEnabled: false,
		})
		const optedInHandler = buildApiHandler({
			apiProvider: "openai",
			openAiApiKey: "test-key",
			openAiModelId: "gpt-5.6",
			openAiWebSearchEnabled: true,
		})
		const legacyResponsesHandler = buildApiHandler({
			apiProvider: "openai-responses",
			openAiApiKey: "test-key",
			openAiModelId: "gpt-5.6",
		})

		expect(defaultHandler).toBeInstanceOf(OpenAiHandler)
		expect(optedOutHandler).toBeInstanceOf(OpenAiHandler)
		expect(optedInHandler).toBeInstanceOf(OpenAiHandler)
		expect(legacyResponsesHandler).toBeInstanceOf(OpenAiCompatibleResponsesHandler)
	})

	it("adds native web search beside function tools without changing the default request", async () => {
		mockResponsesCreate.mockResolvedValue({
			[Symbol.asyncIterator]: async function* () {
				yield { type: "response.output_text.delta", delta: "ok" }
				yield { type: "response.done", response: {} }
			},
		})

		const defaultHandler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "gpt-5.6",
		} satisfies ApiHandlerOptions)
		for await (const _chunk of defaultHandler.createMessage(systemPrompt, messages)) {
		}

		const defaultBody = mockResponsesCreate.mock.calls[0][0]
		expect(defaultBody.instructions).toBe(systemPrompt)
		expect(defaultBody).not.toHaveProperty("tools")
		expect(defaultBody).not.toHaveProperty("tool_choice")
		expect(defaultBody).not.toHaveProperty("include")

		mockResponsesCreate.mockClear()
		const webSearchHandler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "gpt-5.6",
			openAiWebSearchEnabled: true,
		} satisfies ApiHandlerOptions)
		for await (const _chunk of webSearchHandler.createMessage(systemPrompt, messages, {
			taskId: "task-1",
			tools: [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "Read a file",
						parameters: { type: "object", properties: { path: { type: "string" } } },
					},
				},
			],
			toolProtocol: "native",
		})) {
		}

		const webSearchBody = mockResponsesCreate.mock.calls[0][0]
		expect(webSearchBody.tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "function", name: "read_file" }),
				{ type: "web_search", search_context_size: "medium" },
			]),
		)
		expect(webSearchBody.tool_choice).toBe("auto")
		expect(webSearchBody.stream).toBe(true)
		expect(webSearchBody.include).toEqual(["web_search_call.action.sources"])
		expect(webSearchBody.instructions).toContain(systemPrompt)
		expect(webSearchBody.instructions).toContain("Use web search autonomously")

		mockResponsesCreate.mockClear()
		for await (const _chunk of webSearchHandler.createMessage(systemPrompt, messages, {
			taskId: "task-2",
			tool_choice: "none",
		})) {
		}
		expect(mockResponsesCreate.mock.calls[0][0].tool_choice).toBe("none")
	})

	it("runs searchWeb as one forced, search-only Responses request", async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			body: new ReadableStream(),
			json: async () => ({
				status: "completed",
				output: [
					{
						type: "web_search_call",
						action: {
							sources: [{ type: "url", title: "Primary source", url: "https://example.com/source" }],
						},
					},
					{
						type: "message",
						content: [{ type: "output_text", text: "Current answer" }],
					},
				],
				usage: { input_tokens: 12, output_tokens: 4 },
			}),
		})
		global.fetch = mockFetch as any

		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "same-provider-key",
			openAiBaseUrl: "https://prox.example.com/v1",
			openAiModelId: "primary-chat-model",
			openAiWebSearchEnabled: true,
			openAiWebSearchModelId: "dedicated-search-model",
			openAiStreamingEnabled: true,
		} satisfies ApiHandlerOptions)

		const result = await handler.searchWeb("latest relevant fact", "task-search-1")

		expect(result).toMatchObject({
			text: "Current answer",
			sources: [{ title: "Primary source", url: "https://example.com/source" }],
			usage: { type: "usage", inputTokens: 12, outputTokens: 4 },
		})
		expect(mockFetch).toHaveBeenCalledTimes(1)
		const body = JSON.parse(mockFetch.mock.calls[0][1].body)
		expect(body).toMatchObject({
			model: "dedicated-search-model",
			stream: false,
			store: false,
			tool_choice: { type: "web_search" },
		})
		expect(body.tools).toEqual([{ type: "web_search", search_context_size: "medium" }])
		expect(body.input).toEqual([
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "latest relevant fact" }],
			},
		])
	})

	it("uses the dedicated model only for web-search-enabled Responses turns", async () => {
		mockResponsesCreate.mockResolvedValue({
			[Symbol.asyncIterator]: async function* () {
				yield { type: "response.output_text.delta", delta: "ok" }
				yield { type: "response.done", response: {} }
			},
		})

		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "same-provider-key",
			openAiHeaders: { "X-Personal-Proxy": "same-provider-header" },
			openAiModelId: "primary-model",
			openAiWebSearchEnabled: true,
			openAiWebSearchModelId: "gpt-5.6-sol",
		} satisfies ApiHandlerOptions)

		for await (const _chunk of handler.createMessage(systemPrompt, messages)) {
		}

		expect(mockResponsesCreate.mock.calls[0][0].model).toBe("gpt-5.6-sol")
		expect(handler.getModel().id).toBe("primary-model")
		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: "same-provider-key",
				defaultHeaders: { "X-Personal-Proxy": "same-provider-header" },
			}),
		)
	})

	it("keeps the primary model when web search is explicitly disabled", async () => {
		mockResponsesCreate.mockResolvedValue({
			[Symbol.asyncIterator]: async function* () {
				yield { type: "response.output_text.delta", delta: "ok" }
				yield { type: "response.done", response: {} }
			},
		})

		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "primary-model",
			openAiWebSearchEnabled: false,
			openAiWebSearchModelId: "gpt-5.6-sol",
		} satisfies ApiHandlerOptions)

		for await (const _chunk of handler.createMessage(systemPrompt, messages)) {
		}

		const body = mockResponsesCreate.mock.calls[0][0]
		expect(body.model).toBe("primary-model")
		expect(body.tools).toBeUndefined()
	})

	it("defaults web-search Responses turns to the personal GPT model", async () => {
		mockResponsesCreate.mockResolvedValue({
			[Symbol.asyncIterator]: async function* () {
				yield { type: "response.output_text.delta", delta: "ok" }
				yield { type: "response.done", response: {} }
			},
		})

		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "primary-model",
			openAiWebSearchEnabled: true,
		} satisfies ApiHandlerOptions)

		for await (const _chunk of handler.createMessage(systemPrompt, messages)) {
		}

		expect(mockResponsesCreate.mock.calls[0][0].model).toBe("1-gpt-sol")
	})

	it("sends the GPT-5.6 maximum reasoning effort in Responses requests", async () => {
		mockResponsesCreate.mockResolvedValue({
			[Symbol.asyncIterator]: async function* () {
				yield { type: "response.output_text.delta", delta: "ok" }
				yield { type: "response.done", response: {} }
			},
		})

		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "gpt-5.6-sol",
			openAiWebSearchEnabled: true,
			openAiWebSearchModelId: "gpt-5.6-sol",
			enableReasoningEffort: true,
			reasoningEffort: "max",
			openAiCustomModelInfo: {
				contextWindow: 128_000,
				maxTokens: 32_000,
				supportsImages: true,
				supportsPromptCache: true,
			},
		} satisfies ApiHandlerOptions)

		for await (const _chunk of handler.createMessage(systemPrompt, messages)) {
		}

		expect(mockResponsesCreate.mock.calls[0][0].reasoning).toEqual({ summary: "auto", effort: "max" })
	})

	it("does not inherit the primary model temperature for a GPT-5.6 search turn at maximum effort", async () => {
		mockResponsesCreate.mockResolvedValue({
			[Symbol.asyncIterator]: async function* () {
				yield { type: "response.output_text.delta", delta: "ok" }
				yield { type: "response.done", response: {} }
			},
		})

		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "temperature-capable-primary",
			openAiWebSearchEnabled: true,
			openAiWebSearchModelId: "gpt-5.6-sol",
			enableReasoningEffort: true,
			reasoningEffort: "max",
			modelTemperature: 0.7,
			openAiCustomModelInfo: {
				contextWindow: 128_000,
				maxTokens: 32_000,
				supportsImages: true,
				supportsPromptCache: true,
				supportsTemperature: true,
				supportsVerbosity: true,
			},
		} satisfies ApiHandlerOptions)

		for await (const _chunk of handler.createMessage(systemPrompt, messages)) {
		}

		const body = mockResponsesCreate.mock.calls[0][0]
		expect(body.model).toBe("gpt-5.6-sol")
		expect(body.reasoning).toEqual({ summary: "auto", effort: "max" })
		expect(body).not.toHaveProperty("temperature")
	})

	it("does not leak a saved max effort to an older secondary search model", async () => {
		mockResponsesCreate.mockResolvedValue({
			[Symbol.asyncIterator]: async function* () {
				yield { type: "response.output_text.delta", delta: "ok" }
				yield { type: "response.done", response: {} }
			},
		})

		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "gpt-5.6-sol",
			openAiWebSearchEnabled: true,
			openAiWebSearchModelId: "older-model",
			enableReasoningEffort: true,
			reasoningEffort: "max",
			openAiCustomModelInfo: {
				contextWindow: 128_000,
				maxTokens: 32_000,
				supportsImages: true,
				supportsPromptCache: true,
				supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
			},
		} satisfies ApiHandlerOptions)

		for await (const _chunk of handler.createMessage(systemPrompt, messages)) {
		}

		expect(mockResponsesCreate.mock.calls[0][0].model).toBe("older-model")
		expect(mockResponsesCreate.mock.calls[0][0].reasoning).toEqual({ summary: "auto" })
	})

	it("keeps completePrompt on the primary model even when a search model is configured", async () => {
		mockResponsesCreate.mockResolvedValue({
			output: [{ type: "message", content: [{ type: "output_text", text: "primary answer" }] }],
		})

		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "primary-model",
			openAiWebSearchEnabled: true,
			openAiWebSearchModelId: "gpt-5.6-sol",
		} satisfies ApiHandlerOptions)

		await expect(handler.completePrompt("Short utility prompt")).resolves.toBe("primary answer")
		const requestBody = mockResponsesCreate.mock.calls[0][0]
		expect(requestBody.model).toBe("primary-model")
		expect(requestBody.stream).toBe(false)
		expect(requestBody.input).toEqual([
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Short utility prompt" }],
			},
		])
	})

	it("emits deduplicated grounding chunks from annotations and final web search sources", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "gpt-5.6",
			openAiWebSearchEnabled: true,
		} satisfies ApiHandlerOptions)

		mockResponsesCreate.mockResolvedValueOnce({
			[Symbol.asyncIterator]: async function* () {
				yield {
					type: "response.web_search_call.in_progress",
					item_id: "ws_1",
					output_index: 0,
					sequence_number: 1,
				}
				yield {
					type: "response.output_item.done",
					output_index: 0,
					sequence_number: 2,
					item: {
						id: "ws_1",
						type: "web_search_call",
						status: "completed",
						action: {
							type: "search",
							sources: [
								{ type: "url", url: "https://example.com/a" },
								{ type: "url", url: "https://example.com/c" },
							],
						},
					},
				}
				yield { type: "response.output_text.delta", delta: "answer" }
				yield {
					type: "response.output_text.annotation.added",
					annotation_index: 0,
					content_index: 0,
					item_id: "msg_1",
					output_index: 1,
					sequence_number: 3,
					annotation: {
						type: "url_citation",
						start_index: 0,
						end_index: 6,
						url: "https://example.com/a",
						title: "Source A",
					},
				}
				yield {
					type: "response.output_text.annotation.added",
					annotation_index: 1,
					content_index: 0,
					item_id: "msg_1",
					output_index: 1,
					sequence_number: 4,
					annotation: {
						type: "url_citation",
						url_citation: {
							start_index: 0,
							end_index: 6,
							url: "https://example.com/b",
							title: "Source B",
						},
					},
				}
				yield {
					type: "response.output_item.done",
					output_index: 1,
					sequence_number: 5,
					item: {
						id: "msg_1",
						type: "message",
						status: "completed",
						role: "assistant",
						content: [
							{
								type: "output_text",
								text: "answer",
								annotations: [
									{ type: "url_citation", url: "https://example.com/a", title: "Source A" },
									{ type: "url_citation", url: "https://example.com/b", title: "Source B" },
									{ type: "url_citation", url: "javascript:alert(1)", title: "Unsafe" },
								],
							},
						],
					},
				}
				yield {
					type: "response.completed",
					sequence_number: 6,
					response: {
						output: [
							{
								type: "web_search_call",
								action: {
									sources: [
										{ type: "url", url: "https://example.com/a" },
										{ type: "url", url: "https://example.com/c" },
									],
								},
							},
						],
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				}
			},
		})

		const chunks: any[] = []
		for await (const chunk of handler.createMessage(systemPrompt, messages)) chunks.push(chunk)

		const sources = chunks.filter((chunk) => chunk.type === "grounding").flatMap((chunk) => chunk.sources)
		expect(sources).toEqual([
			{ title: "Source A", url: "https://example.com/a" },
			{ title: "Source B", url: "https://example.com/b" },
			{ title: "https://example.com/c", url: "https://example.com/c" },
		])
		expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual(["answer"])
		expect(chunks.filter((chunk) => chunk.type === "usage")).toHaveLength(1)
	})

	// kilocode_change start
	it("keeps a custom web-search gateway on the compatible streaming transport", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://prox.example.com",
			openAiModelId: "1-gpt-sol",
			openAiWebSearchEnabled: true,
		} satisfies ApiHandlerOptions)

		mockResponsesCreate.mockResolvedValue({
			[Symbol.asyncIterator]: async function* () {
				yield { type: "response.output_text.delta", delta: "Fresh answer" }
				yield {
					type: "response.completed",
					response: { usage: { input_tokens: 20, output_tokens: 8 } },
				}
			},
		})
		const mockFetch = vi.fn()
		global.fetch = mockFetch as any

		const chunks: any[] = []
		for await (const chunk of handler.createMessage(systemPrompt, messages)) chunks.push(chunk)

		expect(mockResponsesCreate).toHaveBeenCalledTimes(1)
		expect(mockFetch).not.toHaveBeenCalled()
		const requestBody = mockResponsesCreate.mock.calls[0][0]
		expect(requestBody.stream).toBe(true)
		expect(requestBody.max_output_tokens).toBe(65_536)
		expect(requestBody.include).toEqual(["web_search_call.action.sources"])
		expect(requestBody.tools).toContainEqual({ type: "web_search", search_context_size: "medium" })
		expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual(["Fresh answer"])
		expect(chunks.filter((chunk) => chunk.type === "usage")).toHaveLength(1)
	})

	it("does not replay an empty completed stream from a custom web-search gateway", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://prox.example.com",
			openAiModelId: "1-gpt-sol",
			openAiWebSearchEnabled: true,
		} satisfies ApiHandlerOptions)

		mockResponsesCreate.mockResolvedValue({
			[Symbol.asyncIterator]: async function* () {
				yield {
					type: "response.completed",
					response: { output: [{ type: "web_search_call", status: "completed" }] },
				}
			},
		})

		await expect(async () => {
			for await (const _chunk of handler.createMessage(systemPrompt, messages)) {
			}
		}).rejects.toBeInstanceOf(NonRetryableApiError)
		expect(mockResponsesCreate).toHaveBeenCalledTimes(1)
	})
	// kilocode_change end

	it("exposes the exact Responses output reserve to Task context management", () => {
		const automaticHandler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://prox.example.com",
			openAiModelId: "1-gpt-sol",
			openAiWebSearchEnabled: true,
			openAiCustomModelInfo: {
				contextWindow: 400_000,
				maxTokens: -1,
				supportsImages: true,
				supportsPromptCache: true,
			},
		} satisfies ApiHandlerOptions)
		const explicitHandler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://prox.example.com",
			openAiModelId: "1-gpt-sol",
			openAiWebSearchEnabled: true,
			includeMaxTokens: true,
			openAiCustomModelInfo: {
				contextWindow: 400_000,
				maxTokens: 8_192,
				supportsImages: true,
				supportsPromptCache: true,
			},
		} satisfies ApiHandlerOptions)
		const searchDisabledHandler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "1-gpt-sol",
			openAiWebSearchEnabled: false,
		} satisfies ApiHandlerOptions)

		expect(automaticHandler.contextManagementMaxOutputTokens).toBe(65_536)
		expect(explicitHandler.contextManagementMaxOutputTokens).toBe(8_192)
		expect(searchDisabledHandler.contextManagementMaxOutputTokens).toBeUndefined()
	})

	it("retries an output-limited web-search response once before showing an error", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://prox.example.com",
			openAiModelId: "primary-model",
			openAiWebSearchEnabled: true,
			openAiWebSearchModelId: "1-gpt-sol",
			openAiStreamingEnabled: false,
			enableReasoningEffort: true,
			reasoningEffort: "xhigh",
		} satisfies ApiHandlerOptions)

		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				body: new ReadableStream(),
				json: async () => ({
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
					output: [
						{ type: "reasoning", summary: [{ type: "summary_text", text: "Still working" }] },
						{ type: "web_search_call", status: "completed" },
					],
					usage: { input_tokens: 100, output_tokens: 65_536 },
				}),
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				body: new ReadableStream(),
				json: async () => ({
					status: "completed",
					output: [
						{
							type: "message",
							content: [{ type: "output_text", text: "Answer after the safe retry" }],
						},
					],
					usage: { input_tokens: 100, output_tokens: 500 },
				}),
			})
		global.fetch = mockFetch as any

		const chunks: any[] = []
		for await (const chunk of handler.createMessage(systemPrompt, messages)) chunks.push(chunk)

		expect(mockFetch).toHaveBeenCalledTimes(2)
		expect(JSON.parse(mockFetch.mock.calls[0][1].body).max_output_tokens).toBe(65_536)
		expect(JSON.parse(mockFetch.mock.calls[1][1].body).max_output_tokens).toBe(98_304)
		expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual([
			"Answer after the safe retry",
		])
		expect(chunks.filter((chunk) => chunk.type === "reasoning")).toHaveLength(0)
		expect(chunks.filter((chunk) => chunk.type === "usage")).toHaveLength(2)
	})

	it("never retries an output-limited response after an actionable tool call", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://prox.example.com",
			openAiModelId: "1-gpt-sol",
			openAiWebSearchEnabled: true,
			openAiStreamingEnabled: false,
		} satisfies ApiHandlerOptions)

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			body: new ReadableStream(),
			json: async () => ({
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
				output: [
					{
						type: "function_call",
						call_id: "call_once",
						name: "write_file",
						arguments: '{"path":"result.txt"}',
					},
				],
			}),
		})
		global.fetch = mockFetch as any

		const chunks: any[] = []
		for await (const chunk of handler.createMessage(systemPrompt, messages)) chunks.push(chunk)

		expect(mockFetch).toHaveBeenCalledTimes(1)
		expect(chunks).toContainEqual({
			type: "tool_call",
			id: "call_once",
			name: "write_file",
			arguments: '{"path":"result.txt"}',
		})
	})

	it.each(["computer_call", "future_gateway_item"])(
		"never retries an output-limited response containing %s",
		async (itemType) => {
			const handler = new OpenAiCompatibleResponsesHandler({
				openAiApiKey: "test-key",
				openAiBaseUrl: "https://prox.example.com",
				openAiModelId: "1-gpt-sol",
				openAiWebSearchEnabled: true,
				openAiStreamingEnabled: false,
			} satisfies ApiHandlerOptions)

			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				body: new ReadableStream(),
				json: async () => ({
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
					output: [{ type: itemType }],
				}),
			})
			global.fetch = mockFetch as any

			await expect(async () => {
				for await (const _chunk of handler.createMessage(systemPrompt, messages)) {
				}
			}).rejects.toBeInstanceOf(NonRetryableApiError)
			expect(mockFetch).toHaveBeenCalledTimes(1)
		},
	)

	it("stops after one retry when the larger web-search budget is also exhausted", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://prox.example.com",
			openAiModelId: "1-gpt-sol",
			openAiWebSearchEnabled: true,
			openAiStreamingEnabled: false,
		} satisfies ApiHandlerOptions)

		const createIncompleteResponse = (outputTokens: number) => ({
			ok: true,
			status: 200,
			body: new ReadableStream(),
			json: async () => ({
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
				output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "Still working" }] }],
				usage: { input_tokens: 100, output_tokens: outputTokens },
			}),
		})
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(createIncompleteResponse(65_536))
			.mockResolvedValueOnce(createIncompleteResponse(98_304))
		global.fetch = mockFetch as any

		await expect(async () => {
			for await (const _chunk of handler.createMessage(systemPrompt, messages)) {
			}
		}).rejects.toMatchObject({
			name: "NonRetryableApiError",
			message: expect.stringMatching(
				/max_output_tokens.*single safe retry with max_output_tokens=98304 was attempted/i,
			),
		})
		expect(mockFetch).toHaveBeenCalledTimes(2)
	})

	it("respects an explicit user output limit instead of retrying past it", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://prox.example.com",
			openAiModelId: "1-gpt-sol",
			openAiWebSearchEnabled: true,
			openAiStreamingEnabled: false,
			includeMaxTokens: true,
			openAiCustomModelInfo: {
				contextWindow: 128_000,
				maxTokens: 8_192,
				supportsImages: true,
				supportsPromptCache: true,
			},
		} satisfies ApiHandlerOptions)

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			body: new ReadableStream(),
			json: async () => ({
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
				output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "Still working" }] }],
			}),
		})
		global.fetch = mockFetch as any

		await expect(async () => {
			for await (const _chunk of handler.createMessage(systemPrompt, messages)) {
			}
		}).rejects.toBeInstanceOf(NonRetryableApiError)
		expect(mockFetch).toHaveBeenCalledTimes(1)
		expect(JSON.parse(mockFetch.mock.calls[0][1].body).max_output_tokens).toBe(8_192)
	})

	it("shows a completed refusal as the assistant response", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://prox.example.com",
			openAiModelId: "1-gpt-sol",
			openAiWebSearchEnabled: true,
			openAiStreamingEnabled: false,
		} satisfies ApiHandlerOptions)

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			body: new ReadableStream(),
			json: async () => ({
				status: "completed",
				output: [
					{
						type: "message",
						content: [{ type: "refusal", refusal: "I cannot help with that request." }],
					},
				],
			}),
		}) as any

		const chunks: any[] = []
		for await (const chunk of handler.createMessage(systemPrompt, messages)) chunks.push(chunk)

		expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual([
			"I cannot help with that request.",
		])
	})

	it("emits a function call from a completed non-streaming response", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://prox.example.com",
			openAiModelId: "1-gpt-sol",
			openAiWebSearchEnabled: true,
			openAiStreamingEnabled: false,
		} satisfies ApiHandlerOptions)

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			body: new ReadableStream(),
			json: async () => ({
				status: "completed",
				output: [
					{
						type: "function_call",
						call_id: "call_1",
						name: "read_file",
						arguments: '{"path":"README.md"}',
					},
				],
			}),
		}) as any

		const chunks: any[] = []
		for await (const chunk of handler.createMessage(systemPrompt, messages)) chunks.push(chunk)

		expect(chunks).toContainEqual({
			type: "tool_call",
			id: "call_1",
			name: "read_file",
			arguments: '{"path":"README.md"}',
		})
	})

	// kilocode_change start
	it("marks a completed empty non-streaming web-search response as non-retryable", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://prox.example.com",
			openAiModelId: "1-gpt-sol",
			openAiWebSearchEnabled: true,
			openAiStreamingEnabled: false,
		} satisfies ApiHandlerOptions)

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			body: new ReadableStream(),
			json: async () => ({
				status: "completed",
				output: [{ type: "web_search_call", status: "completed" }],
				usage: { input_tokens: 10, output_tokens: 0 },
			}),
		})
		global.fetch = mockFetch as any

		await expect(async () => {
			for await (const _chunk of handler.createMessage(systemPrompt, messages)) {
			}
		}).rejects.toBeInstanceOf(NonRetryableApiError)
		expect(mockFetch).toHaveBeenCalledTimes(1)
	})
	// kilocode_change end

	it.each([
		[401, "Authentication failed"],
		[403, "Access denied"],
	])("does not automatically replay a custom web-search HTTP %i response", async (status, message) => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://prox.example.com",
			openAiModelId: "1-gpt-sol",
			openAiWebSearchEnabled: true,
			openAiStreamingEnabled: false,
		} satisfies ApiHandlerOptions)

		const mockFetch = vi.fn().mockResolvedValue({
			ok: false,
			status,
			text: async () => "provider rejected the request",
		})
		global.fetch = mockFetch as any

		await expect(async () => {
			for await (const _chunk of handler.createMessage(systemPrompt, messages)) {
			}
		}).rejects.toMatchObject({
			name: "NonRetryableApiError",
			message: expect.stringContaining(message),
		})
		expect(mockFetch).toHaveBeenCalledTimes(1)
	})

	it("normalizes nested Responses cache usage", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "gpt-5.6",
			openAiCustomModelInfo: {
				contextWindow: 128_000,
				maxTokens: 16_384,
				supportsImages: true,
				supportsPromptCache: false,
			},
		} satisfies ApiHandlerOptions)

		mockResponsesCreate.mockResolvedValueOnce({
			[Symbol.asyncIterator]: async function* () {
				yield { type: "response.output_text.delta", delta: "ok" }
				yield {
					type: "response.done",
					response: {
						usage: {
							input_tokens: 100,
							output_tokens: 10,
							input_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 },
						},
					},
				}
			},
		})

		const chunks: any[] = []
		for await (const chunk of handler.createMessage(systemPrompt, messages)) chunks.push(chunk)

		expect(chunks.find((chunk) => chunk.type === "usage")).toMatchObject({
			inputTokens: 100,
			outputTokens: 10,
			cacheReadTokens: 80,
			cacheWriteTokens: 20,
		})
		expect(handler.getModel().info.supportsPromptCache).toBe(true)
	})

	it("finishes on response.completed even when a compatible SSE stream never closes", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "gpt-5.6",
		} satisfies ApiHandlerOptions)

		mockResponsesCreate.mockResolvedValueOnce({
			[Symbol.asyncIterator]: async function* () {
				yield { type: "response.output_text.delta", delta: "done" }
				yield {
					type: "response.completed",
					response: { usage: { input_tokens: 1, output_tokens: 1 } },
				}
				await new Promise(() => {})
			},
		})

		const chunks: any[] = []
		for await (const chunk of handler.createMessage(systemPrompt, messages)) chunks.push(chunk)

		expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual(["done"])
		expect(chunks.filter((chunk) => chunk.type === "usage")).toHaveLength(1)
	})

	it("reads a completed message when a compatible stream omits text delta events", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "gpt-5.6",
			openAiWebSearchEnabled: true,
			openAiStreamingEnabled: true,
		} satisfies ApiHandlerOptions)

		mockResponsesCreate.mockResolvedValueOnce({
			[Symbol.asyncIterator]: async function* () {
				yield {
					type: "response.output_item.done",
					item: {
						type: "message",
						content: [{ type: "output_text", text: "Answer returned as a complete message" }],
					},
				}
				yield {
					type: "response.completed",
					response: {
						output: [
							{
								type: "message",
								content: [{ type: "output_text", text: "Answer returned as a complete message" }],
							},
						],
						usage: { input_tokens: 2, output_tokens: 3 },
					},
				}
			},
		})

		const chunks: any[] = []
		for await (const chunk of handler.createMessage(systemPrompt, messages)) chunks.push(chunk)

		expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual([
			"Answer returned as a complete message",
		])
		expect(chunks.filter((chunk) => chunk.type === "usage")).toHaveLength(1)
	})

	it("surfaces terminal Responses stream errors without replaying the request", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiModelId: "gpt-5.6",
		} satisfies ApiHandlerOptions)

		mockResponsesCreate.mockResolvedValueOnce({
			[Symbol.asyncIterator]: async function* () {
				yield { type: "error", error: { message: "upstream stream failed" } }
			},
		})
		const mockFetch = vi.fn()
		global.fetch = mockFetch as any

		await expect(async () => {
			for await (const _chunk of handler.createMessage(systemPrompt, messages)) {
			}
		}).rejects.toThrow("upstream stream failed")
		expect(mockResponsesCreate).toHaveBeenCalledTimes(1)
		expect(mockFetch).not.toHaveBeenCalled()
	})

	it("streams responses via fetch fallback", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://api.example.com",
			openAiModelId: "gpt-4o",
		} satisfies ApiHandlerOptions)

		const mockFetch = vi.fn().mockResolvedValue(createMockSseResponse())
		global.fetch = mockFetch as any

		mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

		const stream = handler.createMessage(systemPrompt, messages)
		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		expect(chunks.filter((chunk) => chunk.type === "text").map((c) => c.text)).toEqual(["Hello", " world"])
		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.example.com/v1/responses",
			expect.objectContaining({
				method: "POST",
			}),
		)
	})

	it("normalizes fallback URL without duplicating /v1", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://api.example.com/v1",
			openAiModelId: "gpt-4o",
		} satisfies ApiHandlerOptions)

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
					controller.close()
				},
			}),
		})
		global.fetch = mockFetch as any
		mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

		const stream = handler.createMessage(systemPrompt, messages)
		for await (const _chunk of stream) {
		}

		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.example.com/v1/responses",
			expect.objectContaining({
				method: "POST",
			}),
		)
	})

	it("rejects Azure AI Inference endpoints for Responses API", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://myresource.services.ai.azure.com/models",
			openAiModelId: "gpt-5.2-codex",
		} satisfies ApiHandlerOptions)

		const stream = handler.createMessage(systemPrompt, messages)

		await expect(async () => {
			for await (const _chunk of stream) {
			}
		}).rejects.toThrow("Azure AI Inference endpoints")

		await expect(handler.completePrompt("Test prompt")).rejects.toThrow("Azure AI Inference endpoints")
	})

	it("explains how to recover when web search is unsupported by the endpoint", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://api.example.com/v1",
			openAiModelId: "gpt-5.6",
			openAiWebSearchEnabled: true,
		} satisfies ApiHandlerOptions)

		mockResponsesCreate.mockRejectedValueOnce(new Error("Unsupported tool type"))
		global.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 400,
			text: async () => "Unsupported tool type: web_search",
		}) as any

		await expect(async () => {
			for await (const _chunk of handler.createMessage(systemPrompt, messages)) {
			}
		}).rejects.toThrow("This endpoint or model does not support the OpenAI Responses API built-in web_search tool")
		expect(global.fetch).not.toHaveBeenCalled()
	})

	it("does not pass chat-completions path override for Azure OpenAI Responses calls", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://myresource.openai.azure.com/openai/v1",
			openAiUseAzure: true,
			openAiModelId: "my-deployment",
		} satisfies ApiHandlerOptions)

		mockResponsesCreate.mockResolvedValueOnce({
			[Symbol.asyncIterator]: async function* () {
				yield { type: "response.text.delta", delta: "hello" }
				yield {
					type: "response.done",
					response: {
						usage: {
							prompt_tokens: 1,
							completion_tokens: 1,
						},
					},
				}
			},
		})

		const stream = handler.createMessage(systemPrompt, messages)
		for await (const _chunk of stream) {
		}

		expect(mockResponsesCreate).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				signal: expect.any(AbortSignal),
			}),
		)
		const options = mockResponsesCreate.mock.calls[0][1]
		expect(options.path).toBeUndefined()
	})

	it("uses Azure fallback auth and normalizes Azure deployment chat URL to /openai/v1/responses without api-version", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl:
				"https://myresource.openai.azure.com/openai/deployments/my-deployment/chat/completions?api-version=2024-05-01-preview",
			openAiUseAzure: true,
			azureApiVersion: "2024-08-01-preview",
			openAiModelId: "my-deployment",
		} satisfies ApiHandlerOptions)

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
					controller.close()
				},
			}),
		})
		global.fetch = mockFetch as any
		mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

		const stream = handler.createMessage(systemPrompt, messages)
		for await (const _chunk of stream) {
		}

		expect(mockFetch).toHaveBeenCalledTimes(1)
		const [requestUrl, requestOptions] = mockFetch.mock.calls[0]
		expect(requestUrl).toBe("https://myresource.openai.azure.com/openai/v1/responses")
		expect(requestUrl).not.toContain("api-version=")
		expect(requestOptions.headers["api-key"]).toBe("test-key")
		expect(requestOptions.headers.Authorization).toBeUndefined()
	})

	it("normalizes cognitiveservices Azure endpoint to /openai/v1/responses without api-version", async () => {
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiApiKey: "test-key",
			openAiBaseUrl: "https://myresource.cognitiveservices.azure.com",
			openAiUseAzure: true,
			azureApiVersion: "2024-08-01-preview",
			openAiModelId: "my-deployment",
		} satisfies ApiHandlerOptions)

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
					controller.close()
				},
			}),
		})
		global.fetch = mockFetch as any
		mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

		const stream = handler.createMessage(systemPrompt, messages)
		for await (const _chunk of stream) {
		}

		expect(mockFetch).toHaveBeenCalledTimes(1)
		const [requestUrl, requestOptions] = mockFetch.mock.calls[0]
		expect(requestUrl).toBe("https://myresource.cognitiveservices.azure.com/openai/v1/responses")
		expect(requestUrl).not.toContain("api-version=")
		expect(requestOptions.headers["api-key"]).toBe("test-key")
		expect(requestOptions.headers.Authorization).toBeUndefined()
	})
})
