// kilocode_change - new file
import { claudeCodeDefaultModelId, type ProviderSettings } from "@roo-code/types"

import { buildApiHandler } from "../../../api"
import type { ApiStream, ApiStreamChunk } from "../../../api/transform/stream"
import { runProviderConnectionTest } from ".."

vi.mock("../../../api", () => ({ buildApiHandler: vi.fn() }))

const configuration: ProviderSettings = {
	apiProvider: "openai",
	openAiBaseUrl: "https://test.example/v1",
	openAiApiKey: "private-api-key-do-not-print",
	openAiModelId: "selected-model",
	openAiWebSearchEnabled: true,
	openAiWebSearchModelId: "different-search-model",
	openAiHeaders: { "X-Custom-Header": "private-header-do-not-print" },
	allowInsecureTls: true,
	reasoningEffort: "high",
	modelMaxTokens: 16_384,
	openAiStreamingEnabled: false,
}

function options(signal = new AbortController().signal) {
	return { requestId: "check-123456", signal, extensionVersion: "5.16.239", vscodeVersion: "1.105.0" }
}

function mockHandler(chunks: ApiStreamChunk[] = [{ type: "text", text: "IVOL_CONNECTION_OK" }], id = "selected-model") {
	const createMessage = vi.fn(async function* (): ApiStream {
		for (const chunk of chunks) yield chunk
	})
	const handler = { createMessage, getModel: vi.fn(() => ({ id, info: {} })), countTokens: vi.fn() }
	vi.mocked(buildApiHandler).mockReturnValue(handler as unknown as ReturnType<typeof buildApiHandler>)
	return handler
}

function mockError(error: unknown) {
	const handler = mockHandler()
	handler.createMessage.mockImplementation(async function* (): ApiStream {
		yield* []
		throw error
	})
	return handler
}

