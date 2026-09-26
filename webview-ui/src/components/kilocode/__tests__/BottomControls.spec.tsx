import { cleanup, render, screen } from "@testing-library/react"
import type { ProviderSettings } from "@roo-code/types"

import { useExtensionState, type ExtensionStateContextType } from "@/context/ExtensionStateContext"
import { StandaloneWebSearch } from "@/components/chat/StandaloneWebSearch"
import BottomControls from "../BottomControls"

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: vi.fn() }))
vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("../rules/KiloRulesToggleModal", () => ({ default: () => <button>Rules</button> }))
vi.mock("../BottomApiConfig", () => ({ BottomApiConfig: () => <button>Model and reasoning</button> }))
vi.mock("@/components/chat/StandaloneWebSearch", () => ({
	StandaloneWebSearch: vi.fn(() => <button>Search the web</button>),
}))
vi.mock("@/components/chat/AutoApproveMenu", () => ({
	default: ({ compact }: { compact?: boolean }) => (
		<button>{compact ? "Auto approval" : "Full approval menu"}</button>
	),
}))

describe("BottomControls standalone search", () => {
	const apiConfiguration: ProviderSettings = { apiProvider: "openai", openAiModelId: "coding-model" }
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(useExtensionState).mockReturnValue({
			apiConfiguration,
			currentApiConfigName: "Saved profile",
		} as ExtensionStateContextType)
	})
	afterEach(cleanup)

	it.each([true, false])("keeps the search button available with showApiConfig=%s", (showApiConfig) => {
		render(<BottomControls showApiConfig={showApiConfig} />)
		expect(screen.getByRole("button", { name: "Search the web" })).toBeEnabled()
		expect(vi.mocked(StandaloneWebSearch).mock.lastCall?.[0]).toEqual({
			apiConfiguration,
			currentApiConfigName: "Saved profile",
		})
	})

	it.each([true, false, undefined])(
		"keeps auto approval visible with legacy visibility=%s",
		(showAutoApproveMenu) => {
			vi.mocked(useExtensionState).mockReturnValue({
				apiConfiguration,
				showAutoApproveMenu,
			} as ExtensionStateContextType)
			render(<BottomControls showApiConfig />)
			const buttons = screen.getAllByRole("button")
			const index = buttons.indexOf(screen.getByRole("button", { name: "Auto approval" }))
			expect(buttons[index + 1]).toHaveTextContent("Search the web")
			expect(screen.queryByText("Full approval menu")).not.toBeInTheDocument()
		},
	)

	it("places the compact search control before rules without removing model and reasoning controls", () => {
		render(<BottomControls showApiConfig />)
		const buttons = screen.getAllByRole("button")
		expect(buttons[0]).toHaveTextContent("Model and reasoning")
		expect(buttons[1]).toHaveTextContent("Auto approval")
		expect(buttons[2]).toHaveTextContent("Search the web")
		expect(buttons[3]).toHaveTextContent("Rules")
		expect(screen.getByRole("button", { name: "Search the web" }).parentElement?.parentElement).toHaveClass(
			"shrink-0",
		)
	})
})
