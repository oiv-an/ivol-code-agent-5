import { describe, it, expect, vi, beforeEach, type Mocked } from "vitest"
import * as vscode from "vscode"
import { AgentManagerProvider } from "../AgentManagerProvider"
import { AgentRegistry } from "../AgentRegistry"
import type { RuntimeProcessHandler } from "../RuntimeProcessHandler"
import { LocalSessionStore } from "../LocalSessionStore"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

// Minimal mocks for VS Code APIs
vi.mock("vscode", () => {
	const window = {
		showErrorMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		onDidCloseTerminal: vi.fn(() => ({ dispose: vi.fn() })),
		createTerminal: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn() })),
	}
	const Uri = {
		joinPath: vi.fn(),
	}
	const workspace = {
		workspaceFolders: [],
		getConfiguration: vi.fn(() => ({ get: vi.fn() })),
	}
	const ExtensionMode = {
		Development: 1,
		Production: 2,
		Test: 3,
	}
	const ThemeIcon = vi.fn()
	const env = {
		appRoot: "/mock/vscode/app/root",
	}
	return { window, Uri, workspace, ExtensionMode, ThemeIcon, env, ViewColumn: { One: 1 } }
})

describe("AgentManagerProvider IPC paths", () => {
	let provider: AgentManagerProvider
	let mockProcessHandler: Mocked<RuntimeProcessHandler>
	let mockPanel: any
	let output: string[]
	let registry: AgentRegistry

	beforeEach(() => {
		output = []
		registry = new AgentRegistry()

		mockProcessHandler = {
			hasStdin: vi.fn(),
			writeToStdin: vi.fn(),
			stopProcess: vi.fn(),
			hasProcess: vi.fn(),
		} as unknown as Mocked<RuntimeProcessHandler>

		mockPanel = {
			webview: { postMessage: vi.fn() },
			dispose: vi.fn(),
		}

		const outputChannel: vscode.OutputChannel = {
			name: "test",
			append: (value: string) => output.push(value),
			appendLine: (value: string) => output.push(value),
			clear: vi.fn(),
			dispose: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			replace: vi.fn(),
		} as unknown as vscode.OutputChannel

		const context = {
			extensionUri: { fsPath: "/mock/extension/path" } as any,
			asAbsolutePath: (p: string) => p,
			extensionMode: 1, // Development mode
		} as unknown as vscode.ExtensionContext
		const providerStub = {
			getState: vi.fn().mockResolvedValue({ apiConfiguration: { apiProvider: "kilocode" } }),
		}

		provider = new AgentManagerProvider(context, outputChannel, providerStub as any)

		// Inject mocks
		;(provider as any).processHandler = mockProcessHandler
		;(provider as any).panel = mockPanel
		;(provider as any).registry = registry
	})

	it("reuses the existing panel on repeated opens", async () => {
		mockPanel.reveal = vi.fn()
		await Promise.all([provider.openPanel(), provider.openPanel(), provider.openPanel()])
		expect(mockPanel.reveal).toHaveBeenCalledTimes(3)
		expect((provider as any).panel).toBe(mockPanel)
	})

	it("restores additional tabs into the existing manager without stopping its sessions", async () => {
		mockPanel.reveal = vi.fn()
		const duplicate = { dispose: vi.fn() }
		await provider.restorePanel(duplicate as any)
		expect(duplicate.dispose).toHaveBeenCalledOnce()
		expect((provider as any).panel).toBe(mockPanel)
		expect(mockProcessHandler.stopProcess).not.toHaveBeenCalled()
	})

	it("sendMessage surfaces stdin errors", async () => {
		mockProcessHandler.hasStdin.mockReturnValue(true)
		mockProcessHandler.writeToStdin.mockRejectedValue(new Error("boom"))

		await expect(provider.sendMessage("sess", "hello")).rejects.toThrow("boom")

		expect(mockProcessHandler.writeToStdin).toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to send message to agent: boom")
	})

	it("cancelSession falls back to stopProcess when stdin missing", async () => {
		mockProcessHandler.hasStdin.mockReturnValue(false)

		await provider.cancelSession("sess")

		expect(mockProcessHandler.stopProcess).toHaveBeenCalledWith("sess")
	})

	it("persists sessions across store instances and merges other windows without erasing history", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-store-"))
		try {
			const first = registry.createSession("first", "Original conversation")
			const second = registry.createSession("second", "Another conversation")
			const store = new LocalSessionStore(root)
			await store.save([{ session: first, workspace: root, taskId: "task-first" }])
			const reopened = new LocalSessionStore(root)
			expect((await reopened.read())[0].taskId).toBe("task-first")
			await reopened.save([{ session: second, workspace: root, taskId: "task-second" }])
			expect((await store.read()).map((entry) => entry.session.sessionId)).toEqual(["first", "second"])
			await fs.writeFile(path.join(root, ".ivol", "agent-sessions.json"), "invalid")
			await expect(store.save([])).rejects.toThrow()
			expect(await fs.readFile(path.join(root, ".ivol", "agent-sessions.json"), "utf8")).toBe("invalid")
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})

	it("respondToApproval surfaces stdin errors", async () => {
		mockProcessHandler.hasStdin.mockReturnValue(true)
		mockProcessHandler.writeToStdin.mockRejectedValue(new Error("denied"))

		await expect(provider.respondToApproval("sess", true, "ok")).rejects.toThrow("denied")

		expect(vscode.window.showErrorMessage).toHaveBeenLastCalledWith("Failed to send approval-yes to agent: denied")
	})
})
