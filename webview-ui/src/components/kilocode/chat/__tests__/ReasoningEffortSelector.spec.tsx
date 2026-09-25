import { fireEvent, render, screen, within } from "@/utils/test-utils"
import type { ModelInfo, ProviderSettings } from "@roo-code/types"
import { vscode } from "@/utils/vscode"
import { ReasoningEffortSelector } from "../ReasoningEffortSelector"
import { applyModelPreset, ModelPresetSelector, ModelPresetsSettings } from "../ModelPresets"
import { discriminatedProviderSettingsWithIdSchema } from "@roo-code/types"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))

const info: ModelInfo = { contextWindow: 370000, supportsPromptCache: true, supportsReasoningEffort: true }
const config: ProviderSettings = {
	apiProvider: "openai",
	openAiBaseUrl: "https://provider.example/v1",
	openAiApiKey: "test-key",
	openAiModelId: "test-model",
	enableReasoningEffort: true,
	reasoningEffort: "high",
	openAiCustomModelInfo: { ...info, reasoningEffort: "high" },
}
const effortLabel = (effort: string) => `settings:providers.reasoningEffort.${effort}`
const mount = (configuration = config, modelInfo: ModelInfo | undefined = info) =>
	render(
		<ReasoningEffortSelector
			currentApiConfigName="proxy-profile"
			apiConfiguration={configuration}
			modelInfo={modelInfo}
		/>,
	)
const choose = async (label: string) => {
	fireEvent.click(screen.getByTestId("dropdown-trigger"))
	const option = await screen.findByText(label, { selector: '[data-testid="dropdown-item"] *' })
	fireEvent.click(option.closest('[data-testid="dropdown-item"]') ?? option)
}

vi.mock("../../hooks/useProviderModels", () => ({
	useProviderModels: () => ({
		providerModels: { "test-model": { contextWindow: 128000, supportsReasoningEffort: true } },
	}),
}))

