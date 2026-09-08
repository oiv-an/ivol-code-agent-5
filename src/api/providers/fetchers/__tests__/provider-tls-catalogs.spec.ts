// kilocode_change - new file
import axios from "axios"
import { LMStudioClient } from "@lmstudio/sdk"
import { createProviderFetch } from "../../utils/provider-tls"
import { openAiCodexOAuthManager } from "../../../../integrations/openai-codex/oauth"
import { getOpenAiCodexModels } from "../openai-codex"
import { getOllamaModels } from "../ollama"
import { forceFullModelDetailsLoad, getLMStudioModels } from "../lmstudio"
import { flushModels } from "../modelCache"
import ollamaModelDetails from "./fixtures/ollama-model-details.json"

vi.mock("axios")
vi.mock("@lmstudio/sdk", () => ({ LMStudioClient: vi.fn() }))
vi.mock("../../utils/provider-tls", () => ({ createProviderFetch: vi.fn() }))
vi.mock("../modelCache", () => ({ flushModels: vi.fn().mockResolvedValue(undefined), getModels: vi.fn() }))
vi.mock("../../../../integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: {
		getAccessToken: vi.fn().mockResolvedValue("test-token"),
		getAccountId: vi.fn().mockResolvedValue("test-account"),
		forceRefreshAccessToken: vi.fn().mockResolvedValue("rotated-test-token"),
	},
}))

const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })

describe("profile-scoped catalog TLS", () => {
	const insecureFetch = vi.fn()
	const strictFetch = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
		insecureFetch.mockReset()
		strictFetch.mockReset()
		vi.mocked(createProviderFetch).mockReturnValue(insecureFetch)
		vi.stubGlobal("fetch", strictFetch)
	})

	afterEach(() => vi.unstubAllGlobals())

	it("keeps Codex model discovery strict by default", async () => {
		strictFetch.mockResolvedValue(jsonResponse({ models: [{ slug: "gpt-test", visibility: "list" }] }))
		await getOpenAiCodexModels()
		expect(createProviderFetch).not.toHaveBeenCalled()
		expect(strictFetch).toHaveBeenCalledOnce()
		expect(openAiCodexOAuthManager.getAccessToken).toHaveBeenCalledWith()
	})

	it("uses the scoped transport for Codex catalogs and keeps auth refresh strict", async () => {
		const failedResponse = jsonResponse({}, 401)
		const cancelFailedBody = vi.spyOn(failedResponse.body!, "cancel")
		insecureFetch
			.mockResolvedValueOnce(failedResponse)
			.mockResolvedValueOnce(jsonResponse({ models: [{ slug: "gpt-test", visibility: "list" }] }))
		await getOpenAiCodexModels(true)
		expect(createProviderFetch).toHaveBeenCalledWith({
			baseUrl: "https://chatgpt.com/backend-api/codex/models",
			allowInsecureTls: true,
			timeoutMs: 30_000,
		})
		expect(insecureFetch).toHaveBeenCalledTimes(2)
		expect(strictFetch).not.toHaveBeenCalled()
		expect(openAiCodexOAuthManager.forceRefreshAccessToken).toHaveBeenCalledWith()
		expect(cancelFailedBody).toHaveBeenCalledOnce()
	})

	it("applies Ollama opt-in to both catalog and per-model detail requests", async () => {
		const details = ollamaModelDetails["qwen3-2to16:latest"]
		insecureFetch
			.mockResolvedValueOnce(
				jsonResponse({ models: [{ name: "test", model: "test", details: details.details }] }),
			)
			.mockResolvedValueOnce(jsonResponse(details))
		const models = await getOllamaModels("https://local.example", "test-key", 8192, true)
		expect(models.test.contextWindow).toBe(8192)
		expect(insecureFetch).toHaveBeenNthCalledWith(
			1,
			"https://local.example/api/tags",
			expect.objectContaining({ headers: { Authorization: "Bearer test-key" } }),
		)
		expect(insecureFetch).toHaveBeenNthCalledWith(
			2,
			"https://local.example/api/show",
			expect.objectContaining({ method: "POST", body: JSON.stringify({ model: "test" }) }),
		)
		expect(axios.get).not.toHaveBeenCalled()
		expect(axios.post).not.toHaveBeenCalled()
	})

	it("keeps Ollama axios discovery unchanged when TLS exception is off", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: { models: [] } })
		await getOllamaModels("https://local.example", undefined, undefined, false)
		expect(createProviderFetch).not.toHaveBeenCalled()
		expect(axios.get).toHaveBeenCalledWith("https://local.example/api/tags", { headers: {} })
	})

	it("uses LM Studio REST without constructing an insecure WebSocket client", async () => {
		insecureFetch.mockResolvedValue(
			jsonResponse({
				data: [
					{ id: "local-llm", type: "llm", loaded_context_length: 16384, max_context_length: 65536 },
					{ id: "vision-llm", type: "vlm" },
					{ id: "embedding", type: "embeddings" },
				],
			}),
		)
		const models = await getLMStudioModels("https://local.example", true)
		expect(models["local-llm"].contextWindow).toBe(16384)
		expect(models["vision-llm"].supportsImages).toBe(true)
		expect(models.embedding).toBeUndefined()
		expect(LMStudioClient).not.toHaveBeenCalled()
		expect(axios.get).not.toHaveBeenCalled()
	})

	it("falls back to OpenAI-compatible LM Studio catalogs on REST endpoint absence", async () => {
		const missingEndpoint = jsonResponse({}, 404)
		const cancelMissingBody = vi.spyOn(missingEndpoint.body!, "cancel")
		insecureFetch
			.mockResolvedValueOnce(missingEndpoint)
			.mockResolvedValueOnce(jsonResponse({ data: [{ id: "local-model", max_context_length: 1_000_000 }] }))
		const models = await getLMStudioModels("https://local.example/", true)
		expect(models["local-model"].contextWindow).toBe(4096)
		expect(insecureFetch).toHaveBeenNthCalledWith(2, "https://local.example/v1/models", expect.anything())
		expect(cancelMissingBody).toHaveBeenCalledOnce()
	})

	it("does not retry authentication errors against a different LM Studio endpoint", async () => {
		const failedResponse = jsonResponse({}, 401)
		const cancelFailedBody = vi.spyOn(failedResponse.body!, "cancel")
		insecureFetch.mockResolvedValue(failedResponse)
		expect(await getLMStudioModels("https://local.example", true)).toEqual({})
		expect(insecureFetch).toHaveBeenCalledOnce()
		expect(LMStudioClient).not.toHaveBeenCalled()
		expect(cancelFailedBody).toHaveBeenCalledOnce()
	})

	it("does not attempt SDK model auto-loading when HTTPS verification is opted out", async () => {
		await forceFullModelDetailsLoad("https://local.example", "local-model", true)
		expect(flushModels).toHaveBeenCalledWith(
			{ provider: "lmstudio", baseUrl: "https://local.example", allowInsecureTls: true },
			true,
		)
		expect(LMStudioClient).not.toHaveBeenCalled()
		expect(axios.get).not.toHaveBeenCalled()
	})
})
