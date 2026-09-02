import { describe, it, expect, vi, beforeEach } from "vitest"
import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"

// Mock vscode (minimal)
vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		// kilocode_change start
		createTextEditorDecorationType: vi.fn(() => ({
			dispose: vi.fn(),
		})),
		// kilocode_change end
	},
	workspace: {
		workspaceFolders: undefined,
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
			update: vi.fn(),
		})),
	},
	env: {
		clipboard: { writeText: vi.fn() },
		openExternal: vi.fn(),
	},
	commands: {
		executeCommand: vi.fn(),
	},
	Uri: {
		parse: vi.fn((s: string) => ({ toString: () => s })),
		file: vi.fn((p: string) => ({ fsPath: p })),
	},
	ConfigurationTarget: {
		Global: 1,
		Workspace: 2,
		WorkspaceFolder: 3,
	},
}))

// Mock modelCache getModels/flushModels used by the handler
const getModelsMock = vi.fn()
const flushModelsMock = vi.fn()
vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: (...args: any[]) => getModelsMock(...args),
	flushModels: (...args: any[]) => flushModelsMock(...args),
}))

// kilocode_change start: OpenAI-compatible quick model selector
const getOpenAiModelsMock = vi.fn()
vi.mock("../../../api/providers/openai", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../api/providers/openai")>()

	return {
		...original,
		getOpenAiModels: (...args: any[]) => getOpenAiModelsMock(...args),
	}
})
// kilocode_change end

