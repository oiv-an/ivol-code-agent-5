// kilocode_change - new file
import { act, fireEvent, render, screen } from "@testing-library/react"
import { vscode } from "@src/utils/vscode"
import { TelegramSettings } from "../TelegramSettings"
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
function lastRequestId() {
	const message = vi.mocked(vscode.postMessage).mock.calls.at(-1)![0]
	if (!("telegramSettings" in message) || !message.telegramSettings) throw new Error("Expected save request")
	return message.telegramSettings.requestId
}
function ack(requestId: string, success = true) {
	act(() =>
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "telegramSettingsSaved", telegramRequestId: requestId, telegramSettingsSaved: success },
			}),
		),
	)
}
beforeEach(() => vi.clearAllMocks())
it("ignores acknowledgements from another view or earlier mount and preserves failed inputs", () => {
	const first = render(<TelegramSettings />)
	fireEvent.change(screen.getByLabelText("settings:telegram.token"), { target: { value: "123:fixture" } })
	fireEvent.change(screen.getByLabelText("settings:telegram.ownerId"), { target: { value: "123" } })
	fireEvent.click(screen.getByText("settings:telegram.save"))
	const old = lastRequestId()
	ack("unrelated")
	expect(screen.getByText("settings:telegram.save")).toBeDisabled()
	first.unmount()
	render(<TelegramSettings />)
	fireEvent.change(screen.getByLabelText("settings:telegram.token"), { target: { value: "456:fixture" } })
	fireEvent.change(screen.getByLabelText("settings:telegram.ownerId"), { target: { value: "456" } })
	fireEvent.click(screen.getByText("settings:telegram.save"))
	const current = lastRequestId()
	expect(current).not.toBe(old)
	ack(old)
	expect(screen.getByText("settings:telegram.save")).toBeDisabled()
	ack(current, false)
	expect(screen.getByText("settings:telegram.save")).not.toBeDisabled()
	expect(screen.getByLabelText("settings:telegram.token")).toHaveValue("456:fixture")
	fireEvent.click(screen.getByText("settings:telegram.save"))
	ack(lastRequestId())
	expect(screen.getByLabelText("settings:telegram.token")).toHaveValue("")
})
