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

	describe("explicit current-provider model", () => {
		it("uses the selected OpenAI model without mutating chat settings or transport", async () => {
			vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue([])
			const profile = {
				id: "proxy",
				name: "Proxy",
				apiProvider: "openai" as const,
				openAiModelId: "chat-model",
				openAiBaseUrl: "https://example.test/v1",
				openAiApiKey: "test-key",
				openAiHeaders: { "X-Test": "value" },
				allowInsecureTls: true,
				reasoningEffort: "high" as const,
			}
			const build = vi.spyOn(apiIndex, "buildApiHandler")
			try {
				const model = new AutocompleteModel()
				expect(
					await model.reload(
						mockProviderSettingsManager,
						{
							useCurrentProvider: true,
							currentProviderModels: { proxy: { provider: "openai", modelId: "luna" } },
						},
						profile,
					),
				).toBe(true)
				expect(model.getModelName()).toBe("luna")
				expect(build).toHaveBeenLastCalledWith(
					expect.objectContaining({
						openAiModelId: "luna",
						openAiBaseUrl: profile.openAiBaseUrl,
						openAiApiKey: "test-key",
						openAiHeaders: profile.openAiHeaders,
						allowInsecureTls: true,
						reasoningEffort: undefined,
					}),
				)
				expect(profile.openAiModelId).toBe("chat-model")
				expect(profile.reasoningEffort).toBe("high")
			} finally {
				build.mockRestore()
			}
		})

		it("does not fall back when the current profile has no matching selection", async () => {
			vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue([])
			const model = new AutocompleteModel()
			for (const selection of [
				undefined,
				{ provider: "ollama", modelId: "luna" },
				{ provider: "openai", modelId: "  " },
			]) {
				expect(
					await model.reload(
						mockProviderSettingsManager,
						{ useCurrentProvider: true, currentProviderModels: selection ? { proxy: selection } : {} },
						{ id: "proxy", apiProvider: "openai", openAiModelId: "expensive-chat" },
					),
				).toBe(false)
				expect(model.hasValidCredentials()).toBe(false)
			}
		})
	})

	describe("text-only OpenAI completions", () => {
		it.each([true, false])("serializes Luna's request-local policy through the SDK (stream=%s)", async (stream) => {
			const { OpenAiHandler } = await import("../../../api/providers/openai")
			const { default: OpenAI } = await import("openai")
			const bodies: any[] = []
			const fetch = vi.fn(async (_url: unknown, init: any) => {
				const body = JSON.parse(init.body)
				bodies.push(body)
				const content = "<COMPLETION>value</COMPLETION>"
				return body.stream
					? new Response(
							`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
							{ headers: { "Content-Type": "text/event-stream" } },
						)
					: new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
							headers: { "Content-Type": "application/json" },
						})
			})
			for (const chatModel of ["1-gpt-luna", "1-gpt-astra"]) {
				vi.mocked(mockProviderSettingsManager.listConfig).mockResolvedValue([])
				const profile = {
					id: "proxy",
					apiProvider: "openai" as const,
					openAiModelId: chatModel,
					openAiBaseUrl: "https://prox.ivol.pro/v1",
					openAiApiKey: "test-key",
					openAiStreamingEnabled: stream,
					openAiWebSearchEnabled: true,
					includeMaxTokens: true,
					modelMaxTokens: 64_000,
					enableReasoningEffort: true,
					reasoningEffort: "high" as const,
					openAiCustomModelInfo: {
						maxTokens: 64_000,
						contextWindow: 400_000,
						supportsReasoningEffort: ["high" as const],
						supportsPromptCache: true,
					},
				}
				const original = structuredClone(profile)
				const model = new AutocompleteModel()
				await model.reload(mockProviderSettingsManager, {
					useCurrentProvider: true,
					currentProviderModels: { proxy: { provider: "openai", modelId: "1-gpt-luna" } },
				}, profile)
				// Keep the real SDK serialization and replace only its HTTP transport.
				const handler = (model as any).apiHandler as InstanceType<typeof OpenAiHandler>
				;(handler as any).client = new OpenAI({ apiKey: "test-key", baseURL: profile.openAiBaseUrl, fetch })
				const chunks: any[] = []
				await model.generateResponse("Complete code", "Fill hole", (chunk) => chunks.push(chunk))
				expect(bodies.at(-1)).toMatchObject({ model: "1-gpt-luna", reasoning_effort: "none", max_completion_tokens: 256 })
				for (const field of ["tools", "parallel_tool_calls", "verbosity", "max_tokens"]) {
					expect(bodies.at(-1)).not.toHaveProperty(field)
				}
				expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text).join("")).toBe("<COMPLETION>value</COMPLETION>")
				// A subsequent chat request on the very same handler must not inherit the override.
				for await (const chunk of handler.createMessage("Chat", [], { taskId: "chat", tool_choice: "none" })) void chunk
				expect(bodies.at(-1).max_completion_tokens).toBe(64_000)
				expect(bodies.at(-1).reasoning_effort).toBe(chatModel === "1-gpt-luna" ? "high" : undefined)
				const chat = new OpenAiHandler(profile)
				;(chat as any).client = new OpenAI({ apiKey: "test-key", baseURL: profile.openAiBaseUrl, fetch })
				for await (const chunk of chat.createMessage("Chat", [])) void chunk
				expect(bodies.at(-1)).toMatchObject({ model: chatModel, reasoning_effort: "high", max_completion_tokens: 64_000 })
				expect(bodies.at(-1).tools).not.toHaveLength(0)
				expect(profile).toEqual(original)
			}
			expect(fetch).toHaveBeenCalledTimes(6)
		})

		it.each([
			["https://example.test/v1", "1-gpt-luna"],
			["https://prox.ivol.pro.evil.test/v1", "1-gpt-luna"],
			["http://prox.ivol.pro/v1", "1-gpt-luna"],
			["https://prox.ivol.pro:444/v1", "1-gpt-luna"],
			["https://prox.ivol.pro/v1", "other-model"],
		])("does not apply Luna policy to other routes (%s, %s)", async (openAiBaseUrl, openAiModelId) => {
			const { OpenAiHandler } = await import("../../../api/providers/openai")
			const handler = new OpenAiHandler({ openAiBaseUrl, openAiModelId, openAiApiKey: "test-key" })
			const create = vi.fn().mockImplementation(async () => (async function* () { yield { choices: [{ delta: { content: "value" } }] } })())
			;(handler as any).client = { chat: { completions: { create } } }
			await new AutocompleteModel(handler).generateResponse("Complete", "Hole", () => {})
			expect(create.mock.calls[0][0]).toMatchObject({ max_completion_tokens: 64_000 })
			expect(create.mock.calls[0][0]).not.toHaveProperty("reasoning_effort")
		})

		it("does not advertise chat tools that autocomplete cannot execute", async () => {
			const { OpenAiHandler } = await import("../../../api/providers/openai")
			const handler = new OpenAiHandler({
				openAiModelId: "autocomplete-model",
				openAiApiKey: "test-key",
				openAiBaseUrl: "https://example.test/v1",
				openAiWebSearchEnabled: true,
				includeMaxTokens: false,
				enableReasoningEffort: true,
			})
			const create = vi.fn().mockImplementation(async () =>
				(async function* () {
					for (const content of ["<thi", "nk>synthetic reasoning</think>", "<COMPLETION>value</COMPLETION>"]) {
						yield { choices: [{ delta: { content } }] }
					}
					yield { choices: [{ delta: {}, finish_reason: "stop" }] }
				})(),
			)
				// Replace the SDK transport, never contact the configured endpoint.
				; (handler as any).client = { chat: { completions: { create } } }
			const chunks: any[] = []
			await new AutocompleteModel(handler).generateResponse("Complete code", "Fill hole", (chunk) =>
				chunks.push(chunk),
			)
			expect(create).toHaveBeenCalledTimes(1)
			const body = create.mock.calls[0][0]
			expect(body.max_completion_tokens).toBe(64_000)
			expect(body.temperature).toBe(0)
			expect(body).not.toHaveProperty("reasoning_effort")
			expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text).join("")).toBe(
				"<COMPLETION>value</COMPLETION>",
			)
			expect(body).not.toHaveProperty("tools")
			expect(body).not.toHaveProperty("parallel_tool_calls")
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