describe("webviewMessageHandler - requestRouterModels provider filter", () => {
	let mockProvider: ClineProvider & {
		postMessageToWebview: ReturnType<typeof vi.fn>
		getState: ReturnType<typeof vi.fn>
		contextProxy: any
		context: any
		log: ReturnType<typeof vi.fn>
	}
	let globalStateValues: Map<string, unknown>

	beforeEach(() => {
		vi.clearAllMocks()
		getOpenAiModelsMock.mockReset()
		globalStateValues = new Map()

		mockProvider = {
			// Only methods used by this code path
			postMessageToWebview: vi.fn(),
			getState: vi.fn().mockResolvedValue({ apiConfiguration: {} }),
			contextProxy: {
				getValue: vi.fn(),
				setValue: vi.fn(),
				globalStorageUri: { fsPath: "/mock/storage" },
			},
			context: {
				globalState: {
					get: vi.fn((key: string) => globalStateValues.get(key)),
					update: vi.fn(async (key: string, value: unknown) => {
						globalStateValues.set(key, value)
					}),
				},
			},
			log: vi.fn(),
		} as any

		// Default mock: return distinct model maps per provider so we can verify keys
		getModelsMock.mockImplementation(async (options: any) => {
			switch (options?.provider) {
				case "ollama":
					return { "local/ollama": { contextWindow: 8192, supportsPromptCache: false } }
				case "lmstudio":
					return { "local/lmstudio": { contextWindow: 8192, supportsPromptCache: false } }
				case "roo":
					return { "roo/sonnet": { contextWindow: 8192, supportsPromptCache: false } }
				case "openrouter":
					return { "openrouter/qwen2.5": { contextWindow: 32768, supportsPromptCache: false } }
				case "requesty":
					return { "requesty/model": { contextWindow: 8192, supportsPromptCache: false } }
				case "deepinfra":
					return { "deepinfra/model": { contextWindow: 8192, supportsPromptCache: false } }
				// kilocode_change start
				case "glama":
					return { "glama/model": { contextWindow: 8192, supportsPromptCache: false } }
				// kilocode_change end
				case "unbound":
					return { "unbound/model": { contextWindow: 8192, supportsPromptCache: false } }
				case "vercel-ai-gateway":
					return { "vercel/model": { contextWindow: 8192, supportsPromptCache: false } }
				case "io-intelligence":
					return { "io/model": { contextWindow: 8192, supportsPromptCache: false } }
				case "litellm":
					return { "litellm/model": { contextWindow: 8192, supportsPromptCache: false } }
				default:
					return {}
			}
		})
	})

	it.each(["roo", "openrouter"] as const)("fails closed for hidden provider '%s'", async (hiddenProvider) => {
		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestRouterModels",
				values: { provider: hiddenProvider },
			} as any,
		)

		expect(getModelsMock).not.toHaveBeenCalled()
		expect(flushModelsMock).not.toHaveBeenCalled()
		expect(mockProvider.getState).not.toHaveBeenCalled()
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: { [hiddenProvider]: {} },
			values: { provider: hiddenProvider },
		})
		expect(mockProvider.log).toHaveBeenCalledWith(
			`[Models] Ignored non-personal router-model request for ${hiddenProvider}`,
		)
	})

	it.each(["kilocode", "roo", "openrouter"] as const)(
		"ignores a generic cache flush for hidden provider '%s'",
		async (hiddenProvider) => {
			await webviewMessageHandler(
				mockProvider as any,
				{
					type: "flushRouterModels",
					text: hiddenProvider,
				} as any,
			)

			expect(flushModelsMock).not.toHaveBeenCalled()
			expect(getModelsMock).not.toHaveBeenCalled()
			expect(mockProvider.log).toHaveBeenCalledWith(
				`[Models] Ignored non-personal router-model flush for ${hiddenProvider}`,
			)
		},
	)

	it("fails closed for the legacy direct Roo model request", async () => {
		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestRooModels",
			} as any,
		)

		expect(getModelsMock).not.toHaveBeenCalled()
		expect(flushModelsMock).not.toHaveBeenCalled()
		expect(mockProvider.getState).not.toHaveBeenCalled()
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: true,
			values: { provider: "roo", models: {} },
		})
	})

	it.each([
		["requestVsCodeLmModels", { type: "vsCodeLmModels", vsCodeLmModels: [] }],
		["requestHuggingFaceModels", { type: "huggingFaceModels", huggingFaceModels: [] }],
		["requestSapAiCoreModels", { type: "sapAiCoreModels", sapAiCoreModels: {} }],
		["requestSapAiCoreDeployments", { type: "sapAiCoreDeployments", sapAiCoreDeployments: {} }],
	] as const)("returns an empty local response for hidden provider message '%s'", async (messageType, response) => {
		await webviewMessageHandler(
			mockProvider as any,
			{
				type: messageType,
				values: { sapAiCoreServiceKey: '{"clientid":"would-fetch"}' },
			} as any,
		)

		expect(getModelsMock).not.toHaveBeenCalled()
		expect(flushModelsMock).not.toHaveBeenCalled()
		expect(mockProvider.getState).not.toHaveBeenCalled()
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith(response)
	})

	it("stores a hidden Kilo profile organization change without refreshing vendor data", async () => {
		const hiddenKiloConfiguration = {
			apiProvider: "kilocode" as const,
			kilocodeToken: "stored-token",
			kilocodeOrganizationId: "new-organization",
		}
		const getProfile = vi.fn().mockResolvedValue({
			apiProvider: "kilocode",
			kilocodeToken: "stored-token",
			kilocodeOrganizationId: "old-organization",
		})
		const upsertProviderProfile = vi.fn().mockResolvedValue("hidden-kilo-id")
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		;(mockProvider as any).providerSettingsManager = { getProfile }
		;(mockProvider as any).upsertProviderProfile = upsertProviderProfile
		;(mockProvider as any).postStateToWebview = postStateToWebview
		mockProvider.contextProxy.getValue.mockImplementation((key: string) =>
			key === "currentApiConfigName" ? "Personal OpenAI" : undefined,
		)

		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "upsertApiConfiguration",
				text: "Legacy Kilo",
				apiConfiguration: hiddenKiloConfiguration,
			} as any,
		)

		expect(getModelsMock).not.toHaveBeenCalled()
		expect(flushModelsMock).not.toHaveBeenCalled()
		expect(upsertProviderProfile).toHaveBeenCalledWith("Legacy Kilo", hiddenKiloConfiguration, false)
		expect(postStateToWebview).toHaveBeenCalledTimes(1)
		expect(mockProvider.log).toHaveBeenCalledWith(
			"[Models] Stored Kilo organization change without vendor refresh in personal build",
		)
	})

	it.each(["ollama", "lmstudio"] as const)(
		"allows a generic cache flush for local provider '%s'",
		async (localProvider) => {
			await webviewMessageHandler(
				mockProvider as any,
				{
					type: "flushRouterModels",
					text: localProvider,
				} as any,
			)

			expect(flushModelsMock).toHaveBeenCalledTimes(1)
			expect(flushModelsMock).toHaveBeenCalledWith({ provider: localProvider }, true)
			expect(getModelsMock).not.toHaveBeenCalled()
		},
	)

	it.each(["ollama", "lmstudio"] as const)("fetches the allowed local provider '%s'", async (localProvider) => {
		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestRouterModels",
				values: { provider: localProvider },
			} as any,
		)

		expect(getModelsMock).toHaveBeenCalledTimes(1)
		expect(getModelsMock).toHaveBeenCalledWith(expect.objectContaining({ provider: localProvider }))
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: {
				[localProvider]: {
					[`local/${localProvider}`]: { contextWindow: 8192, supportsPromptCache: false },
				},
			},
			values: { provider: localProvider },
		})
	})

	it("fails closed when no provider filter is sent", async () => {
		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestRouterModels",
			} as any,
		)

		const call = (mockProvider.postMessageToWebview as any).mock.calls.find(
			(c: any[]) => c[0]?.type === "routerModels",
		)
		expect(call).toBeTruthy()
		const routerModels = call[0].routerModels as Record<string, Record<string, any>>

		expect(routerModels).toEqual({})
		expect(getModelsMock).not.toHaveBeenCalled()
		expect(mockProvider.log).toHaveBeenCalledWith(
			"[Models] Ignored unfiltered router-model request in personal build",
		)
	})

	it("returns an empty selected-provider catalog when no aggregate candidate exists", async () => {
		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestRouterModels",
				values: { provider: "apertis" },
			} as any,
		)

		const call = (mockProvider.postMessageToWebview as any).mock.calls.find(
			(c: any[]) => c[0]?.type === "routerModels",
		)
		expect(call).toBeTruthy()
		expect(call[0].routerModels).toEqual({ apertis: {} })
		expect(call[0].values).toEqual({ provider: "apertis" })
		expect(getModelsMock).not.toHaveBeenCalled()
	})

	it("never fetches the official Kilo catalog in the personal build", async () => {
		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestRouterModels",
				values: { provider: "kilocode" },
			} as any,
		)

		expect(getModelsMock).not.toHaveBeenCalled()
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: { kilocode: {} },
			values: { provider: "kilocode" },
		})
	})

	it("reports a failure only for an allowed local provider", async () => {
		getModelsMock.mockRejectedValueOnce(new Error("Ollama API error"))

		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestRouterModels",
				values: { provider: "ollama" },
			} as any,
		)

		expect(getModelsMock).toHaveBeenCalledTimes(1)
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "Ollama API error",
			values: { provider: "ollama" },
		})
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: { ollama: {} },
			values: { provider: "ollama" },
		})
	})

	// kilocode_change start: OpenAI-compatible quick model selector
	it("echoes the request id with OpenAI-compatible models", async () => {
		getOpenAiModelsMock.mockResolvedValue(["model-one", "model-two"])

		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestOpenAiModels",
				requestId: "openai-models-request-1",
				values: {
					profileId: "profile-id",
					baseUrl: "https://provider.example/v1",
					apiKey: "test-key",
					openAiHeaders: { "X-Test": "value" },
				},
			} as any,
		)

		expect(getOpenAiModelsMock).toHaveBeenCalledWith("https://provider.example/v1", "test-key", {
			"X-Test": "value",
		})
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "openAiModels",
			openAiModels: ["model-one", "model-two"],
			requestId: "openai-models-request-1",
		})
	})

	it("uses a public model catalog when the authenticated catalog is empty", async () => {
		getOpenAiModelsMock.mockResolvedValueOnce([]).mockResolvedValueOnce(["model-one", "model-two"])

		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestOpenAiModels",
				requestId: "openai-public-models-request",
				values: {
					profileId: "profile-id",
					baseUrl: "https://provider.example/v1",
					apiKey: "test-key",
					openAiHeaders: { Authorization: "custom-secret", "X-Test": "value" },
				},
			} as any,
		)

		expect(getOpenAiModelsMock).toHaveBeenNthCalledWith(
			1,
			"https://provider.example/v1",
			"test-key",
			{ Authorization: "custom-secret", "X-Test": "value" },
		)
		expect(getOpenAiModelsMock).toHaveBeenNthCalledWith(2, "https://provider.example/v1", undefined, {
			"X-Test": "value",
		})
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "openAiModels",
			openAiModels: ["model-one", "model-two"],
			requestId: "openai-public-models-request",
		})
		expect(JSON.stringify([...globalStateValues])).not.toContain("test-key")
		expect(JSON.stringify([...globalStateValues])).not.toContain("custom-secret")
	})

	it("returns the saved catalog before a slow background refresh finishes", async () => {
		getOpenAiModelsMock.mockResolvedValueOnce(["model-one", "model-two"])

		const values = {
			profileId: "profile-id",
			baseUrl: "https://provider.example/v1",
			apiKey: "test-key",
			openAiHeaders: { "X-Test": "value" },
		}

		await webviewMessageHandler(
			mockProvider as any,
			{ type: "requestOpenAiModels", requestId: "initial-catalog", values } as any,
		)

		mockProvider.postMessageToWebview.mockClear()
		let resolveAuthenticatedRefresh: (models: string[]) => void = () => undefined
		const slowAuthenticatedRefresh = new Promise<string[]>((resolve) => {
			resolveAuthenticatedRefresh = resolve
		})
		getOpenAiModelsMock.mockReset().mockReturnValueOnce(slowAuthenticatedRefresh).mockResolvedValueOnce([])

		const laterRequest = webviewMessageHandler(
			mockProvider as any,
			{ type: "requestOpenAiModels", requestId: "later-catalog", values } as any,
		)
		await expect(laterRequest).resolves.toBeUndefined()

		expect(getOpenAiModelsMock).toHaveBeenCalledTimes(1)
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "openAiModels",
			openAiModels: ["model-one", "model-two"],
			requestId: "later-catalog",
			values: { backgroundRefreshPending: true },
		})

		resolveAuthenticatedRefresh([])
		await vi.waitFor(() => expect(getOpenAiModelsMock).toHaveBeenCalledTimes(2))
		await vi.waitFor(() =>
			expect(mockProvider.log).toHaveBeenCalledWith(
				"[Models] Live OpenAI-compatible model catalog was empty; keeping the saved catalog",
			),
		)
		await vi.waitFor(() =>
			expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "openAiModels",
				openAiModels: ["model-one", "model-two"],
				requestId: "later-catalog",
				values: { backgroundRefresh: true },
			}),
		)
	})

	it("always completes an OpenAI-compatible model request when credentials are unavailable", async () => {
		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestOpenAiModels",
				requestId: "openai-models-request-without-credentials",
				values: {},
			} as any,
		)

		expect(getOpenAiModelsMock).not.toHaveBeenCalled()
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "openAiModels",
			openAiModels: [],
			requestId: "openai-models-request-without-credentials",
		})
	})
	// kilocode_change end

	it("ignores refresh credentials for hidden LiteLLM profiles", async () => {
		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestRouterModels",
				values: {
					provider: "litellm",
					refresh: true,
					litellmApiKey: "test-api-key",
					litellmBaseUrl: "http://localhost:4000",
				},
			} as any,
		)

		expect(getModelsMock).not.toHaveBeenCalled()
		expect(flushModelsMock).not.toHaveBeenCalled()
		expect(mockProvider.getState).not.toHaveBeenCalled()
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: { litellm: {} },
			values: { provider: "litellm" },
		})
	})
})
