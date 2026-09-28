// kilocode_change - new file
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { TelegramState } from "@roo-code/types"
import { vscode } from "@src/utils/vscode"
import { TelegramButton } from "../TelegramButton"

const context = vi.hoisted(() => ({ currentTaskId: "root" }))
vi.mock("@src/context/ExtensionStateContext", () => ({ useExtensionState: () => context }))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@src/components/ui", async (original) => ({
	...(await original<object>()),
	StandardTooltip: ({ children, content }: { children: React.ReactNode; content: string }) => (
		<div title={content}>{children}</div>
	),
}))
function state(value: Partial<TelegramState>) {
	act(() =>
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "telegramState", telegramState: { configured: true, status: "inactive", ...value } },
			}),
		),
	)
}
const button = () => screen.getByRole("button")
beforeEach(() => {
	vi.clearAllMocks()
	context.currentTaskId = "root"
})

it("uses visible green background/border/white icon only after confirmation and toggles off", () => {
	render(<TelegramButton />)
	state({})
	fireEvent.click(button())
	fireEvent.click(button())
	expect(vi.mocked(vscode.postMessage).mock.calls.filter(([m]) => m.type === "activateTelegram")).toHaveLength(1)
	expect(button()).toHaveAttribute("aria-pressed", "false")
	state({ status: "active", taskId: "root", rootTaskId: "root" })
	expect(button()).toHaveClass("bg-green-700", "border-green-400", "text-white", "hover:text-white")
	expect(button()).toHaveAttribute("aria-pressed", "true")
	expect(button()).toHaveAccessibleName("settings:telegram.active")
	fireEvent.click(button(), { detail: 2 })
	expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "deactivateTelegram" }))
	fireEvent.click(button())
	fireEvent.click(button())
	expect(vi.mocked(vscode.postMessage).mock.calls.filter(([m]) => m.type === "deactivateTelegram")).toHaveLength(1)
	state({})
	expect(button()).not.toHaveClass("bg-green-700")
	expect(button()).toHaveAttribute("aria-pressed", "false")
	expect(button()).toHaveAccessibleName("settings:telegram.activate")
})
it("allows cancellation during connection and handoff even without a focused task", () => {
	context.currentTaskId = ""
	render(<TelegramButton />)
	state({ status: "connecting", taskId: "child", rootTaskId: "root" })
	expect(button()).not.toBeDisabled()
	expect(button()).toHaveAttribute("aria-busy", "true")
	expect(button()).not.toHaveClass("bg-green-700")
	fireEvent.click(button())
	expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "deactivateTelegram", telegramTaskId: "root" })
	state({ status: "error", error: "Connection failed" })
	expect(button()).toHaveAttribute("aria-pressed", "false")
})
it("does not retain another task's green or infer active from a shared root; refreshes on remount", () => {
	const view = render(<TelegramButton />)
	state({ status: "active", taskId: "root", rootTaskId: "root" })
	context.currentTaskId = "child"
	view.rerender(<TelegramButton />)
	expect(button()).not.toHaveClass("bg-green-700")
	state({ status: "active", taskId: "root", rootTaskId: "root" })
	expect(button()).toHaveAttribute("aria-pressed", "false")
	state({ status: "connecting", taskId: "child", rootTaskId: "root" })
	expect(button()).not.toBeDisabled()
	state({ status: "active", taskId: "child", rootTaskId: "root" })
	expect(button()).toHaveClass("bg-green-700")
	view.unmount()
	state({ status: "active", taskId: "child" })
	render(<TelegramButton />)
	expect(button()).not.toHaveClass("bg-green-700")
	expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "getTelegramState" })
	state({ status: "error", error: "Connection failed" })
	expect(button()).not.toBeDisabled()
	fireEvent.click(button())
	expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "activateTelegram", telegramTaskId: "child" })
})
