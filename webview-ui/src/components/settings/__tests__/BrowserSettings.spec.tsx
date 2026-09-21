// kilocode_change - new file
import React from "react"
import { fireEvent, render, screen, cleanup } from "@testing-library/react"
import type { McpServer } from "@roo-code/types"
import { BrowserSettings } from "../BrowserSettings"

const state = vi.hoisted(() => ({ servers: [] as McpServer[], postMessage: vi.fn() }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ mcpServers: state.servers }) }))
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: state.postMessage } }))
vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("react-i18next", () => ({ Trans: () => null }))
vi.mock("../SearchableSetting", () => ({ SearchableSetting: ({ children }: any) => <div>{children}</div> }))
vi.mock("../Section", () => ({ Section: ({ children }: any) => <div>{children}</div> }))
vi.mock("../SectionHeader", () => ({ SectionHeader: ({ children }: any) => <div>{children}</div> }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: () => null,
	VSCodeTextField: () => null,
	VSCodeLink: () => null,
}))
vi.mock("@/components/ui", () => ({
	Select: ({ value, onValueChange, children }: any) => (
		<select value={value} onChange={(event) => onValueChange(event.target.value)}>
			{children}
		</select>
	),
	SelectContent: ({ children }: any) => <>{children}</>,
	SelectGroup: ({ children }: any) => <>{children}</>,
	SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
	SelectTrigger: () => null,
	SelectValue: () => null,
	Slider: () => null,
	Button: ({ children, onClick, disabled }: any) => (
		<button onClick={onClick} disabled={disabled}>
			{children}
		</button>
	),
}))

beforeEach(() => {
	state.servers = []
	state.postMessage.mockClear()
})
afterEach(cleanup)

it("requests browser launch without granting access and unlocks after cancellation", () => {
	render(<BrowserSettings browserMode="chrome-extension" setCachedStateField={vi.fn()} />)
	const button = screen.getByText("settings:browser.personal.launch")
	fireEvent.click(button)
	expect(state.postMessage).toHaveBeenCalledTimes(2)
	expect(state.postMessage).toHaveBeenNthCalledWith(1, { type: "chromeControl", text: "status" })
	expect(state.postMessage).toHaveBeenCalledWith({ type: "launchPersonalBrowser", text: "chrome-extension" })
	expect(button).toBeDisabled()
	fireEvent(
		window,
		new MessageEvent("message", {
			data: { type: "personalBrowserLaunchResult", success: true, text: "cancelled" },
		}),
	)
	expect(button).not.toBeDisabled()
})

it("sends Chrome pause and resume only after explicit button clicks", () => {
	render(<BrowserSettings browserMode="chrome-extension" setCachedStateField={vi.fn()} />)
	expect(state.postMessage).toHaveBeenCalledTimes(1)
	fireEvent.click(screen.getByText("settings:browser.personal.pause"))
	expect(state.postMessage).toHaveBeenLastCalledWith({ type: "chromeControl", text: "pause" })
	fireEvent.click(screen.getByText("settings:browser.personal.resume"))
	expect(state.postMessage).toHaveBeenLastCalledWith({ type: "chromeControl", text: "resume" })
})

it("requests automatic setup without opening configuration or granting page access", () => {
	render(<BrowserSettings browserMode="browseros" setCachedStateField={vi.fn()} />)
	const button = screen.getByText("settings:browser.personal.connectAndGrant")
	fireEvent.click(button)
	expect(button).toBeDisabled()
	expect(state.postMessage).toHaveBeenCalledTimes(2)
	expect(state.postMessage).toHaveBeenNthCalledWith(1, { type: "browserOSAccess", text: "status" })
	expect(state.postMessage).toHaveBeenCalledWith({
		type: "browserOSAccess",
		text: "connectAndGrant",
		values: { allowTaskActions: false },
		serverName: undefined,
		source: undefined,
	})
	fireEvent(
		window,
		new MessageEvent("message", {
			data: { type: "browserOSAccessResult", success: false, text: "Browser unavailable" },
		}),
	)
	expect(button).not.toBeDisabled()
	expect(screen.getByRole("alert")).toHaveTextContent("Browser unavailable")
})

it("removes the connected endpoint indicator when the server disconnects", () => {
	state.servers = [{ name: "browseros-neo", config: '{"url":"http://127.0.0.1:9010/mcp"}', status: "connected" }]
	const { rerender } = render(<BrowserSettings browserMode="browseros" setCachedStateField={vi.fn()} />)
	expect(screen.getByText("settings:browser.personal.endpoint")).toBeInTheDocument()
	state.servers = [{ ...state.servers[0], status: "disconnected" }]
	rerender(<BrowserSettings browserMode="browseros" setCachedStateField={vi.fn()} />)
	expect(screen.queryByText("settings:browser.personal.endpoint")).not.toBeInTheDocument()
})

