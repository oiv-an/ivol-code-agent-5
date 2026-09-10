// kilocode_change - new file
import OpenAI from "openai"
import { Ollama } from "ollama"
import { OpenAiHandler } from "../openai"
import { OpenAiCodexHandler } from "../openai-codex"
import { LmStudioHandler } from "../lm-studio"
import { NativeOllamaHandler } from "../native-ollama"
import { ClaudeCodeHandler } from "../claude-code"
import { getOllamaModels } from "../fetchers/ollama"
import { createStreamingMessage } from "../../../integrations/claude-code/streaming-client"
import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"
import { claudeCodeOAuthManager } from "../../../integrations/claude-code/oauth"
import { countTokens } from "../../../utils/countTokens"
import { NativeToolCallParser } from "../../../core/assistant-message/NativeToolCallParser"
import type { ApiHandler } from "../../index"
import type { ProviderSettings } from "@roo-code/types"

const mocks = vi.hoisted(() => ({
	chat: vi.fn(),
	responses: vi.fn(),
	ollamaChat: vi.fn(),
	refresh: vi.fn(),
}))

vi.mock("openai", () => {
	const Client = vi.fn().mockImplementation(() => ({
		chat: { completions: { create: mocks.chat } },
		responses: { create: mocks.responses },
	}))
	return { default: Client, AzureOpenAI: Client }
})
vi.mock("ollama", () => ({ Ollama: vi.fn().mockImplementation(() => ({ chat: mocks.ollamaChat })) }))
vi.mock("../fetchers/ollama", () => ({ getOllamaModels: vi.fn().mockResolvedValue({}) }))
vi.mock("../fetchers/modelCache", () => ({ getModelsFromCache: vi.fn() }))
vi.mock("../../../utils/countTokens", () => ({ countTokens: vi.fn().mockResolvedValue(1) }))
vi.mock("../../../integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: {
		getAccessToken: vi.fn().mockResolvedValue("test-oauth-token"),
		getAccountId: vi.fn().mockResolvedValue(null),
		forceRefreshAccessToken: mocks.refresh,
	},
}))
vi.mock("../../../integrations/claude-code/oauth", () => ({
	claudeCodeOAuthManager: {
		getAccessToken: vi.fn().mockResolvedValue("test-claude-token"),
		getEmail: vi.fn().mockResolvedValue(null),
		forceRefreshAccessToken: mocks.refresh,
	},
	generateUserId: vi.fn().mockReturnValue("test-user"),
}))
vi.mock("../../../integrations/claude-code/streaming-client", () => ({ createStreamingMessage: vi.fn() }))

const messages = [{ role: "user" as const, content: "Reply OK." }]
async function consume(handler: ApiHandler, signal?: AbortSignal) {
	const chunks = []
	for await (const chunk of handler.createMessage("Connection check.", messages, {
		taskId: "connection-check",
		signal,
		tools: [],
		tool_choice: "none",
	})) {
		chunks.push(chunk)
	}
	return chunks
}

