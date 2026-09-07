import { fireEvent, render, screen, within } from "@/utils/test-utils"
import type { ModelInfo, ProviderSettings } from "@roo-code/types"
import { vscode } from "@/utils/vscode"
import { ReasoningEffortSelector } from "../ReasoningEffortSelector"

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

describe("ReasoningEffortSelector", () => {
	beforeEach(() => vi.clearAllMocks())

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
