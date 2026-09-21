import { browserActions } from "@roo-code/types"
// kilocode_change start
import { browserActionTool } from "../BrowserActionTool"
import type { Task } from "../../task/Task"

it("returns a fresh observation without requiring a path or saving a file", async () => {
	const snapshot = vi.fn().mockResolvedValue({ currentUrl: "https://example.com", logs: "new log" })
	const saveScreenshot = vi.fn()
	const task = {
		browserSession: { snapshot, saveScreenshot },
		say: vi.fn(),
		consecutiveMistakeCount: 0,
	} as unknown as Task
	const result = vi.fn()
	const error = vi.fn()
	await browserActionTool(
		task,
		{ type: "tool_use", name: "browser_action", params: { action: "snapshot" }, partial: false },
		vi.fn(),
		error,
		result,
		(_name, value) => value ?? "",
	)
	expect(snapshot).toHaveBeenCalledOnce()
	expect(saveScreenshot).not.toHaveBeenCalled()
	expect(error).not.toHaveBeenCalled()
	expect(result).toHaveBeenCalledWith(expect.stringContaining("new log"))
})
it("requests application opening without starting a browser control session", async () => {
	const openApplication = vi.fn().mockResolvedValue(true)
	const launchBrowser = vi.fn()
	let current: Task | undefined
	const task = {
		browserSession: { openApplication, launchBrowser },
		providerRef: { deref: () => ({ getCurrentTask: () => current }) },
	} as unknown as Task
	current = task
	const result = vi.fn()
	const error = vi.fn()
	await browserActionTool(
		task,
		{ type: "tool_use", name: "browser_action", params: { action: "open_application" }, partial: false },
		vi.fn(),
		error,
		result,
		(_name, value) => value ?? "",
	)
	expect(error).not.toHaveBeenCalled()
	expect(launchBrowser).not.toHaveBeenCalled()
	expect(openApplication).toHaveBeenCalledOnce()
	const isCurrent = openApplication.mock.calls[0][0]
	expect(isCurrent()).toBe(true)
	current = undefined
	expect(isCurrent()).toBe(false)
	expect(result).toHaveBeenCalledWith(expect.stringContaining("No browser control permission"))
})
it.each([true, false])("bootstraps BrowserOS and opens the original URL only after consent (%s)", async (approved) => {
	const hub = {
		prepareBrowserOSInvocation: vi.fn().mockResolvedValue(approved),
		getAuthorizedBrowserOSServer: vi.fn().mockReturnValue({ serverName: "custom-browser", source: "global" }),
		callTool: vi.fn().mockResolvedValue({
			content: [
				{ type: "text", text: "Page 7" },
				{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
			],
			_meta: { internal: "not-page-content" },
		}),
	}
	const launchBrowser = vi.fn()
	const task = {
		browserSession: { launchBrowser },
		providerRef: { deref: () => ({ context: { globalState: { get: () => "browseros" } }, getMcpHub: () => hub }) },
		consecutiveMistakeCount: 0,
	} as unknown as Task
	const ask = vi.fn(),
		error = vi.fn(),
		result = vi.fn()
	await browserActionTool(
		task,
		{
			type: "tool_use",
			name: "browser_action",
			params: { action: "launch", url: "https://example.com/" },
			partial: false,
		},
		ask,
		error,
		result,
		(_name, value) => value ?? "",
	)
	expect(error).not.toHaveBeenCalled()
	expect(ask).not.toHaveBeenCalled()
	expect(launchBrowser).not.toHaveBeenCalled()
	expect(hub.prepareBrowserOSInvocation).toHaveBeenCalledWith("browseros-neo", task)
	expect(hub.callTool).toHaveBeenCalledTimes(approved ? 1 : 0)
	if (approved) {
		expect(result).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({ type: "text", text: "Page 7\n" }),
				expect.objectContaining({ type: "image" }),
			]),
		)
		expect(JSON.stringify(result.mock.calls)).not.toContain("not-page-content")
	}
	if (approved)
		expect(hub.callTool).toHaveBeenCalledWith(
			"custom-browser",
			"tabs",
			{ action: "new", url: "https://example.com/" },
			"global",
			task,
		)
})
it.each(["chrome-extension", "browseros", "isolated"])(
	"handles partial launch without duplicate personal-browser consent (%s)",
	async (mode) => {
		const ask = vi.fn().mockResolvedValue(undefined)
		const launchBrowser = vi.fn()
		const task = {
			ask,
			browserSession: { launchBrowser },
			providerRef: { deref: () => ({ context: { globalState: { get: () => mode } } }) },
		} as unknown as Task
		const error = vi.fn()
		await browserActionTool(
			task,
			{
				type: "tool_use",
				name: "browser_action",
				params: { action: "launch", url: "https://example.com" },
				partial: true,
			},
			vi.fn(),
			error,
			vi.fn(),
			(_name, value) => value ?? "",
		)
		expect(error).not.toHaveBeenCalled()
		expect(ask).toHaveBeenCalledTimes(mode === "isolated" ? 1 : 0)
		expect(launchBrowser).not.toHaveBeenCalled()
	},
)
// kilocode_change end

describe("Browser Action Screenshot", () => {
	describe("browserActions array", () => {
		it("should include screenshot action", () => {
			expect(browserActions).toContain("screenshot")
		})

		it("should have screenshot as a valid browser action type", () => {
			const allActions = [
				"launch",
				"click",
				"hover",
				"type",
				"press",
				"scroll_down",
				"scroll_up",
				"resize",
				"close",
				"screenshot",
				"snapshot", // kilocode_change
				"select_tab", // kilocode_change
				"create_tab", // kilocode_change
				"open_application", // kilocode_change
			]
			expect(browserActions).toEqual(allActions)
		})
	})
})