describe("runProviderConnectionTest", () => {
	beforeEach(() => vi.clearAllMocks())
	afterEach(() => vi.useRealTimers())

	it("tests exactly the configured generation adapter with a detached draft and no task context", async () => {
		const handler = mockHandler()
		const draft = structuredClone(configuration)
		const original = structuredClone(draft)
		const result = await runProviderConnectionTest(draft, options())
		expect(result.status).toBe("success")
		expect(result.category).toBe("success")
		expect(result.requestId).toBe("check-123456")
		expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
		expect(draft).toEqual(original)
		expect(buildApiHandler).toHaveBeenCalledWith(
			{ ...original, openAiWebSearchEnabled: false, enableGrounding: false, enableUrlContext: false },
			{ connectionTest: true },
		)
		const snapshot = vi.mocked(buildApiHandler).mock.calls[0][0]
		expect(snapshot).not.toBe(draft)
		expect(snapshot.openAiHeaders).not.toBe(draft.openAiHeaders)
		expect(handler.createMessage).toHaveBeenCalledWith(
			"",
			[{ role: "user", content: "Reply with IVOL_CONNECTION_OK only." }],
			expect.objectContaining({
				tools: [],
				tool_choice: "none",
				allowedFunctionNames: [],
				forceWebSearch: false,
				store: false,
				suppressPreviousResponseId: true,
				signal: expect.any(AbortSignal),
			}),
		)
		expect(result.report).toContain("Extension: 5.16.239")
		expect(result.report).toContain("Protocol: OpenAI Chat Completions")
		expect(result.report).toContain("Profile allowInsecureTls: true")
		expect(result.report).toContain("Web search is disabled for this check only")
		expect(result.report).toContain("HTTP status: unavailable")
		expect(result.report).not.toContain("200")
		expect(result.report).not.toContain("IVOL_CONNECTION_OK")
		expect(result.report).not.toContain(configuration.openAiApiKey)
		expect(result.report).not.toContain(configuration.openAiHeaders!["X-Custom-Header"])
	})

	it.each([
		{ apiProvider: "openai-codex", apiModelId: "selected-model" },
		{ apiProvider: "claude-code", apiModelId: claudeCodeDefaultModelId },
		{ apiProvider: "ollama", ollamaModelId: "selected-model" },
		{ apiProvider: "lmstudio", lmStudioModelId: "selected-model" },
	] satisfies ProviderSettings[])(
		"supports $apiProvider using its own selected model and authentication",
		async (draft) => {
			mockHandler(undefined, draft.apiProvider === "claude-code" ? claudeCodeDefaultModelId : "selected-model")
			const result = await runProviderConnectionTest(draft, options())
			expect(result.status).toBe("success")
			expect(vi.mocked(buildApiHandler).mock.calls[0][0]).toMatchObject(draft)
		},
	)

	it.each([
		[{}, "unsupported_provider"],
		[{ apiProvider: "openrouter", apiModelId: "ignored" }, "unsupported_provider"],
		[{ apiProvider: "virtual-quota-fallback" }, "unsupported_provider"],
		[{ ...configuration, openAiModelId: "   " }, "missing_model"],
		[{ ...configuration, openAiApiKey: "", openAiHeaders: {} }, "missing_key"],
		[{ ...configuration, openAiBaseUrl: "file:///private/secret" }, "invalid_endpoint"],
		[{ ...configuration, openAiBaseUrl: "invalid-private-endpoint" }, "invalid_endpoint"],
	] as [ProviderSettings, string][])("does not send a request for invalid profile %#", async (draft, category) => {
		mockHandler()
		const result = await runProviderConnectionTest(draft, options())
		expect(result.status).toBe("error")
		expect(result.category).toBe(category)
		expect(buildApiHandler).not.toHaveBeenCalled()
		expect(result.report).not.toContain("invalid-private-endpoint")
		expect(result.report).not.toContain("/private/secret")
	})

	it("accepts an explicitly configured authentication header without requiring a duplicate API key", async () => {
		mockHandler()
		const result = await runProviderConnectionTest(
			{ ...configuration, openAiApiKey: "", openAiHeaders: { Authorization: "Bearer private-header-token" } },
			options(),
		)
		expect(result.status).toBe("success")
		expect(result.report).not.toContain("private-header-token")
	})

	it("refuses an adapter default model fallback before generating", async () => {
		const handler = mockHandler(undefined, "default-model")
		const result = await runProviderConnectionTest(
			{ apiProvider: "openai-codex", apiModelId: "unknown-selected-model" },
			options(),
		)
		expect(result.category).toBe("invalid_model")
		expect(handler.createMessage).not.toHaveBeenCalled()
	})

	it("refuses an unknown Claude model that would fall back inside its streaming method", async () => {
		const handler = mockHandler(undefined, "unknown-claude-model")
		const result = await runProviderConnectionTest(
			{ apiProvider: "claude-code", apiModelId: "unknown-claude-model" },
			options(),
		)
		expect(result.category).toBe("invalid_model")
		expect(handler.createMessage).not.toHaveBeenCalled()
	})

	it.each(
		[
			[],
			[{ type: "usage", inputTokens: 10, outputTokens: 10 }],
			[{ type: "reasoning", text: "reasoning-only-do-not-print" }],
			[{ type: "text", text: " \n\t" }],
			[{ type: "tool_call", id: "tool-id", name: "web_search", arguments: "{}" }],
		].map((chunks) => ({ chunks: chunks as ApiStreamChunk[] })),
	)("does not mistake empty/reasoning/usage/tool output for generation %#", async ({ chunks }) => {
		mockHandler(chunks)
		const result = await runProviderConnectionTest(configuration, options())
		expect(result.status).toBe("error")
		expect(result.category).toBe("empty_response")
		expect(result.report).not.toContain("reasoning-only-do-not-print")
	})

	it("requires nonempty final text, without requiring exact prompt obedience", async () => {
		mockHandler([
			{ type: "reasoning", text: "private thoughts" },
			{ type: "text", text: "Any actual final text" },
		])
		const result = await runProviderConnectionTest(configuration, options())
		expect(result.status).toBe("success")
		expect(result.report).not.toContain("private thoughts")
		expect(result.report).not.toContain("Any actual final text")
	})

	it.each([401, 403, 404, 429, 500, 502, 503])(
		"classifies actual HTTP %s, preserving safe support identifiers",
		async (status) => {
			mockError({
				response: { status, data: { error: { code: "model_not_found", request_id: "req_safe12345" } } },
			})
			const result = await runProviderConnectionTest(configuration, options())
			const categories: Record<number, string> = {
				401: "authentication",
				403: "permission",
				404: "not_found",
				429: "rate_limit",
				500: "server_error",
				502: "server_error",
				503: "server_error",
			}
			expect(result.category).toBe(categories[status])
			expect(result.report).toContain(`HTTP status: ${status}`)
			expect(result.report).toContain("Provider request ID: req_safe12345")
			expect(result.report).toContain("Error code: model_not_found")
		},
	)

	it.each([
		["ENOTFOUND", "dns"],
		["EAI_AGAIN", "dns"],
		["CERT_HAS_EXPIRED", "tls"],
		["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
		["ECONNRESET", "connection"],
		["ECONNREFUSED", "connection"],
		["ETIMEDOUT", "timeout"],
	] as const)("classifies nested %s without claiming a particular network component", async (code, category) => {
		mockError({ cause: { cause: { code } } })
		const result = await runProviderConnectionTest(configuration, options())
		expect(result.category).toBe(category)
		expect(result.report).toContain(`Error code: ${code}`)
		expect(result.report).toContain("HTTP status: unavailable")
	})

	it("does not fabricate HTTP status from arbitrary error prose", async () => {
		mockError(new Error("private account has code 401 and job 503; unauthorized"))
		const result = await runProviderConnectionTest(configuration, options())
		expect(result.category).toBe("authentication")
		expect(result.report).toContain("HTTP status: unavailable")
		expect(result.report).not.toContain("private account")
	})

	it("treats an error stream chunk as failure even after text arrived", async () => {
		mockHandler([
			{ type: "text", text: "partial" },
			{ type: "error", error: "server_error", message: "private server payload" },
		])
		const result = await runProviderConnectionTest(configuration, options())
		expect(result.status).toBe("error")
		expect(result.report).not.toContain("private server payload")
	})

	it("cancels before creating any provider when already aborted", async () => {
		const controller = new AbortController()
		controller.abort("private cancel reason")
		const result = await runProviderConnectionTest(configuration, options(controller.signal))
		expect(result.status).toBe("cancelled")
		expect(buildApiHandler).not.toHaveBeenCalled()
		expect(result.report).not.toContain("private cancel reason")
	})

	it.each(["cancel", "timeout"] as const)(
		"settles %s even when next() and return() ignore cancellation forever",
		async (kind) => {
			vi.useFakeTimers()
			const controller = new AbortController()
			const handler = mockHandler()
			const next = vi.fn(() => new Promise<IteratorResult<ApiStreamChunk>>(() => undefined))
			const cleanup = vi.fn(() => new Promise<IteratorResult<ApiStreamChunk>>(() => undefined))
			handler.createMessage.mockReturnValue({
				next,
				return: cleanup,
				[Symbol.asyncIterator]() {
					return this
				},
			} as unknown as ApiStream)
			const promise = runProviderConnectionTest(configuration, { ...options(controller.signal), timeoutMs: 20 })
			if (kind === "cancel") controller.abort("private cancellation")
			else await vi.advanceTimersByTimeAsync(21)
			const result = await promise
			expect(result.category).toBe(kind === "cancel" ? "cancelled" : "timeout")
			expect(cleanup).toHaveBeenCalledTimes(1)
			expect(vi.getTimerCount()).toBe(0)
			expect(result.report).toContain("Upstream cancellation")
			expect(result.report).toContain("not confirmed")
			expect(result.report).not.toContain("private cancellation")
		},
	)

	it("handles a late rejected next() and return() after the deadline without leaking errors", async () => {
		vi.useFakeTimers()
		const handler = mockHandler()
		let rejectNext!: (error: unknown) => void
		const cleanup = vi.fn(() => Promise.reject(new Error("private cleanup error")))
		handler.createMessage.mockReturnValue({
			next: () =>
				new Promise((_resolve, reject) => {
					rejectNext = reject
				}),
			return: cleanup,
			[Symbol.asyncIterator]() {
				return this
			},
		} as unknown as ApiStream)
		const pending = runProviderConnectionTest(configuration, { ...options(), timeoutMs: 5 })
		await vi.advanceTimersByTimeAsync(6)
		expect((await pending).category).toBe("timeout")
		rejectNext(new Error("private late error"))
		await vi.advanceTimersByTimeAsync(1)
		expect(cleanup).toHaveBeenCalledTimes(1)
	})

	it.each(["text", "reasoning"] as const)(
		"bounds %s output and reports whether final text was established",
		async (type) => {
			const handler = mockHandler([
				{ type, text: "a".repeat(8192) },
				{ type: "text", text: "must never read" },
			])
			const cleanup = vi.fn()
			const generator = handler.createMessage()
			const originalReturn = generator.return.bind(generator)
			generator.return = (value) => {
				cleanup()
				return originalReturn(value)
			}
			handler.createMessage.mockReturnValue(generator)
			const result = await runProviderConnectionTest(configuration, options())
			expect(result.status).toBe(type === "text" ? "success" : "error")
			expect(result.category).toBe(type === "text" ? "output_limit_success" : "output_limit")
			expect(cleanup).toHaveBeenCalledTimes(1)
			expect(result.report).not.toContain("must never read")
			expect(Buffer.byteLength(result.report)).toBeLessThanOrEqual(8192)
		},
	)

	it("does not let rapidly yielded usage chunks starve its deadline", async () => {
		const handler = mockHandler()
		handler.createMessage.mockImplementation(async function* (): ApiStream {
			while (true) yield { type: "usage", inputTokens: 0, outputTokens: 0 }
		})
		const result = await runProviderConnectionTest(configuration, { ...options(), timeoutMs: 2 })
		expect(result.category).toBe("timeout")
	})
})
