// kilocode_change - new file
import * as vscode from "vscode"
import { spawn } from "node:child_process"
import { stat } from "node:fs/promises"
import { EventEmitter } from "node:events"
import { launchPersonalBrowser } from "../kilocode/BrowserLauncher"

vi.mock("vscode", () => ({
	env: { remoteName: undefined, uiKind: 1 },
	UIKind: { Desktop: 1 },
	window: { showOpenDialog: vi.fn(), showWarningMessage: vi.fn() },
}))
vi.mock("node:child_process", () => ({ spawn: vi.fn() }))
vi.mock("node:fs/promises", () => ({ stat: vi.fn() }))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!
beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv("AGENT_CONFIG", "")
	vi.stubEnv("SSH_CONNECTION", "")
	vi.stubEnv("CODE_SERVER", "")
	Object.defineProperty(process, "platform", { value: "darwin" })
	vi.mocked(vscode.env).remoteName = undefined
	vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([
		{ scheme: "file", fsPath: "/Applications/Browser ; test.app" },
	] as any)
	vi.mocked(stat).mockResolvedValue({ isDirectory: () => true, isFile: () => true } as any)
})
afterEach(() => {
	Object.defineProperty(process, "platform", originalPlatform)
	vi.unstubAllEnvs()
})

it("does not launch when the calling task changes during confirmation", async () => {
	let current = true
	vi.mocked(vscode.window.showWarningMessage).mockImplementation(async () => {
		current = false
		return "mcp:browserLaunch.allow" as never
	})
	await expect(launchPersonalBrowser("chrome-extension", () => current)).rejects.toThrow("expired")
	expect(spawn).not.toHaveBeenCalled()
})

it("rejects concurrent launch requests while a picker is open", async () => {
	let finish!: (value: undefined) => void
	vi.mocked(vscode.window.showOpenDialog).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = launchPersonalBrowser("chrome-extension")
	await expect(launchPersonalBrowser("browseros")).rejects.toThrow("already pending")
	finish(undefined)
	await expect(pending).resolves.toBe(false)
	expect(spawn).not.toHaveBeenCalled()
})

it.each(["win32", "linux"])("launches a selected executable without a shell on %s", async (platform) => {
	Object.defineProperty(process, "platform", { value: platform })
	const application = platform === "win32" ? "C:\\Browser\\browser.exe" : "/opt/browser/browser"
	vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([{ scheme: "file", fsPath: application }] as any)
	vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("mcp:browserLaunch.allow" as never)
	const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
	vi.mocked(spawn).mockImplementation(() => {
		queueMicrotask(() => child.emit("spawn"))
		return child as any
	})
	await expect(launchPersonalBrowser("browseros")).resolves.toBe(true)
	expect(spawn).toHaveBeenCalledExactlyOnceWith(application, [], { shell: false, detached: true, stdio: "ignore" })
	expect(child.unref).toHaveBeenCalledOnce()
})

it("does not launch after a declined confirmation", async () => {
	vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined)
	await expect(launchPersonalBrowser("chrome-extension")).resolves.toBe(false)
	expect(spawn).not.toHaveBeenCalled()
})

it("passes a user-selected application as a literal argument without shell or profile flags", async () => {
	vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("mcp:browserLaunch.allow" as never)
	const child = new EventEmitter()
	vi.mocked(spawn).mockImplementation(() => {
		queueMicrotask(() => child.emit("exit", 0))
		return child as any
	})
	await expect(launchPersonalBrowser("browseros")).resolves.toBe(true)
	expect(spawn).toHaveBeenCalledExactlyOnceWith("/usr/bin/open", ["-a", "/Applications/Browser ; test.app"], {
		shell: false,
		detached: true,
		stdio: "ignore",
	})
	expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
		"mcp:browserLaunch.confirm",
		{ modal: true },
		"mcp:browserLaunch.allow",
	)
})

it("rejects remote hosts before showing a picker", async () => {
	vi.mocked(vscode.env).remoteName = "ssh-remote"
	await expect(launchPersonalBrowser("chrome-extension")).rejects.toThrow("local desktop")
	expect(vscode.window.showOpenDialog).not.toHaveBeenCalled()
	expect(spawn).not.toHaveBeenCalled()
})

it("rejects non-application paths on macOS", async () => {
	vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([{ scheme: "file", fsPath: "/tmp/untrusted.sh" }] as any)
	await expect(launchPersonalBrowser("chrome-extension")).rejects.toThrow(".app bundle")
	expect(spawn).not.toHaveBeenCalled()
})
