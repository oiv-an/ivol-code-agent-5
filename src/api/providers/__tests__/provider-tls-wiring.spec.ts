// kilocode_change - new file
import OpenAI, { AzureOpenAI } from "openai"
import { Ollama } from "ollama"
import axios from "axios"
import { OpenAiHandler, getOpenAiModels } from "../openai"
import { OpenAiCompatibleResponsesHandler } from "../openai-responses"
import { OpenAiCodexHandler } from "../openai-codex"
import { LmStudioHandler, getLmStudioModels } from "../lm-studio"
import { NativeOllamaHandler } from "../native-ollama"
import { ClaudeCodeHandler } from "../claude-code"
import { getModelsFromCache } from "../fetchers/modelCache"
import { getOllamaModels } from "../fetchers/ollama"
import { claudeCodeOAuthManager } from "../../../integrations/claude-code/oauth"

const mocks = vi.hoisted(() => ({
	request: vi.fn(),
	strictFetch: vi.fn(),
	createProviderFetch: vi.fn(),
	create: vi.fn(),
}))

vi.mock("../utils/provider-tls", () => ({ createProviderFetch: mocks.createProviderFetch }))
vi.mock("openai", () => ({
	default: vi.fn().mockImplementation(() => ({
		chat: { completions: { create: mocks.create } },
		responses: { create: mocks.create },
	})),
	AzureOpenAI: vi.fn().mockImplementation(() => ({ responses: { create: mocks.create } })),
}))
vi.mock("axios", () => ({ default: { get: vi.fn() } }))
vi.mock("ollama", () => ({ Ollama: vi.fn().mockImplementation(() => ({})) }))
vi.mock("../fetchers/ollama", () => ({ getOllamaModels: vi.fn().mockResolvedValue({}) }))
vi.mock("../fetchers/modelCache", () => ({ getModelsFromCache: vi.fn().mockReturnValue(undefined) }))
vi.mock("../../../integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: {
		getAccessToken: vi.fn().mockResolvedValue("test-access-token"),
		getAccountId: vi.fn().mockResolvedValue(null),
	},
}))
vi.mock("../../../integrations/claude-code/oauth", () => ({
	claudeCodeOAuthManager: {
		getAccessToken: vi.fn().mockResolvedValue("test-access-token"),
		getEmail: vi.fn().mockResolvedValue(null),
	},
	generateUserId: vi.fn().mockReturnValue("test-user-id"),
}))

async function drain(stream: AsyncIterable<unknown>) {
	for await (const _chunk of stream) {
		// The wiring test verifies transport selection, not the already-tested parser output.
	}
}