describe("request-local provider connection test transport", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		vi.mocked(OpenAI).mockImplementation(
			() =>
				({
					chat: { completions: { create: mocks.chat } },
					responses: { create: mocks.responses },
				}) as unknown as OpenAI,
		)
		vi.mocked(Ollama).mockImplementation(() => ({ chat: mocks.ollamaChat }) as unknown as Ollama)
		vi.mocked(openAiCodexOAuthManager.getAccessToken).mockResolvedValue("test-oauth-token")
		vi.mocked(openAiCodexOAuthManager.getAccountId).mockResolvedValue(null)
		vi.mocked(claudeCodeOAuthManager.getAccessToken).mockResolvedValue("test-claude-token")
		vi.mocked(claudeCodeOAuthManager.getEmail).mockResolvedValue(null)
		vi.mocked(countTokens).mockResolvedValue(1)
	})
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it.each(["openai", "lmstudio"])(
		"%s forwards cancellation, disables retries and preserves safe-report error metadata",
		async (provider) => {
			const handler =
				provider === "openai"
					? new OpenAiHandler({
							connectionTest: true,
							openAiModelId: "test-model",
							openAiWebSearchEnabled: false,
						})
					: new LmStudioHandler({ connectionTest: true, lmStudioModelId: "test-model" })
			const controller = new AbortController()
			const failure = Object.assign(new Error("server echoed secret"), { status: 429, request_id: "req_test" })
			const logger = vi.spyOn(console, "error").mockImplementation(() => undefined)
			mocks.chat.mockRejectedValueOnce(failure)
			await expect(consume(handler, controller.signal)).rejects.toBe(failure)
			expect(mocks.chat).toHaveBeenCalledTimes(1)
			expect(mocks.chat).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({ signal: controller.signal, maxRetries: 0 }),
			)
			expect(mocks.responses).not.toHaveBeenCalled()
			expect(logger).not.toHaveBeenCalled()
		},
	)

	it("Codex aborts its active SDK request without starting an SSE fallback or refresh", async () => {
		const controller = new AbortController()
		const fetch = vi.fn()
		vi.stubGlobal("fetch", fetch)
		mocks.responses.mockImplementationOnce(
			(_body, options) =>
				new Promise((_resolve, reject) => {
					expect(options.maxRetries).toBe(0)
					options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
					controller.abort()
				}),
		)
		const handler = new OpenAiCodexHandler({ connectionTest: true })
		await expect(consume(handler, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
		expect(mocks.responses).toHaveBeenCalledTimes(1)
		expect(fetch).not.toHaveBeenCalled()
		expect(mocks.refresh).not.toHaveBeenCalled()
	})

	it("OpenAI diagnostics report an unsupported cache parameter without a fallback request", async () => {
		const failure = Object.assign(new Error("Unrecognized request argument supplied: cache_control"), {
			status: 400,
			request_id: "req_cache",
		})
		mocks.chat.mockRejectedValueOnce(failure)
		const handler = new OpenAiHandler({
			connectionTest: true,
			openAiModelId: "test-model",
			openAiBaseUrl: "https://gateway.example/v1",
			openAiWebSearchEnabled: false,
			openAiCustomModelInfo: { maxTokens: 1024, contextWindow: 4096, supportsPromptCache: true },
		})
		await expect(consume(handler)).rejects.toBe(failure)
		expect(mocks.chat).toHaveBeenCalledOnce()
		expect(JSON.stringify(mocks.chat.mock.calls[0][0])).toContain("cache_control")
	})

	it("Codex returns the first structured HTTP error without logging or fallback", async () => {
		const fetch = vi.fn()
		vi.stubGlobal("fetch", fetch)
		const failure = Object.assign(new Error("401 server secret"), { status: 401, request_id: "req_codex" })
		mocks.responses.mockRejectedValueOnce(failure)
		const logger = vi.spyOn(console, "error").mockImplementation(() => undefined)
		await expect(consume(new OpenAiCodexHandler({ connectionTest: true }))).rejects.toBe(failure)
		expect(fetch).not.toHaveBeenCalled()
		expect(mocks.refresh).not.toHaveBeenCalled()
		expect(logger).not.toHaveBeenCalled()
	})

	it("Codex does not accept a failed response event as a successful check", async () => {
		mocks.responses.mockResolvedValueOnce({
			async *[Symbol.asyncIterator]() {
				yield {
					type: "response.failed",
					response: { error: { code: "server_error", message: "server secret" } },
				}
			},
		})
		const fetch = vi.fn()
		vi.stubGlobal("fetch", fetch)
		await expect(consume(new OpenAiCodexHandler({ connectionTest: true }))).rejects.toMatchObject({
			error: { code: "server_error" },
		})
		expect(fetch).not.toHaveBeenCalled()
	})

	it("Ollama skips model discovery and aborts before response headers arrive", async () => {
		const controller = new AbortController()
		const fetch = vi.fn().mockImplementation(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
					controller.abort()
				}),
		)
		vi.stubGlobal("fetch", fetch)
		mocks.ollamaChat.mockImplementationOnce(() => {
			const config = vi.mocked(Ollama).mock.calls.at(-1)![0]!
			return config.fetch!("http://localhost:11434/api/chat", { signal: new AbortController().signal })
		})
		const handler = new NativeOllamaHandler({ connectionTest: true, ollamaModelId: "configured-model" })
		expect(handler.getModel().id).toBe("configured-model")
		expect(getOllamaModels).not.toHaveBeenCalled()
		await expect(consume(handler, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
		expect(getOllamaModels).not.toHaveBeenCalled()
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it("Ollama retains a stream failure without raw logging and closes its iterator", async () => {
		const failure = Object.assign(new Error("secret from stream"), { status: 503, request_id: "req_ollama" })
		const abort = vi.fn()
		mocks.ollamaChat.mockResolvedValueOnce({
			abort,
			async *[Symbol.asyncIterator]() {
				yield await Promise.reject(failure)
			},
		})
		const logger = vi.spyOn(console, "error").mockImplementation(() => undefined)
		await expect(consume(new NativeOllamaHandler({ connectionTest: true, ollamaModelId: "test" }))).rejects.toBe(
			failure,
		)
		expect(logger).not.toHaveBeenCalled()
		expect(abort).toHaveBeenCalledOnce()
	})

	it("Claude forwards the same cancellation signal and reports an auth failure without retry", async () => {
		const signal = new AbortController().signal
		const failure = Object.assign(new Error("authentication failed"), { status: 401, request_id: "req_claude" })
		vi.mocked(createStreamingMessage).mockImplementationOnce(async function* () {
			yield await Promise.reject(failure)
		})
		await expect(consume(new ClaudeCodeHandler({ connectionTest: true }), signal)).rejects.toBe(failure)
		expect(createStreamingMessage).toHaveBeenCalledWith(expect.objectContaining({ connectionTest: true, signal }))
		expect(mocks.refresh).not.toHaveBeenCalled()
	})

	it("normal LM Studio requests retain their original SDK options", async () => {
		mocks.chat.mockRejectedValueOnce(new Error("normal failure"))
		vi.spyOn(console, "error").mockImplementation(() => undefined)
		await expect(consume(new LmStudioHandler({ lmStudioModelId: "test" }))).rejects.toThrow(
			"LM Studio developer logs",
		)
		expect(mocks.chat.mock.calls[0]).toHaveLength(1)
		expect(vi.mocked(OpenAI).mock.calls.at(-1)![0]).not.toHaveProperty("maxRetries")
	})

	it("LM Studio diagnostics never inspect an active Task's tool parser state", async () => {
		const parser = vi.spyOn(NativeToolCallParser, "processFinishReason")
		mocks.chat.mockResolvedValueOnce({
			async *[Symbol.asyncIterator]() {
				yield { choices: [{ delta: { content: "OK" }, finish_reason: "tool_calls" }] }
			},
		})
		await consume(new LmStudioHandler({ connectionTest: true, lmStudioModelId: "test" }))
		expect(parser).not.toHaveBeenCalled()
	})

	it("the factory only accepts diagnostic mode through its runtime argument", async () => {
		const { buildApiHandler } = await import("../../index")
		const draft = {
			apiProvider: "ollama",
			ollamaModelId: "test",
			connectionTest: true,
		} as unknown as ProviderSettings
		buildApiHandler(draft, { connectionTest: true })
		expect(getOllamaModels).not.toHaveBeenCalled()
		buildApiHandler(draft)
		expect(getOllamaModels).toHaveBeenCalledOnce()
	})
})