describe("ReasoningEffortSelector", () => {
	beforeEach(() => vi.clearAllMocks())

	it("shows three inline buttons and highlights the current pair in green", () => {
		const configuration: ProviderSettings = {
			...config,
			modelPresets: {
				max: { modelId: "test-model", reasoningEffort: "high", enableReasoningEffort: true },
				med: { modelId: "test-model", reasoningEffort: "low", enableReasoningEffort: true },
			},
		}
		const { rerender } = render(<ModelPresetSelector configuration={configuration} profileName="profile" />)
		expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["MAX", "MED", "MIN"])
		expect(screen.getByRole("button", { name: "MAX" })).toHaveAttribute("aria-pressed", "true")
		expect(screen.getByRole("button", { name: "MAX" })).toHaveClass("text-green-400")
		expect(screen.getByRole("button", { name: "MIN" })).toBeDisabled()
		fireEvent.click(screen.getByRole("button", { name: "MAX" }))
		expect(vscode.postMessage).not.toHaveBeenCalled()
		rerender(
			<ModelPresetSelector configuration={{ ...configuration, reasoningEffort: "low" }} profileName="profile" />,
		)
		expect(screen.getByRole("button", { name: "MED" })).toHaveAttribute("aria-pressed", "true")
		expect(screen.getByRole("button", { name: "MAX" })).toHaveAttribute("aria-pressed", "false")
	})

	it("keeps preset model and reasoning menus visible when the chat portal is hidden", async () => {
		const hiddenChat = document.createElement("div")
		hiddenChat.id = "roo-portal"
		hiddenChat.style.display = "none"
		document.body.append(hiddenChat)
		const onChange = vi.fn()
		try {
			const { rerender } = render(<ModelPresetsSettings configuration={config} onChange={onChange} />)
			fireEvent.click(screen.getAllByTestId("dropdown-trigger")[0])
			const model = await screen.findByText("test-model", { selector: '[data-testid="dropdown-item"] *' })
			expect(model).toBeVisible()
			expect(hiddenChat.contains(model)).toBe(false)
			fireEvent.click(model)
			expect(onChange).toHaveBeenCalledWith({ max: { modelId: "test-model" } })
			rerender(
				<ModelPresetsSettings
					configuration={{ ...config, modelPresets: { max: { modelId: "test-model" } } }}
					onChange={onChange}
				/>,
			)
			fireEvent.click(within(screen.getByTestId("reasoning-effort-selector")).getByTestId("dropdown-trigger"))
			const effort = await screen.findByText(effortLabel("low"), { selector: '[data-testid="dropdown-item"] *' })
			expect(effort).toBeVisible()
			expect(hiddenChat.contains(effort)).toBe(false)
			fireEvent.click(effort)
			expect(onChange).toHaveBeenLastCalledWith({
				max: { modelId: "test-model", reasoningEffort: "low", enableReasoningEffort: true },
			})
			expect(vscode.postMessage).not.toHaveBeenCalled()
		} finally {
			hiddenChat.remove()
		}
	})

	it("edits preset reasoning locally without changing the active profile", async () => {
		const onConfigurationChange = vi.fn()
		render(
			<ReasoningEffortSelector
				currentApiConfigName="draft"
				apiConfiguration={config}
				modelInfo={info}
				onConfigurationChange={onConfigurationChange}
			/>,
		)
		await choose(effortLabel("low"))
		expect(onConfigurationChange).toHaveBeenCalledWith(
			expect.objectContaining({ reasoningEffort: "low", enableReasoningEffort: true }),
		)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("applies model and reasoning together only after a manual preset selection", async () => {
		const configuration: ProviderSettings = {
			...config,
			modelPresets: { min: { modelId: "small-model", reasoningEffort: "disable", enableReasoningEffort: false } },
		}
		render(<ModelPresetSelector configuration={configuration} profileName="proxy-profile" />)
		expect(vscode.postMessage).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "MIN" }))
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "upsertApiConfiguration",
			text: "proxy-profile",
			apiConfiguration: expect.objectContaining({
				openAiModelId: "small-model",
				reasoningEffort: "disable",
				enableReasoningEffort: false,
				openAiApiKey: "test-key",
				openAiBaseUrl: config.openAiBaseUrl,
			}),
		})
		const message = vi.mocked(vscode.postMessage).mock.calls[0][0]
		if (!("apiConfiguration" in message) || !message.apiConfiguration) throw new Error("Missing profile update")
		const updated = message.apiConfiguration
		expect(updated.openAiCustomModelInfo?.reasoningEffort).toBeUndefined()
		expect(configuration.openAiModelId).toBe("test-model")
		expect(discriminatedProviderSettingsWithIdSchema.parse(updated)).toMatchObject({
			modelPresets: configuration.modelPresets,
		})
	})

	it("does not change other settings when applying a preset", () => {
		const updated = applyModelPreset(
			{ ...config, modelMaxThinkingTokens: 6000 },
			{ modelId: "other", reasoningEffort: "low", enableReasoningEffort: true },
		)
		expect(updated.modelMaxThinkingTokens).toBe(6000)
		expect(updated.openAiCustomModelInfo?.reasoningEffort).toBe("low")
		expect(updated.openAiApiKey).toBe(config.openAiApiKey)
	})

	it("reads the custom-provider setting without changing the profile on mount", () => {
		mount()
		expect(screen.getByTestId("dropdown-trigger")).toHaveTextContent(effortLabel("high"))
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it.each(["openai", "openai-responses"] as const)(
		"updates both %s settings while preserving the provider and model",
		async (apiProvider) => {
			const initial = { ...config, apiProvider }
			mount(initial)
			await choose(effortLabel("max"))
			expect(vscode.postMessage).toHaveBeenCalledTimes(1)
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "upsertApiConfiguration",
				text: "proxy-profile",
				apiConfiguration: {
					...initial,
					reasoningEffort: "max",
					enableReasoningEffort: true,
					openAiCustomModelInfo: { ...info, reasoningEffort: "max" },
				},
			})
		},
	)

	it.each(["openai", "openai-responses", "openai-native", "openai-codex"] as const)(
		"enables and saves literal ultra for %s",
		async (apiProvider) => {
			mount({ ...config, apiProvider, enableReasoningEffort: false })
			await choose(effortLabel("ultra"))
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					apiConfiguration: expect.objectContaining({
						apiProvider,
						enableReasoningEffort: true,
						reasoningEffort: "ultra",
						...(["openai", "openai-responses"].includes(apiProvider)
							? { openAiCustomModelInfo: expect.objectContaining({ reasoningEffort: "ultra" }) }
							: {}),
					}),
				}),
			)
		},
	)

	it("clears the custom model's effort when disabling it", async () => {
		mount()
		await choose(effortLabel("none"))
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				apiConfiguration: {
					...config,
					reasoningEffort: "disable",
					enableReasoningEffort: false,
					openAiCustomModelInfo: info,
				},
			}),
		)
	})

	it("allows custom OpenAI effort selection without a capability catalog", async () => {
		mount(
			{ ...config, openAiCustomModelInfo: undefined, reasoningEffort: undefined, enableReasoningEffort: false },
			{ contextWindow: 128000, supportsPromptCache: true },
		)
		await choose(effortLabel("low"))
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				apiConfiguration: expect.objectContaining({
					enableReasoningEffort: true,
					reasoningEffort: "low",
					openAiCustomModelInfo: expect.objectContaining({ reasoningEffort: "low", contextWindow: 128000 }),
				}),
			}),
		)
	})

	it("respects the explicit off switch even if an old effort is stored", () => {
		mount({ ...config, enableReasoningEffort: false })
		expect(screen.getByTestId("dropdown-trigger")).toHaveTextContent(effortLabel("none"))
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("uses required model defaults and does not offer disable", async () => {
		mount({ apiProvider: "openai-codex" }, { ...info, requiredReasoningEffort: true, reasoningEffort: "medium" })
		expect(screen.getByTestId("dropdown-trigger")).toHaveTextContent(effortLabel("medium"))
		fireEvent.click(screen.getByTestId("dropdown-trigger"))
		expect(screen.queryByText(effortLabel("none"))).not.toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("respects declared levels and keeps max as a preference for the existing API fallback", async () => {
		mount(
			{ apiProvider: "openai-codex", reasoningEffort: "low" },
			{ ...info, supportsReasoningEffort: ["none", "low", "high"] },
		)
		fireEvent.click(screen.getByTestId("dropdown-trigger"))
		expect(screen.queryByText(effortLabel("xhigh"))).not.toBeInTheDocument()
		expect(screen.queryByText(effortLabel("medium"))).not.toBeInTheDocument()
		fireEvent.click(screen.getByText(effortLabel("max")))
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				apiConfiguration: {
					apiProvider: "openai-codex",
					reasoningEffort: "max",
					enableReasoningEffort: true,
				},
			}),
		)
	})

	it("distinguishes API none from omitting reasoning", async () => {
		mount(
			{ apiProvider: "openai-codex", reasoningEffort: "high" },
			{ ...info, supportsReasoningEffort: ["none", "high"] },
		)
		await choose(effortLabel("none"))
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				apiConfiguration: {
					apiProvider: "openai-codex",
					reasoningEffort: "none",
					enableReasoningEffort: true,
				},
			}),
		)
	})

	it.each([undefined, { ...info, supportsReasoningEffort: false }, { ...info, supportsReasoningEffort: [] }])(
		"hides effort controls for models without an effort capability: %s",
		(modelInfo) => {
			render(
				<ReasoningEffortSelector
					currentApiConfigName="profile"
					apiConfiguration={{ apiProvider: "lmstudio" }}
					modelInfo={modelInfo}
				/>,
			)
			expect(screen.queryByTestId("reasoning-effort-selector")).not.toBeInTheDocument()
		},
	)

	it.each([
		{ currentApiConfigName: undefined, apiConfiguration: config },
		{ currentApiConfigName: "profile", apiConfiguration: { ...config, profileType: "autocomplete" as const } },
		{ currentApiConfigName: "profile", apiConfiguration: { apiProvider: "virtual-quota-fallback" as const } },
	])("does not edit missing or non-chat profiles: %s", (props) => {
		render(<ReasoningEffortSelector {...props} modelInfo={info} />)
		expect(screen.queryByTestId("reasoning-effort-selector")).not.toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("shows binary reasoning's default and preserves budget settings on toggle", async () => {
		const initial: ProviderSettings = {
			apiProvider: "anthropic",
			modelMaxThinkingTokens: 8192,
			modelMaxTokens: 16000,
		}
		mount(initial, { ...info, supportsReasoningBinary: true })
		expect(screen.getByTestId("dropdown-trigger")).toHaveTextContent("common:answers.yes")
		await choose("common:answers.no")
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				apiConfiguration: { ...initial, enableReasoningEffort: false },
			}),
		)
	})

	it("toggles a token-budget model without inventing effort levels", async () => {
		mount(
			{ apiProvider: "anthropic", modelMaxThinkingTokens: 8192 },
			{ ...info, supportsReasoningBudget: true, maxTokens: 16000 },
		)
		await choose("common:answers.yes")
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				apiConfiguration: {
					apiProvider: "anthropic",
					modelMaxThinkingTokens: 8192,
					enableReasoningEffort: true,
				},
			}),
		)
	})

	it("cannot disable a required reasoning budget", () => {
		mount(
			{ apiProvider: "anthropic" },
			{ ...info, supportsReasoningBudget: true, requiredReasoningBudget: true, maxTokens: 16000 },
		)
		expect(screen.getByTestId("dropdown-trigger")).toBeDisabled()
		expect(screen.getByTestId("dropdown-trigger")).toHaveTextContent("common:answers.yes")
	})

	it("shows the model's actual default effort without writing on mount", () => {
		mount({ apiProvider: "claude-code" }, { ...info, reasoningEffort: "medium" })
		expect(screen.getByTestId("dropdown-trigger")).toHaveTextContent(effortLabel("medium"))
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("does not show a stale disable preference for required reasoning", () => {
		mount(
			{ apiProvider: "openai-codex", reasoningEffort: "disable" },
			{ ...info, requiredReasoningEffort: true, reasoningEffort: "medium" },
		)
		expect(screen.getByTestId("dropdown-trigger")).toHaveTextContent(effortLabel("medium"))
	})

	it("removes a legacy disable sentinel when re-enabling binary reasoning", async () => {
		mount(
			{ apiProvider: "lmstudio", enableReasoningEffort: false, reasoningEffort: "disable" },
			{ ...info, supportsReasoningBinary: true },
		)
		await choose("common:answers.yes")
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				apiConfiguration: {
					apiProvider: "lmstudio",
					enableReasoningEffort: true,
					reasoningEffort: undefined,
				},
			}),
		)
	})

	it("refreshes the level and closes the menu when switching profiles", async () => {
		const { rerender } = mount()
		fireEvent.click(screen.getByTestId("dropdown-trigger"))
		rerender(
			<ReasoningEffortSelector
				currentApiConfigName="second-profile"
				apiConfiguration={{ apiProvider: "openai-codex", reasoningEffort: "low" }}
				modelInfo={info}
			/>,
		)
		expect(screen.queryByTestId("dropdown-item")).not.toBeInTheDocument()
		expect(
			within(screen.getByTestId("reasoning-effort-selector")).getByTestId("dropdown-trigger"),
		).toHaveTextContent(effortLabel("low"))
		await choose(effortLabel("max"))
		expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "second-profile" }))
	})
})