describe("per-profile TLS transport wiring", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.createProviderFetch.mockReturnValue(mocks.request)
		mocks.create.mockImplementation(async () => (async function* () {})())
		mocks.request.mockImplementation(async () => new Response(""))
		mocks.strictFetch.mockImplementation(async () => new Response(""))
		vi.stubGlobal("fetch", mocks.strictFetch)
	})
	afterEach(() => vi.unstubAllGlobals())

	it.each([undefined, false])("keeps SDK transports strict when allowInsecureTls is %s", (allowInsecureTls) => {
		new OpenAiHandler({ allowInsecureTls, openAiBaseUrl: "https://provider.example/v1" })
		new OpenAiCompatibleResponsesHandler({ allowInsecureTls })
		new OpenAiCodexHandler({ allowInsecureTls })
		new LmStudioHandler({ allowInsecureTls })
		expect(mocks.createProviderFetch).not.toHaveBeenCalled()
		const lmOptions = vi.mocked(OpenAI).mock.calls.at(-1)?.[0]
		expect(lmOptions).not.toHaveProperty("fetch")
	})

	it("scopes OpenAI chat, completion and Azure SDK transports to their configured API URL", () => {
		const baseUrl = "https://provider.example/v1"
		new OpenAiHandler({ openAiBaseUrl: baseUrl, allowInsecureTls: true })
		expect(mocks.createProviderFetch).toHaveBeenLastCalledWith({
			baseUrl,
			allowInsecureTls: true,
			timeoutMs: expect.any(Number),
		})
		expect(OpenAI).toHaveBeenLastCalledWith(expect.objectContaining({ fetch: mocks.request, baseURL: baseUrl }))
		new OpenAiHandler({ openAiBaseUrl: baseUrl, openAiUseAzure: true, allowInsecureTls: true })
		expect(AzureOpenAI).toHaveBeenLastCalledWith(
			expect.objectContaining({ fetch: mocks.request, baseURL: baseUrl }),
		)
	})

	it("uses the opted-in transport for the dedicated native web-search worker", async () => {
		mocks.request.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					status: "completed",
					output: [
						{
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: "Search result" }],
						},
					],
					usage: { input_tokens: 10, output_tokens: 2 },
				}),
				{ headers: { "content-type": "application/json" } },
			),
		)
		const handler = new OpenAiCompatibleResponsesHandler({
			openAiBaseUrl: "https://provider.example",
			allowInsecureTls: true,
			openAiModelId: "test-model",
			openAiWebSearchEnabled: true,
		})
		const result = await handler.searchWeb("test query", "test-task")
		expect(result.text).toBe("Search result")
		expect(mocks.createProviderFetch).toHaveBeenCalledWith(
			expect.objectContaining({
				baseUrl: "https://provider.example/v1",
				allowInsecureTls: true,
			}),
		)
		expect(mocks.request).toHaveBeenCalledWith("https://provider.example/v1/responses", expect.any(Object))
		expect(mocks.strictFetch).not.toHaveBeenCalled()
		const body = JSON.parse(mocks.request.mock.calls[0][1].body)
		expect(body).not.toHaveProperty("allowInsecureTls")
	})

	it("passes the scoped transport into Codex SDK streaming", async () => {
		const handler = new OpenAiCodexHandler({ allowInsecureTls: true })
		await drain(handler.createMessage("system", [{ role: "user", content: "hello" }]))
		expect(mocks.createProviderFetch).toHaveBeenCalledWith({
			baseUrl: "https://chatgpt.com/backend-api/codex",
			allowInsecureTls: true,
		})
		expect(OpenAI).toHaveBeenLastCalledWith(expect.objectContaining({ fetch: mocks.request }))
	})

	it("retains the Codex TLS policy and cancellation signal when SDK streaming falls back to fetch", async () => {
		mocks.create.mockRejectedValueOnce(new Error("SDK stream unavailable"))
		mocks.request.mockResolvedValueOnce(new Response("data: [DONE]\n\n"))
		const handler = new OpenAiCodexHandler({ allowInsecureTls: true })
		await drain(handler.createMessage("system", [{ role: "user", content: "hello" }]))
		expect(mocks.request).toHaveBeenCalledWith(
			"https://chatgpt.com/backend-api/codex/responses",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		)
		expect(mocks.strictFetch).not.toHaveBeenCalled()
		expect(JSON.parse(mocks.request.mock.calls[0][1].body)).not.toHaveProperty("allowInsecureTls")
	})

	it("does not carry an insecure transport into a new strict profile for the same URL", () => {
		const openAiBaseUrl = "https://provider.example/v1"
		new OpenAiHandler({ openAiBaseUrl, allowInsecureTls: true })
		expect(vi.mocked(OpenAI).mock.calls.at(-1)?.[0]?.fetch).toBe(mocks.request)
		new OpenAiHandler({ openAiBaseUrl, allowInsecureTls: false })
		expect(vi.mocked(OpenAI).mock.calls.at(-1)?.[0]?.fetch).not.toBe(mocks.request)
		expect(mocks.createProviderFetch).toHaveBeenCalledTimes(1)
	})

	it("keeps the LM Studio transport and model metadata scoped to the selected endpoint and TLS policy", () => {
		const handler = new LmStudioHandler({ lmStudioBaseUrl: "https://local.example", allowInsecureTls: true })
		expect(OpenAI).toHaveBeenLastCalledWith(
			expect.objectContaining({
				baseURL: "https://local.example/v1",
				fetch: mocks.request,
			}),
		)
		handler.getModel()
		expect(getModelsFromCache).toHaveBeenLastCalledWith("lmstudio", {
			baseUrl: "https://local.example",
			allowInsecureTls: true,
		})
	})

	it("passes the profile policy to Ollama chat and model discovery", async () => {
		const handler = new NativeOllamaHandler({ ollamaBaseUrl: "https://local.example", allowInsecureTls: true })
		;(handler as any).ensureClient()
		await handler.fetchModel()
		expect(Ollama).toHaveBeenLastCalledWith(
			expect.objectContaining({
				host: "https://local.example",
				fetch: mocks.request,
			}),
		)
		expect(getOllamaModels).toHaveBeenLastCalledWith("https://local.example", undefined, undefined, true)
	})

	it("applies the Claude subscription policy to both chat and handoff completions, never OAuth calls", async () => {
		const handler = new ClaudeCodeHandler({ allowInsecureTls: true })
		await drain(handler.createMessage("system", [{ role: "user", content: "hello" }]))
		await handler.completePrompt("handoff")
		expect(mocks.createProviderFetch).toHaveBeenCalledTimes(2)
		expect(mocks.createProviderFetch).toHaveBeenCalledWith({
			baseUrl: "https://api.anthropic.com/v1/messages",
			allowInsecureTls: true,
		})
		expect(mocks.request).toHaveBeenCalledTimes(2)
		expect(claudeCodeOAuthManager.getAccessToken).toHaveBeenCalledWith()
		for (const [, init] of mocks.request.mock.calls) {
			expect(JSON.parse(init.body)).not.toHaveProperty("allowInsecureTls")
		}
	})

	it.each([getOpenAiModels, getLmStudioModels])(
		"retains strict catalog requests when no TLS opt-in exists",
		async (getModels) => {
			vi.mocked(axios.get).mockResolvedValueOnce({ data: { data: [{ id: "test-model" }] } })
			expect(await getModels("https://provider.example/v1")).toEqual(["test-model"])
			expect(mocks.createProviderFetch).not.toHaveBeenCalled()
			expect(axios.get).toHaveBeenCalledOnce()
		},
	)

	it("uses bounded scoped fetch for an opted-in OpenAI catalog and retains authorization", async () => {
		mocks.request.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "test-model" }] })))
		expect(await getOpenAiModels("https://provider.example/v1", "test-key", {}, true)).toEqual(["test-model"])
		expect(mocks.createProviderFetch).toHaveBeenLastCalledWith({
			baseUrl: "https://provider.example/v1",
			allowInsecureTls: true,
			timeoutMs: 8_000,
		})
		expect(mocks.request.mock.calls[0][1]).toEqual(
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
				signal: expect.any(AbortSignal),
			}),
		)
		expect(axios.get).not.toHaveBeenCalled()
	})

	it("uses scoped fetch for the legacy LM Studio catalog request", async () => {
		mocks.request.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "local-model" }] })))
		expect(await getLmStudioModels("https://local.example", true)).toEqual(["local-model"])
		expect(mocks.request).toHaveBeenCalledWith("https://local.example/v1/models", expect.any(Object))
		expect(axios.get).not.toHaveBeenCalled()
	})
})
