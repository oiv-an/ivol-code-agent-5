import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { AutocompleteModel, PERSONAL_AUTOCOMPLETE_PROVIDER_MODELS } from "../AutocompleteModel"
import { ProviderSettingsManager } from "../../../core/config/ProviderSettingsManager"
import * as apiIndex from "../../../api"

describe("AutocompleteModel", () => {
	let mockProviderSettingsManager: ProviderSettingsManager

	beforeEach(() => {
		mockProviderSettingsManager = {
			listConfig: vi.fn(),
			getProfile: vi.fn(),
		} as any
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	describe("reload", () => {
		it("uses personal local-provider priority instead of profile order", async () => {
			const supportedProviders = [...PERSONAL_AUTOCOMPLETE_PROVIDER_MODELS.keys()]
			const profiles = [
				{ id: "2", name: "profile2", apiProvider: supportedProviders[1] },
				{ id: "1", name: "profile1", apiProvider: supportedProviders[0] },
			] as any

			vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue(profiles)
			vi.mocked(mockProviderSettingsManager.getProfile).mockResolvedValue({
				id: "1",
				name: "profile1",
				apiProvider: supportedProviders[0],
				mistralApiKey: "test-key",
			} as any)

			const model = new AutocompleteModel()
			await model.reload(mockProviderSettingsManager)

			expect(mockProviderSettingsManager.getProfile).toHaveBeenCalledWith({ id: "1" })
		})

		it("filters out profiles without apiProvider", async () => {
			const supportedProviders = [...PERSONAL_AUTOCOMPLETE_PROVIDER_MODELS.keys()]
			const profiles = [
				{ id: "1", name: "profile1", apiProvider: undefined },
				{ id: "2", name: "profile2", apiProvider: supportedProviders[0] },
			] as any

			vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue(profiles)
			vi.mocked(mockProviderSettingsManager.getProfile).mockResolvedValue({
				id: "2",
				name: "profile2",
				apiProvider: supportedProviders[0],
				mistralApiKey: "test-key",
			} as any)

			const model = new AutocompleteModel()
			await model.reload(mockProviderSettingsManager)

			expect(mockProviderSettingsManager.getProfile).toHaveBeenCalledWith({ id: "2" })
		})

		it("filters out profiles with unsupported apiProvider", async () => {
			const supportedProviders = [...PERSONAL_AUTOCOMPLETE_PROVIDER_MODELS.keys()]
			const profiles = [
				{ id: "1", name: "profile1", apiProvider: "unsupported" },
				{ id: "2", name: "profile2", apiProvider: supportedProviders[0] },
			] as any

			vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue(profiles)
			vi.mocked(mockProviderSettingsManager.getProfile).mockResolvedValue({
				id: "2",
				name: "profile2",
				apiProvider: supportedProviders[0],
				mistralApiKey: "test-key",
			} as any)

			const model = new AutocompleteModel()
			await model.reload(mockProviderSettingsManager)

			expect(mockProviderSettingsManager.getProfile).toHaveBeenCalledWith({ id: "2" })
		})

		it("handles empty profile list", async () => {
			vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue([])

			const model = new AutocompleteModel()
			const result = await model.reload(mockProviderSettingsManager)

			expect(mockProviderSettingsManager.getProfile).not.toHaveBeenCalled()
			expect(model.hasValidCredentials()).toBe(false)
			expect(result).toBe(false)
		})

		it("returns true when profile found", async () => {
			const supportedProviders = [...PERSONAL_AUTOCOMPLETE_PROVIDER_MODELS.keys()]
			const profiles = [{ id: "1", name: "local-profile", apiProvider: supportedProviders[0] }] as any

			vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue(profiles)
			vi.mocked(mockProviderSettingsManager.getProfile).mockResolvedValue({
				id: "1",
				name: "local-profile",
				apiProvider: supportedProviders[0],
			} as any)

			const model = new AutocompleteModel()
			const result = await model.reload(mockProviderSettingsManager)

			expect(result).toBe(true)
			expect(model.loaded).toBe(true)
		})
	})

	describe("personal provider isolation", () => {
		it("allows only LM Studio and Ollama for autocomplete", () => {
			expect([...PERSONAL_AUTOCOMPLETE_PROVIDER_MODELS.keys()]).toEqual(["lmstudio", "ollama"])
		})

		it("does not inspect or contact a saved Kilo profile", async () => {
			vi.stubGlobal("fetch", vi.fn())
			vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue([
				{ id: "kilo", name: "Old Kilo", apiProvider: "kilocode", kilocodeToken: "secret" },
			] as any)

			const model = new AutocompleteModel()
			const result = await model.reload(mockProviderSettingsManager)

			expect(result).toBe(false)
			expect(mockProviderSettingsManager.getProfile).not.toHaveBeenCalled()
			expect(global.fetch).not.toHaveBeenCalled()
			expect(model.hasKilocodeProfileWithNoBalance).toBe(false)
		})

		it("ignores an explicit Kilo autocomplete profile and uses an allowed local profile", async () => {
			vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue([
				{ id: "kilo", name: "Old Kilo", apiProvider: "kilocode", profileType: "autocomplete" },
				{ id: "local", name: "Local", apiProvider: "lmstudio" },
			] as any)
			vi.mocked(mockProviderSettingsManager.getProfile).mockResolvedValue({
				id: "local",
				name: "Local",
				apiProvider: "lmstudio",
			} as any)

			const model = new AutocompleteModel()
			const result = await model.reload(mockProviderSettingsManager)

			expect(result).toBe(true)
			expect(mockProviderSettingsManager.getProfile).toHaveBeenCalledTimes(1)
			expect(mockProviderSettingsManager.getProfile).toHaveBeenCalledWith({ id: "local" })
		})
	})

	describe("getProviderDisplayName", () => {
		it("returns undefined when no provider is loaded", () => {
			const model = new AutocompleteModel()
			expect(model.getProviderDisplayName()).toBeUndefined()
		})

		it("returns provider name from API handler when provider is loaded", async () => {
			const supportedProviders = [...PERSONAL_AUTOCOMPLETE_PROVIDER_MODELS.keys()]
			const profiles = [{ id: "1", name: "profile1", apiProvider: supportedProviders[0] }] as any

			vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue(profiles)
			vi.mocked(mockProviderSettingsManager.getProfile).mockResolvedValue({
				id: "1",
				name: "profile1",
				apiProvider: supportedProviders[0],
				mistralApiKey: "test-key",
			} as any)

			// Mock buildApiHandler to return a handler with providerName
			const mockApiHandler = {
				providerName: "LM Studio",
				getModel: vi.fn().mockReturnValue({ id: "local-model", info: {} }),
				createMessage: vi.fn(),
				countTokens: vi.fn(),
			}
			vi.spyOn(apiIndex, "buildApiHandler").mockReturnValue(mockApiHandler as any)

			const model = new AutocompleteModel()
			await model.reload(mockProviderSettingsManager)

			const providerName = model.getProviderDisplayName()
			const providerKey = model.getProviderKey()
			expect(providerName).toBeTruthy()
			expect(typeof providerName).toBe("string")
			expect(providerName).toBe("LM Studio")
			expect(providerKey).toBe(supportedProviders[0])

			// Restore the spy
			vi.restoreAllMocks()
		})

		describe("profile information", () => {
			it("returns null for profile name when no profile is loaded", () => {
				const model = new AutocompleteModel()
				expect(model.profileName).toBeNull()
			})

			it("returns null for profile type when no profile is loaded", () => {
				const model = new AutocompleteModel()
				expect(model.profileType).toBeNull()
			})

			it("stores and returns profile name after loading", async () => {
				const supportedProviders = [...PERSONAL_AUTOCOMPLETE_PROVIDER_MODELS.keys()]
				const profiles = [
					{
						id: "1",
						name: "My Autocomplete Profile",
						apiProvider: supportedProviders[0],
						profileType: "autocomplete",
					},
				] as any

				vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue(profiles)
				vi.mocked(mockProviderSettingsManager.getProfile).mockResolvedValue({
					id: "1",
					name: "My Autocomplete Profile",
					apiProvider: supportedProviders[0],
					profileType: "autocomplete",
					mistralApiKey: "test-key",
				} as any)

				const model = new AutocompleteModel()
				await model.reload(mockProviderSettingsManager)

				expect(model.profileName).toBe("My Autocomplete Profile")
			})

			it("stores and returns profile type after loading", async () => {
				const supportedProviders = [...PERSONAL_AUTOCOMPLETE_PROVIDER_MODELS.keys()]
				const profiles = [
					{ id: "1", name: "My Profile", apiProvider: supportedProviders[0], profileType: "autocomplete" },
				] as any

				vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue(profiles)
				vi.mocked(mockProviderSettingsManager.getProfile).mockResolvedValue({
					id: "1",
					name: "My Profile",
					apiProvider: supportedProviders[0],
					profileType: "autocomplete",
					mistralApiKey: "test-key",
				} as any)

				const model = new AutocompleteModel()
				await model.reload(mockProviderSettingsManager)

				expect(model.profileType).toBe("autocomplete")
			})

			it("clears profile information on cleanup", async () => {
				const supportedProviders = [...PERSONAL_AUTOCOMPLETE_PROVIDER_MODELS.keys()]
				const profiles = [
					{ id: "1", name: "My Profile", apiProvider: supportedProviders[0], profileType: "autocomplete" },
				] as any

				vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue(profiles)
				vi.mocked(mockProviderSettingsManager.getProfile).mockResolvedValue({
					id: "1",
					name: "My Profile",
					apiProvider: supportedProviders[0],
					profileType: "autocomplete",
					mistralApiKey: "test-key",
				} as any)

				const model = new AutocompleteModel()
				await model.reload(mockProviderSettingsManager)

				expect(model.profileName).toBe("My Profile")
				expect(model.profileType).toBe("autocomplete")

				// Reload with empty profiles to trigger cleanup
				vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue([])
				await model.reload(mockProviderSettingsManager)

				expect(model.profileName).toBeNull()
				expect(model.profileType).toBeNull()
			})
		})
	})

	describe("reload model override behavior", () => {
		beforeEach(() => {
			// Mock buildApiHandler to return a handler with getModel
			const mockApiHandler = {
				getModel: vi.fn().mockReturnValue({ id: "test-model", info: {} }),
				createMessage: vi.fn(),
				countTokens: vi.fn(),
			}
			vi.spyOn(apiIndex, "buildApiHandler").mockReturnValue(mockApiHandler as any)
		})

		afterEach(() => {
			vi.restoreAllMocks()
		})

		it("should use custom model for explicit autocomplete profiles", async () => {
			const supportedProviders = [...PERSONAL_AUTOCOMPLETE_PROVIDER_MODELS.keys()]
			const provider = supportedProviders[0]
			const customModelId = "custom-autocomplete-model"

			const profiles = [
				{
					id: "1",
					name: "My Autocomplete Profile",
					apiProvider: provider,
					profileType: "autocomplete",
				},
			] as any

			vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue(profiles)
			vi.mocked(mockProviderSettingsManager.getProfile).mockResolvedValue({
				id: "1",
				name: "My Autocomplete Profile",
				apiProvider: provider,
				profileType: "autocomplete",
				mistralApiKey: "test-key",
				apiModelId: customModelId, // Custom model set by user
			} as any)

			// Mock buildApiHandler to return the custom model
			const mockApiHandler = {
				getModel: vi.fn().mockReturnValue({ id: customModelId, info: {} }),
				createMessage: vi.fn(),
				countTokens: vi.fn(),
			}
			vi.spyOn(apiIndex, "buildApiHandler").mockReturnValue(mockApiHandler as any)

			const model = new AutocompleteModel()
			await model.reload(mockProviderSettingsManager)

			// The model should use the custom model from the profile
			const modelName = model.getModelName()
			expect(modelName).toBe(customModelId)
		})

		it("should override model for non-autocomplete profiles", async () => {
			const supportedProviders = [...PERSONAL_AUTOCOMPLETE_PROVIDER_MODELS.keys()]
			const provider = supportedProviders[0]
			const defaultAutocompleteModel = PERSONAL_AUTOCOMPLETE_PROVIDER_MODELS.get(provider)

			const profiles = [
				{
					id: "1",
					name: "My Chat Profile",
					apiProvider: provider,
					profileType: "chat", // Not an autocomplete profile
				},
			] as any

			vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue(profiles)
			vi.mocked(mockProviderSettingsManager.getProfile).mockResolvedValue({
				id: "1",
				name: "My Chat Profile",
				apiProvider: provider,
				profileType: "chat",
				mistralApiKey: "test-key",
				apiModelId: "custom-chat-model", // This should be overridden
			} as any)

			// Mock buildApiHandler to return the overridden model
			const mockApiHandler = {
				getModel: vi.fn().mockReturnValue({ id: defaultAutocompleteModel, info: {} }),
				createMessage: vi.fn(),
				countTokens: vi.fn(),
			}
			vi.spyOn(apiIndex, "buildApiHandler").mockReturnValue(mockApiHandler as any)

			const model = new AutocompleteModel()
			await model.reload(mockProviderSettingsManager)

			// The model should be overridden with the default autocomplete model
			const modelName = model.getModelName()
			expect(modelName).toBe(defaultAutocompleteModel)
		})

		it("should override model for profiles without profileType", async () => {
			const supportedProviders = [...PERSONAL_AUTOCOMPLETE_PROVIDER_MODELS.keys()]
			const provider = supportedProviders[0]
			const defaultAutocompleteModel = PERSONAL_AUTOCOMPLETE_PROVIDER_MODELS.get(provider)

			const profiles = [
				{
					id: "1",
					name: "My Generic Profile",
					apiProvider: provider,
					// No profileType specified
				},
			] as any

			vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue(profiles)
			vi.mocked(mockProviderSettingsManager.getProfile).mockResolvedValue({
				id: "1",
				name: "My Generic Profile",
				apiProvider: provider,
				mistralApiKey: "test-key",
				apiModelId: "custom-model", // This should be overridden
			} as any)

			// Mock buildApiHandler to return the overridden model
			const mockApiHandler = {
				getModel: vi.fn().mockReturnValue({ id: defaultAutocompleteModel, info: {} }),
				createMessage: vi.fn(),
				countTokens: vi.fn(),
			}
			vi.spyOn(apiIndex, "buildApiHandler").mockReturnValue(mockApiHandler as any)

			const model = new AutocompleteModel()
			await model.reload(mockProviderSettingsManager)

			// The model should be overridden with the default autocomplete model
			const modelName = model.getModelName()
			expect(modelName).toBe(defaultAutocompleteModel)
		})
	})
})