it("stores the checkbox choice as a setting and revokes an older grant when changed", () => {
	const setCachedStateField = vi.fn()
	render(<BrowserSettings browserMode="browseros" setCachedStateField={setCachedStateField} />)
	const checkbox = screen.getByRole("checkbox", { name: "settings:browser.personal.allowTaskActions" })
	expect(checkbox).not.toBeChecked()
	fireEvent.click(checkbox)
	expect(setCachedStateField).toHaveBeenCalledWith("browserOSAllowTaskActions", true)
	expect(state.postMessage).toHaveBeenLastCalledWith({ type: "browserOSAccess", text: "revoke" })
})

it("keeps a remembered choice after the panel is reopened and forwards it", () => {
	const setCachedStateField = vi.fn()
	render(
		<BrowserSettings browserMode="browseros" browserOSAllowTaskActions setCachedStateField={setCachedStateField} />,
	)
	const checkbox = screen.getByRole("checkbox", { name: "settings:browser.personal.allowTaskActions" })
	expect(checkbox).toBeChecked()
	fireEvent.click(screen.getByText("settings:browser.personal.connectAndGrant"))
	expect(state.postMessage).toHaveBeenLastCalledWith(
		expect.objectContaining({ text: "connectAndGrant", values: { allowTaskActions: true } }),
	)
	fireEvent.click(checkbox)
	expect(setCachedStateField).toHaveBeenCalledWith("browserOSAllowTaskActions", false)
})

it("does not report an active permission just because the choice is remembered", () => {
	render(<BrowserSettings browserMode="browseros" browserOSAllowTaskActions setCachedStateField={vi.fn()} />)
	expect(screen.getByRole("status")).toHaveTextContent("settings:browser.personal.status")
	expect(state.postMessage).toHaveBeenCalledTimes(1)
	expect(state.postMessage).toHaveBeenCalledWith({ type: "browserOSAccess", text: "status" })
})

it("shows one primary action instead of three setup buttons", () => {
	render(<BrowserSettings browserMode="browseros" setCachedStateField={vi.fn()} />)
	expect(screen.queryByText("settings:browser.personal.grant")).not.toBeInTheDocument()
	expect(screen.queryByText("settings:browser.personal.launch")).not.toBeInTheDocument()
	expect(screen.queryByText("settings:browser.personal.autoConnect")).not.toBeInTheDocument()
	expect(screen.getByText("settings:browser.personal.connectAndGrant")).toBeEnabled()
})

it("selects protected connections, revokes on change and forwards the selected source", () => {
	state.servers = [
		{ name: "browseros-neo", source: "global", config: "{}", status: "connected" },
		{ name: "work-browser", source: "project", config: '{"browserOS":true}', status: "connected" },
		{ name: "ordinary", config: "{}", status: "connected" },
	]
	render(<BrowserSettings browserMode="browseros" setCachedStateField={vi.fn()} />)
	expect(screen.queryByText("ordinary (global)")).not.toBeInTheDocument()
	fireEvent.click(screen.getByText("settings:browser.personal.advanced"))
	const selectors = screen.getAllByRole("combobox")
	fireEvent.change(selectors[1], { target: { value: JSON.stringify(["work-browser", "project"]) } })
	expect(state.postMessage).toHaveBeenLastCalledWith({ type: "browserOSAccess", text: "revoke" })
	fireEvent.click(screen.getByText("settings:browser.personal.connectAndGrant"))
	expect(state.postMessage).toHaveBeenLastCalledWith({
		type: "browserOSAccess",
		text: "connectAndGrant",
		values: { allowTaskActions: false },
		serverName: "work-browser",
		source: "project",
	})
})

it("keeps the primary action busy through permission while allowing cancellation", () => {
	render(<BrowserSettings browserMode="browseros" setCachedStateField={vi.fn()} />)
	fireEvent(
		window,
		new MessageEvent("message", {
			data: {
				type: "browserOSAccessResult",
				success: true,
				text: "idle",
				values: { stage: "permission", busy: true },
			},
		}),
	)
	expect(screen.getByText("settings:browser.personal.connectAndGrant")).toBeDisabled()
	expect(screen.getByText("settings:browser.personal.revoke")).toBeEnabled()
	expect(screen.getByText("settings:browser.personal.stages.permission")).toBeInTheDocument()
})
