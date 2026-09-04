import { renderHook } from "@testing-library/react"

import {
	openAiCodexModels,
	openAiModelInfoSaneDefaults,
	type ModelRecord,
	type ProviderSettings,
} from "@roo-code/types"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useRouterModels } from "@/components/ui/hooks/useRouterModels"

import { useOpenAiModels } from "../useOpenAiModels"
import { useProviderModels } from "../useProviderModels"

vi.mock("@/context/ExtensionStateContext")
vi.mock("@/components/ui/hooks/useRouterModels")
vi.mock("../useOpenAiModels")

const mockUseExtensionState = vi.mocked(useExtensionState)
const mockUseRouterModels = vi.mocked(useRouterModels)
const mockUseOpenAiModels = vi.mocked(useOpenAiModels)

describe("useProviderModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseExtensionState.mockReturnValue({
			kilocodeDefaultModel: "kilocode-default",
			currentApiConfigName: "test-profile",
			listApiConfigMeta: [{ id: "profile-id", name: "test-profile", apiProvider: "openai" }],
		} as any)
		mockUseRouterModels.mockReturnValue({
			data: {},
			isLoading: false,
			isError: false,
		} as any)
		mockUseOpenAiModels.mockReturnValue({
			data: {
				"model-one": openAiModelInfoSaneDefaults,
				"model-two": openAiModelInfoSaneDefaults,
			},
			isLoading: false,
			isError: false,
		} as any)
	})

	it("uses the provider model catalog for the personal OpenAI-compatible profile", () => {
		const apiConfiguration: ProviderSettings = {
			apiProvider: "openai",
			openAiBaseUrl: "https://provider.example/v1",
			openAiApiKey: "test-key",
			openAiHeaders: { "X-Test": "value" },
			openAiModelId: "model-one",
		}

		const { result } = renderHook(() => useProviderModels(apiConfiguration))

		expect(Object.keys(result.current.providerModels)).toEqual(["model-one", "model-two"])
		expect(result.current.providerDefaultModel).toBe("model-one")
		expect(mockUseOpenAiModels).toHaveBeenCalledWith({
			profileId: "profile-id",
			baseUrl: "https://provider.example/v1",
			apiKey: "test-key",
			openAiHeaders: { "X-Test": "value" },
			enabled: true,
		})
		expect(mockUseRouterModels).toHaveBeenCalledWith(expect.any(Object), {
			provider: undefined,
			enabled: false,
		})
	})

	it("uses the signed-in account catalog for the ChatGPT subscription profile", () => {
		const accountModels: ModelRecord = {
			"account-model": {
				contextWindow: 370_000,
				supportsPromptCache: true,
			},
			"account-model-2": {
				contextWindow: 370_000,
				supportsPromptCache: true,
			},
		}
		mockUseRouterModels.mockReturnValue({
			data: { "openai-codex": accountModels },
			isLoading: false,
			isError: false,
		} as any)

		const { result } = renderHook(() =>
			useProviderModels({ apiProvider: "openai-codex", apiModelId: "account-model" }),
		)

		expect(result.current.providerModels).toBe(accountModels)
		expect(result.current.providerDefaultModel).toBe("account-model")
		expect(mockUseRouterModels).toHaveBeenCalledWith(expect.any(Object), {
			provider: "openai-codex",
			enabled: true,
		})
		expect(mockUseOpenAiModels).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
	})

	it("keeps the bundled Codex catalog available while the account catalog loads", () => {
		mockUseRouterModels.mockReturnValue({
			data: undefined,
			isLoading: true,
			isError: false,
		} as any)

		const { result } = renderHook(() => useProviderModels({ apiProvider: "openai-codex" }))

		expect(result.current.providerModels).toBe(openAiCodexModels)
		expect(result.current.isLoading).toBe(true)
	})

	it.each(["openai-responses", "openrouter", "roo"] as const)(
		"does not request a model catalog for hidden provider %s",
		(apiProvider) => {
			renderHook(() => useProviderModels({ apiProvider } as ProviderSettings))

			expect(mockUseOpenAiModels).toHaveBeenCalledWith(
				expect.objectContaining({
					enabled: false,
				}),
			)
			expect(mockUseRouterModels).toHaveBeenCalledWith(expect.any(Object), {
				provider: undefined,
				enabled: false,
			})
		},
	)

	it.each(["ollama", "lmstudio"] as const)("requests only the allowed local catalog for %s", (apiProvider) => {
		renderHook(() => useProviderModels({ apiProvider } as ProviderSettings))

		expect(mockUseRouterModels).toHaveBeenCalledWith(expect.any(Object), {
			provider: apiProvider,
			enabled: true,
		})
	})

	it("uses static provider models without requesting every router catalog", () => {
		const { result } = renderHook(() => useProviderModels({ apiProvider: "anthropic" }))

		expect(Object.keys(result.current.providerModels).length).toBeGreaterThan(0)
		expect(mockUseRouterModels).toHaveBeenCalledWith(expect.any(Object), {
			provider: undefined,
			enabled: false,
		})
	})

	it("does not request the official catalog for a migrated hidden Kilo profile", () => {
		mockUseRouterModels.mockReturnValue({
			data: { kilocode: { "kilo/model": openAiModelInfoSaneDefaults } },
			isLoading: false,
			isError: false,
		} as any)

		const { result } = renderHook(() => useProviderModels({ apiProvider: "kilocode", kilocodeToken: "test-token" }))

		// Existing in-memory data may still be rendered, but mounting the UI must
		// not initiate a new request to the official Kilo service.
		expect(Object.keys(result.current.providerModels)).toEqual(["kilo/model"])
		expect(mockUseRouterModels).toHaveBeenCalledWith(expect.any(Object), {
			provider: undefined,
			enabled: false,
		})
	})
})
