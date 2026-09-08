// kilocode_change - new file
import { act, cleanup, fireEvent, render, screen } from "@/utils/test-utils"
import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"
import AutoApproveMenu from "../AutoApproveMenu"
import { AutoApproveDropdown } from "../AutoApproveDropdown"
import { AutoApproveSettings } from "../../settings/AutoApproveSettings"

const { state } = vi.hoisted(() => ({ state: {} as Partial<ExtensionStateContextType> }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("react-i18next", () => ({ Trans: () => null, useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, checked, ...props }: any) => (
		<label>
			<input type="checkbox" checked={checked ?? false} {...props} />
			{children}
		</label>
	),
	VSCodeLink: ({ children, ...props }: any) => <a {...props}>{children}</a>,
	VSCodeTextField: (props: any) => <input {...props} />,
}))

describe("YOLO timer entry points", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-09-07T12:00:00Z"))
		Object.keys(state).forEach((key) => delete state[key as keyof ExtensionStateContextType])
		state.yoloMode = true
		state.yoloModeExpiresAt = Date.now() + 60000
		state.autoApprovalEnabled = false
		state.setAutoApprovalEnabled = vi.fn()
		vi.clearAllMocks()
	})
	afterEach(() => {
		cleanup()
		vi.useRealTimers()
	})

	it("shows YOLO and an enabled master checkbox with ordinary approvals off in the chat menu", () => {
		render(<AutoApproveMenu />)
		expect(screen.getByText("settings:yoloTimer.statusShort")).toBeVisible()
		const master = screen.getByRole("checkbox", { name: "chat:autoApprove.toggleAriaLabel" })
		expect(master).toBeChecked()
		expect(master).toBeEnabled()
		fireEvent.click(master)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "yoloMode", bool: false })
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "autoApprovalEnabled", bool: false })
	})

	it("shows controls when the chat menu is expanded and removes its per-second countdown when collapsed", () => {
		render(<AutoApproveMenu />)
		expect(screen.queryByTestId("yolo-mode-controls")).not.toBeInTheDocument()
		fireEvent.click(screen.getByText("chat:autoApprove.title"))
		expect(screen.getByTestId("yolo-mode-controls")).toBeVisible()
		fireEvent.click(screen.getByText("chat:autoApprove.title"))
		expect(screen.queryByTestId("yolo-mode-controls")).not.toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("restores the chat menu to ordinary off when the lease expires", () => {
		render(<AutoApproveMenu />)
		act(() => vi.advanceTimersByTime(60000))
		expect(screen.queryByText("settings:yoloTimer.statusShort")).not.toBeInTheDocument()
		expect(screen.getByRole("checkbox")).not.toBeChecked()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("shows YOLO in the compact dropdown even when no ordinary categories are enabled", () => {
		render(<AutoApproveDropdown />)
		expect(screen.getByTestId("auto-approve-dropdown-trigger")).toHaveTextContent("settings:yoloTimer.statusShort")
		fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))
		expect(screen.getByTestId("yolo-mode-controls")).toBeVisible()
		expect(screen.getByRole("switch")).toBeChecked()
		fireEvent.click(screen.getByRole("switch"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "yoloMode", bool: false })
	})

	it("restores the compact dropdown label after expiry", () => {
		render(<AutoApproveDropdown />)
		act(() => vi.advanceTimersByTime(60000))
		expect(screen.getByTestId("auto-approve-dropdown-trigger")).toHaveTextContent(
			"chat:autoApprove.triggerLabelOff",
		)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("uses live controls in Settings, with no staged YOLO permission edits", () => {
		const setCachedStateField = vi.fn()
		render(<AutoApproveSettings setCachedStateField={setCachedStateField} />)
		expect(screen.getByTestId("yolo-mode-controls")).toBeVisible()
		expect(screen.getByText("settings:yoloTimer.activeOverride")).toBeVisible()
		fireEvent.click(screen.getByText("settings:yoloTimer.stop"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "yoloMode", bool: false })
		expect(setCachedStateField).not.toHaveBeenCalled()
	})
})
