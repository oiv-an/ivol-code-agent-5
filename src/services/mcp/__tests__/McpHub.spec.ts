import fs from "fs/promises"

import type { Mock } from "vitest"
import type { ExtensionContext, Uri } from "vscode"
import * as vscode from "vscode" // kilocode_change
import { t } from "../../../i18n" // kilocode_change

import type { ClineProvider } from "../../../core/webview/ClineProvider"

import type { McpHub as McpHubType, McpConnection, ConnectedMcpConnection, DisconnectedMcpConnection } from "../McpHub"
import { ServerConfigSchema, McpHub } from "../McpHub"

// Mock fs/promises before importing anything that uses it
vi.mock("fs/promises", () => ({
	default: {
		access: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("{}"),
		unlink: vi.fn().mockResolvedValue(undefined),
		rename: vi.fn().mockResolvedValue(undefined),
		lstat: vi.fn().mockImplementation(() =>
			Promise.resolve({
				isDirectory: () => true,
			}),
		),
		mkdir: vi.fn().mockResolvedValue(undefined),
	},
	access: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue("{}"),
	unlink: vi.fn().mockResolvedValue(undefined),
	rename: vi.fn().mockResolvedValue(undefined),
	lstat: vi.fn().mockImplementation(() =>
		Promise.resolve({
			isDirectory: () => true,
		}),
	),
	mkdir: vi.fn().mockResolvedValue(undefined),
}))

// Import safeWriteJson to use in mocks
import { safeWriteJson } from "../../../utils/safeWriteJson"

// Mock safeWriteJson
vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn(async (filePath, data) => {
		// Instead of trying to write to the file system, just call fs.writeFile mock
		// This avoids the complex file locking and temp file operations
		const fs = await import("fs/promises")
		return fs.writeFile(filePath, JSON.stringify(data), "utf8")
	}),
}))

// kilocode_change start: the browser lookup must never touch a real profile or socket in tests
vi.mock("../../browser/kilocode/BrowserOSDiscovery", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../browser/kilocode/BrowserOSDiscovery")>()),
	discoverBrowserOSEndpoint: vi.fn(),
	probeBrowserOSEndpoint: vi.fn(),
}))
import { discoverBrowserOSEndpoint, probeBrowserOSEndpoint } from "../../browser/kilocode/BrowserOSDiscovery"
// kilocode_change end

// Mock NotificationService
vi.mock("../kilocode/NotificationService", () => ({
	NotificationService: vi.fn().mockImplementation(() => ({
		connect: vi.fn(),
	})),
}))

vi.mock("vscode", () => ({
	env: { remoteName: undefined }, // kilocode_change: local host for browser discovery
	workspace: {
		createFileSystemWatcher: vi.fn().mockReturnValue({
			onDidChange: vi.fn(),
			onDidCreate: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		}),
		onDidSaveTextDocument: vi.fn(),
		onDidChangeWorkspaceFolders: vi.fn(),
		workspaceFolders: [],
	},
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		createTextEditorDecorationType: vi.fn().mockReturnValue({
			dispose: vi.fn(),
		}),
	},
	Disposable: {
		from: vi.fn(),
	},
}))
vi.mock("fs/promises")
vi.mock("../../../core/webview/ClineProvider")

// Mock the MCP SDK modules
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn(),
	getDefaultEnvironment: vi.fn().mockReturnValue({ PATH: "/usr/bin" }),
}))

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn(),
}))

// kilocode_change: exercise real hub callbacks without opening a network connection.
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: vi.fn(),
}))

// Mock chokidar
vi.mock("chokidar", () => ({
	default: {
		watch: vi.fn().mockReturnValue({
			on: vi.fn().mockReturnThis(),
			close: vi.fn(),
		}),
	},
}))

describe("McpHub", () => {
	let mcpHub: McpHubType
	let mockProvider: Partial<ClineProvider>

	// Store original console methods
	const originalConsoleError = console.error
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")

	beforeEach(() => {
		vi.clearAllMocks()

		// Mock console.error to suppress error messages during tests
		console.error = vi.fn()

		const mockUri: Uri = {
			scheme: "file",
			authority: "",
			path: "/test/path",
			query: "",
			fragment: "",
			fsPath: "/test/path",
			with: vi.fn(),
			toJSON: vi.fn(),
		}

		mockProvider = {
			ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
			ensureMcpServersDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
			postMessageToWebview: vi.fn(),
			getState: vi.fn().mockResolvedValue({ mcpEnabled: true }),
			context: {
				subscriptions: [],
				workspaceState: {} as any,
				globalState: { get: vi.fn() } as any, // kilocode_change: model-visible tools follow the saved browser mode
				secrets: {} as any,
				extensionUri: mockUri,
				extensionPath: "/test/path",
				storagePath: "/test/storage",
				globalStoragePath: "/test/global-storage",
				environmentVariableCollection: {} as any,
				extension: {
					id: "test-extension",
					extensionUri: mockUri,
					extensionPath: "/test/path",
					extensionKind: 1,
					isActive: true,
					packageJSON: {
						version: "1.0.0",
					},
					activate: vi.fn(),
					exports: undefined,
				} as any,
				asAbsolutePath: (path: string) => path,
				storageUri: mockUri,
				globalStorageUri: mockUri,
				logUri: mockUri,
				extensionMode: 1,
				logPath: "/test/path",
				languageModelAccessInformation: {} as any,
			} as ExtensionContext,
		}

		// Mock fs.readFile for initial settings
		vi.mocked(fs.readFile).mockResolvedValue(
			JSON.stringify({
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
						alwaysAllow: ["allowed-tool"],
						disabledTools: ["disabled-tool"],
					},
				},
			}),
		)

		mcpHub = new McpHub(mockProvider as ClineProvider)
	})

	afterEach(() => {
		// Restore original console methods
		console.error = originalConsoleError
		// Restore original platform
		if (originalPlatform) {
			Object.defineProperty(process, "platform", originalPlatform)
		}
	})

	// kilocode_change start: automatic setup of the built-in browser server
	describe("automatic BrowserOS connection", () => {
		const endpoint = "http://127.0.0.1:9010/mcp"
		let hub: McpHubType
		let written: Record<string, any>

		const settings = (servers: Record<string, any>) => {
			written = servers
			vi.mocked(fs.readFile).mockImplementation(async (file: any) =>
				String(file).includes("mcp.json")
					? JSON.stringify({ mcpServers: {} })
					: JSON.stringify({ mcpServers: written }),
			)
		}

		beforeEach(async () => {
			const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
			const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
			vi.mocked(StreamableHTTPClientTransport).mockImplementation(
				() => ({ start: vi.fn(), close: vi.fn() }) as any,
			)
			vi.mocked(Client).mockImplementation(
				() =>
					({
						connect: vi.fn(),
						close: vi.fn(),
						getInstructions: vi.fn(),
						getServerCapabilities: () => ({}),
						request: vi.fn().mockResolvedValue({ tools: [] }),
					}) as any,
			)
			vi.mocked(discoverBrowserOSEndpoint).mockResolvedValue(endpoint)
			vi.mocked(probeBrowserOSEndpoint).mockResolvedValue(undefined)
			mockProvider.context!.globalState.get = vi.fn((key: string) =>
				key === "browserMode" ? "browseros" : undefined,
			) as any
			// The written settings are echoed back so re-reads observe the stored entry.
			vi.mocked(safeWriteJson).mockImplementation(async (_path: any, data: any, validate) => {
				await validate?.()
				written = data.mcpServers
			})
			settings({})
			hub = new McpHub(mockProvider as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 50))
			vi.spyOn(hub as any, "scheduleReconnect").mockImplementation(() => undefined)
		})

		afterEach(async () => {
			// Restore the shared write mock so later suites keep observing fs.writeFile.
			vi.mocked(safeWriteJson).mockImplementation(async (filePath: any, data: any) => {
				const fsPromises = await import("fs/promises")
				return fsPromises.writeFile(filePath, JSON.stringify(data), "utf8")
			})
			mockProvider.context!.globalState.get = vi.fn() as any
			await hub.dispose()
		})

		it("prepares and requests consent on invocation, then reuses it across chats", async () => {
			const caller = {} as any
			mockProvider.getCurrentTask = vi.fn().mockReturnValue(caller)
			vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(t("mcp:browserOS.allow") as never)
			await expect(hub.prepareBrowserOSInvocation("browseros-neo", caller)).resolves.toBe(true)
			expect(hub.browserOSAccess.getStatus()).toBe("active")
			const calls = vi.mocked(vscode.window.showWarningMessage).mock.calls.length
			const next = {} as any
			vi.mocked(mockProvider.getCurrentTask).mockReturnValue(next)
			await expect(hub.prepareBrowserOSInvocation("browseros-neo", next)).resolves.toBe(true)
			expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(calls)
		})

		it("does not dispatch or repeatedly prompt after permission is declined", async () => {
			const caller = {} as any
			mockProvider.getCurrentTask = vi.fn().mockReturnValue(caller)
			vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined)
			await expect(hub.prepareBrowserOSInvocation("browseros-neo", caller)).resolves.toBe(false)
			const calls = vi.mocked(vscode.window.showWarningMessage).mock.calls.length
			await expect(hub.prepareBrowserOSInvocation("browseros-neo", caller)).resolves.toBe(false)
			expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(calls)
			expect(hub.browserOSAccess.getStatus()).toBe("idle")
			// An explicit settings grant supersedes refusal without another automatic prompt.
			await hub.grantBrowserOSAccess("browseros-neo", async () => true, "global", true)
			await expect(hub.prepareBrowserOSInvocation("browseros-neo", caller)).resolves.toBe(true)
			expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(calls)
		})

		it("cancels pending permission when disconnected from settings", async () => {
			const caller = {} as any
			mockProvider.getCurrentTask = vi.fn().mockReturnValue(caller)
			vi.mocked(vscode.window.showWarningMessage).mockImplementation(async () => {
				hub.cancelBrowserOSPreparation()
				return t("mcp:browserOS.allow") as never
			})
			await expect(hub.prepareBrowserOSInvocation("browseros-neo", caller)).rejects.toThrow("declined")
			expect(hub.browserOSAccess.getStatus()).toBe("idle")
		})

		it("discards permission when its invoking chat changes during the dialog", async () => {
			const caller = {} as any
			mockProvider.getCurrentTask = vi.fn().mockReturnValue(caller)
			vi.mocked(vscode.window.showWarningMessage).mockImplementation(async () => {
				vi.mocked(mockProvider.getCurrentTask!).mockReturnValue({} as any)
				return t("mcp:browserOS.allow") as never
			})
			await expect(hub.prepareBrowserOSInvocation("browseros-neo", caller)).rejects.toThrow("declined")
			expect(hub.browserOSAccess.getStatus()).toBe("idle")
		})

		it("discards permission when the current chat is abandoned during the dialog", async () => {
			const caller = { abandoned: false } as any
			mockProvider.getCurrentTask = vi.fn().mockReturnValue(caller)
			vi.mocked(vscode.window.showWarningMessage).mockImplementation(async () => {
				caller.abandoned = true
				return t("mcp:browserOS.allow") as never
			})
			await expect(hub.prepareBrowserOSInvocation("browseros-neo", caller)).rejects.toThrow("declined")
			expect(hub.browserOSAccess.getStatus()).toBe("idle")
		})

		it("blocks dispatch from an abandoned chat without revoking host consent", async () => {
			const caller = { abandoned: false } as any
			mockProvider.getCurrentTask = vi.fn().mockReturnValue(caller)
			await hub.ensureBrowserOSConnection()
			await hub.grantBrowserOSAccess("browseros-neo", async () => true, "global", true)
			const connection = hub.connections.find((entry) => entry.server.name === "browseros-neo")!
			const request = vi.mocked(connection.client!.request)
			request.mockClear()
			caller.abandoned = true
			await expect(hub.callTool("browseros-neo", "tabs", { action: "new" }, "global", caller)).rejects.toThrow(
				"caller changed",
			)
			expect(request).not.toHaveBeenCalled()
			expect(hub.browserOSAccess.getStatus()).toBe("active")
		})

		it.each([true, false])("requires an explicit decision to resume paused control (%s)", async (approved) => {
			const caller = {} as any
			mockProvider.getCurrentTask = vi.fn().mockReturnValue(caller)
			await hub.ensureBrowserOSConnection()
			await hub.grantBrowserOSAccess("browseros-neo", async () => true, "global", true)
			hub.browserOSAccess.pause()
			vi.mocked(vscode.window.showWarningMessage).mockImplementation(async () => {
				expect(hub.browserOSAccess.getStatus()).toBe("paused")
				return (approved ? t("mcp:browserOS.allow") : undefined) as never
			})
			await expect(hub.prepareBrowserOSInvocation("browseros-neo", caller)).resolves.toBe(approved)
			expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
				t("mcp:browserOS.resumePermission", { serverName: "browseros-neo" }),
				{ modal: true },
				t("mcp:browserOS.allow"),
			)
			expect(hub.browserOSAccess.getStatus()).toBe(approved ? "active" : "paused")
		})

		it("auto-approves only page tools for the granted task, never file tools or another connection", async () => {
			const task = {} as any
			mockProvider.getCurrentTask = vi.fn().mockReturnValue(task)
			await hub.ensureBrowserOSConnection()
			await hub.grantBrowserOSAccess("browseros-neo", async () => true, "global", true)
			expect(hub.canAutoApproveBrowserOSTool("browseros-neo", "snapshot", { page: 2 }, task)).toBe(true)
			expect(hub.canAutoApproveBrowserOSTool("browseros-neo", "act", { page: 2, kind: "click" }, task)).toBe(true)
			for (const name of ["upload", "download", "pdf", "run", "evaluate"])
				expect(hub.canAutoApproveBrowserOSTool("browseros-neo", name, { page: 2 }, task)).toBe(false)
			expect(hub.canAutoApproveBrowserOSTool("other", "snapshot", { page: 2 }, task)).toBe(false)
			expect(hub.canAutoApproveBrowserOSTool("browseros-neo", "snapshot", { page: 2 }, {})).toBe(false)
			hub.browserOSAccess.pause()
			expect(hub.canAutoApproveBrowserOSTool("browseros-neo", "snapshot", { page: 2 }, task)).toBe(false)
			hub.browserOSAccess.resume()
			expect(hub.canAutoApproveBrowserOSTool("browseros-neo", "snapshot", { page: 2 }, task)).toBe(true)
			hub.browserOSAccess.revoke()
			expect(hub.canAutoApproveBrowserOSTool("browseros-neo", "snapshot", { page: 2 }, task)).toBe(false)
		})

		it("creates and connects the entry without manual editing", async () => {
			const result = await hub.ensureBrowserOSConnection()
			expect(result).toMatchObject({ serverName: "browseros-neo", source: "global", endpoint })
			expect(result.changes).toContain("created")
			expect(written["browseros-neo"]).toMatchObject({
				type: "streamable-http",
				url: endpoint,
				browserOS: true,
				disabled: false,
				oauth: { disabled: true },
			})
			expect(hub.connections.find((entry) => entry.server.name === "browseros-neo")?.server.status).toBe(
				"connected",
			)
		})

		it("keeps unrelated servers and does not create duplicates", async () => {
			settings({ "team-server": { type: "stdio", command: "node", args: ["team.js"] } })
			await hub.ensureBrowserOSConnection()
			const second = await hub.ensureBrowserOSConnection()
			expect(Object.keys(written).sort()).toEqual(["browseros-neo", "team-server"])
			expect(written["team-server"]).toMatchObject({ command: "node" })
			// The second call finds a healthy connection and changes nothing.
			expect(second.changes).toEqual([])
		})

		it("reconnects a retained transport whose server status is disconnected", async () => {
			await hub.ensureBrowserOSConnection()
			const previous = hub.connections.find((entry) => entry.server.name === "browseros-neo")!
			previous.server.status = "disconnected"
			const result = await hub.ensureBrowserOSConnection()
			expect(result.status).toBe("connected")
			expect(hub.connections.find((entry) => entry.server.name === "browseros-neo")).not.toBe(previous)
		})

		it("does not report a failed transport connection as successful", async () => {
			vi.spyOn(hub as any, "connectToServer").mockResolvedValue(undefined)
			await expect(hub.ensureBrowserOSConnection()).rejects.toThrow("did not accept the MCP connection")
		})

		it("reuses an endpoint the user already configured when the browser answers there", async () => {
			const configured = "http://127.0.0.1:9333/mcp"
			settings({ "browseros-neo": { type: "streamable-http", url: configured, browserOS: true } })
			const result = await hub.ensureBrowserOSConnection()
			expect(result.endpoint).toBe(configured)
			expect(probeBrowserOSEndpoint).toHaveBeenCalledWith(configured)
			expect(discoverBrowserOSEndpoint).not.toHaveBeenCalled()
		})

		it("repairs a stale endpoint from the installed browser", async () => {
			settings({ "browseros-neo": { type: "streamable-http", url: "http://127.0.0.1:9999/mcp" } })
			vi.mocked(probeBrowserOSEndpoint).mockRejectedValueOnce(new Error("connection refused"))
			const result = await hub.ensureBrowserOSConnection()
			expect(result.endpoint).toBe(endpoint)
			expect(result.changes).toContain("endpoint")
			expect(written["browseros-neo"].url).toBe(endpoint)
		})

		it("preserves an explicitly selected named connection without rediscovery", async () => {
			settings({ "my-browser": { type: "streamable-http", url: endpoint, browserOS: true } })
			await hub.ensureBrowserOSConnection()
			vi.mocked(discoverBrowserOSEndpoint).mockClear()
			const result = await hub.prepareSelectedBrowserOSConnection("my-browser", "global")
			expect(result.serverName).toBe("my-browser")
			expect(discoverBrowserOSEndpoint).not.toHaveBeenCalled()
			expect(hub.browserOSAccess.getStatus()).toBe("idle")
		})

		it("does not replace a missing explicit connection", async () => {
			await expect(hub.prepareSelectedBrowserOSConnection("missing", "project")).rejects.toThrow(
				"enabled BrowserOS",
			)
			expect(discoverBrowserOSEndpoint).not.toHaveBeenCalled()
			expect(safeWriteJson).not.toHaveBeenCalled()
		})

		it("adopts a differently named entry marked as a browser server", async () => {
			settings({ "my-browser": { type: "streamable-http", url: endpoint, browserOS: true } })
			const result = await hub.ensureBrowserOSConnection()
			expect(result.serverName).toBe("my-browser")
			expect(Object.keys(written)).toEqual(["my-browser"])
		})

		it("preserves an explicitly disabled connection without probing or writing", async () => {
			settings({ "browseros-neo": { type: "streamable-http", url: endpoint, browserOS: true, disabled: true } })
			await expect(hub.ensureBrowserOSConnection()).rejects.toThrow("connection is disabled")
			expect(written["browseros-neo"].disabled).toBe(true)
			expect(safeWriteJson).not.toHaveBeenCalled()
			expect(probeBrowserOSEndpoint).not.toHaveBeenCalled()
			expect(discoverBrowserOSEndpoint).not.toHaveBeenCalled()
			expect(hub.browserOSAccess.getStatus()).toBe("idle")
		})

		it("reports a missing browser instead of writing a guessed entry", async () => {
			vi.mocked(discoverBrowserOSEndpoint).mockRejectedValue(new Error("Could not find an installed browser"))
			await expect(hub.ensureBrowserOSConnection()).rejects.toThrow("Could not find an installed browser")
			expect(written["browseros-neo"]).toBeUndefined()
		})

		it("does not discover a personal browser on an SSH host", async () => {
			vi.stubEnv("SSH_CONNECTION", "test-remote-connection")
			try {
				await expect(hub.ensureBrowserOSConnection()).rejects.toThrow("local desktop IDE host")
				expect(discoverBrowserOSEndpoint).not.toHaveBeenCalled()
				expect(safeWriteJson).not.toHaveBeenCalled()
			} finally {
				vi.unstubAllEnvs()
			}
		})

		it("requires the saved browser mode", async () => {
			mockProvider.context!.globalState.get = vi.fn().mockReturnValue("isolated") as any
			await expect(hub.ensureBrowserOSConnection()).rejects.toThrow("BrowserOS browser mode")
			expect(safeWriteJson).not.toHaveBeenCalled()
		})

		it("refuses to configure a name a project server also uses", async () => {
			vi.spyOn(hub as any, "getProjectMcpPath").mockResolvedValue("/project/.kilocode/mcp.json")
			vi.mocked(fs.readFile).mockImplementation(async (file: any) =>
				String(file).includes("mcp.json")
					? JSON.stringify({ mcpServers: { "browseros-neo": { type: "stdio", command: "node" } } })
					: JSON.stringify({ mcpServers: {} }),
			)
			await expect(hub.ensureBrowserOSConnection()).rejects.toThrow("project MCP server is also named")
			expect(safeWriteJson).not.toHaveBeenCalled()
		})

		it.each(["mode", "dispose"])("cancels setup during discovery after %s changes", async (reason) => {
			vi.mocked(discoverBrowserOSEndpoint).mockImplementationOnce(async () => {
				if (reason === "mode") {
					mockProvider.context!.globalState.get = vi.fn().mockReturnValue("isolated")
				} else {
					await hub.dispose()
				}
				return endpoint
			})
			await expect(hub.ensureBrowserOSConnection()).rejects.toThrow("no longer active")
			expect(safeWriteJson).not.toHaveBeenCalled()
			expect(hub.connections.some((entry) => entry.server.name === "browseros-neo")).toBe(false)
			expect(hub.browserOSAccess.getStatus()).toBe("idle")
		})

		it("does not overwrite a connection disabled during discovery", async () => {
			vi.mocked(discoverBrowserOSEndpoint).mockImplementationOnce(async () => {
				written["browseros-neo"] = {
					type: "streamable-http",
					url: endpoint,
					browserOS: true,
					disabled: true,
				}
				return endpoint
			})
			await expect(hub.ensureBrowserOSConnection()).rejects.toThrow("settings changed during discovery")
			expect(written["browseros-neo"].disabled).toBe(true)
			expect(safeWriteJson).not.toHaveBeenCalled()
		})

		it("runs one setup at a time for concurrent requests", async () => {
			const [first, second] = await Promise.all([
				hub.ensureBrowserOSConnection(),
				hub.ensureBrowserOSConnection(),
			])
			expect(second).toBe(first)
			expect(vi.mocked(safeWriteJson).mock.calls.length).toBe(1)
		})
	})
	// kilocode_change end

	// kilocode_change start
	it.each(["onerror", "onclose"] as const)(
		"revokes BrowserOS on transport %s and ignores stale transport events",
		async (event) => {
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ mcpServers: {} }))
			const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
			const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
			const transport = { start: vi.fn(), close: vi.fn(), onerror: undefined, onclose: undefined } as any
			vi.mocked(StreamableHTTPClientTransport).mockImplementation(() => transport)
			vi.mocked(Client).mockImplementation(
				() =>
					({
						connect: vi.fn(),
						close: vi.fn(),
						getInstructions: vi.fn(),
						getServerCapabilities: () => ({}),
					}) as any,
			)
			const hub = new McpHub(mockProvider as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 100))
			vi.spyOn(hub as any, "scheduleReconnect").mockImplementation(() => undefined)
			await hub["connectToServer"]("browseros-neo", {
				type: "streamable-http",
				url: "http://127.0.0.1:9200/mcp",
				browserOS: true,
				oauth: { disabled: true },
			} as any)
			const connection = hub.connections.find((entry) => entry.server.name === "browseros-neo")!
			expect(connection.server.status).toBe("connected")
			const owner = {}
			await hub.browserOSAccess.acquire(owner, connection, async () => true)
			await transport[event](new Error("Disconnected"))
			expect(hub.browserOSAccess.getStatus()).toBe("idle")
			expect(connection.server.status).toBe("disconnected")
			const replacement = {
				...connection,
				transport: {},
				server: { ...connection.server, status: "connected" },
			} as ConnectedMcpConnection
			hub.connections = [replacement]
			await hub.browserOSAccess.acquire(owner, replacement, async () => true)
			await transport[event](new Error("Late event"))
			expect(hub.browserOSAccess.getStatus()).toBe("active")
			expect(replacement.server.status).toBe("connected")
			hub.connections = []
			await hub.dispose()
		},
	)
	// kilocode_change end

	describe("Discriminated union type handling", () => {
		it("should create connected connections with proper type", async () => {
			// Mock StdioClientTransport
			const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js")
			const StdioClientTransport = stdioModule.StdioClientTransport as ReturnType<typeof vi.fn>

			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(() => mockTransport)

			// Mock Client
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			const Client = clientModule.Client as ReturnType<typeof vi.fn>

			const mockClient = {
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				getServerCapabilities: vi.fn().mockResolvedValue({ tools: {} }), // kilocode_change
			}

			Client.mockImplementation(() => mockClient)

			// Mock the config file read
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"union-test-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			// Create McpHub and let it initialize
			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Find the connection
			const connection = mcpHub.connections.find((conn) => conn.server.name === "union-test-server")
			expect(connection).toBeDefined()

			// Type guard check - connected connections should have client and transport
			if (connection && connection.type === "connected") {
				expect(connection.client).toBeDefined()
				expect(connection.transport).toBeDefined()
				expect(connection.server.status).toBe("connected")
			} else {
				throw new Error("Connection should be of type 'connected'")
			}
		})

		it("should create disconnected connections for disabled servers", async () => {
			// Mock the config file read with a disabled server
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"disabled-union-server": {
							command: "node",
							args: ["test.js"],
							disabled: true,
						},
					},
				}),
			)

			// Create McpHub and let it initialize
			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Find the connection
			const connection = mcpHub.connections.find((conn) => conn.server.name === "disabled-union-server")
			expect(connection).toBeDefined()

			// Type guard check - disconnected connections should have null client and transport
			if (connection && connection.type === "disconnected") {
				expect(connection.client).toBeNull()
				expect(connection.transport).toBeNull()
				expect(connection.server.status).toBe("disconnected")
				expect(connection.server.disabled).toBe(true)
			} else {
				throw new Error("Connection should be of type 'disconnected'")
			}
		})

		// kilocode_change: the live neo protocol returns its browser session in private metadata.
		it("carries the BrowserOS session through discovery and still requires a page observation", async () => {
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ mcpServers: {} }))
			const task = {} as any
			mockProvider.getCurrentTask = vi.fn().mockReturnValue(task)
			mockProvider.context!.globalState.get = vi.fn().mockReturnValue("browseros")
			const hub = new McpHub(mockProvider as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 100))
			const request = vi.fn().mockResolvedValue({
				content: [{ type: "text", text: "Page 7" }],
				_meta: { "com.browseros.neo/session": "private-session" },
			})
			hub.connections = [
				{
					type: "connected",
					server: {
						name: "browseros-neo",
						status: "connected",
						config: JSON.stringify({
							type: "streamable-http",
							url: "http://127.0.0.1:9010/mcp",
							browserOS: true,
						}),
					},
					client: { request } as any,
					transport: {} as any,
				},
			]
			const call = (name: string, args: Record<string, unknown>) =>
				hub.callTool("browseros-neo", name, args, undefined, task)
			try {
				await expect(call("tabs", { action: "list" })).rejects.toThrow("not been granted")
				await hub.grantBrowserOSAccess("browseros-neo", async () => true)
				const result = await call("tabs", { action: "list", session: "untrusted" })
				expect(JSON.stringify(result)).not.toContain("private-session")
				expect(request.mock.calls[0][0].params.arguments).toEqual({ action: "list" })
				await expect(call("act", { page: 7, kind: "click" })).rejects.toThrow("fresh")
				await expect(call("tabs", { action: "close", page: 7 })).rejects.toThrow("fresh")
				await call("snapshot", { page: 7, session: "untrusted" })
				expect(request.mock.calls[1][0].params.arguments).toEqual({ page: 7, session: "private-session" })
				await call("act", { page: 7, kind: "click" })
				expect(request).toHaveBeenCalledTimes(3)
				hub.browserOSAccess.revoke()
				await hub.grantBrowserOSAccess("browseros-neo", async () => true)
				await call("tabs", { action: "active" })
				expect(request.mock.calls[3][0].params.arguments).toEqual({ action: "active" })
				await call("tabs", { action: "new", url: "https://example.com" })
				await expect(call("act", { page: 7, kind: "click" })).rejects.toThrow("fresh")
				await call("snapshot", { page: 7 })
				await expect(call("act", { page: 8, kind: "click" })).rejects.toThrow("fresh")
				// kilocode_change: a manually approved script runs, then invalidates every observation.
				await call("run", { code: "return 1", page: 7 })
				await expect(call("act", { page: 7, kind: "click" })).rejects.toThrow("fresh")
				await call("snapshot", { page: 7 })
				await expect(call("history", {})).rejects.toThrow("not supported")
				await expect(call("snapshot", { page: "7" })).rejects.toThrow("target page ID")
				await expect(call("tabs", { action: "new", url: "file:///private" })).rejects.toThrow("HTTP(S)")
				await call("navigate", { page: 7, action: "url", url: "https://example.com" })
				await expect(call("act", { page: 7, kind: "click" })).rejects.toThrow("fresh")
				await call("snapshot", { page: 7 })
				const args = { page: 7, kind: "click" }
				const pending = call("act", args)
				args.page = 8
				await pending
				expect(request.mock.calls.at(-1)![0].params.arguments.page).toBe(7)
			} finally {
				hub.browserOSAccess.revoke()
				hub.connections = []
				await hub.dispose()
			}
		})

		// kilocode_change: browser grants also cover direct MCP calls and resource reads.
		it("blocks BrowserOS tools and resources without a grant and during manual pause", async () => {
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ mcpServers: {} }))
			const task = {} as any
			mockProvider.getCurrentTask = vi.fn().mockReturnValue(task)
			mockProvider.context!.globalState.get = vi.fn().mockReturnValue("browseros")
			const hub = new McpHub(mockProvider as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 100))
			const connection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "browseros-neo",
					config: JSON.stringify({
						type: "streamable-http",
						url: "http://127.0.0.1:9200/mcp",
						browserOS: true,
					}),
					status: "connected",
				},
				client: { request: vi.fn().mockResolvedValue({ content: [] }) } as any,
				transport: {} as any,
			}
			hub.connections = [connection]
			connection.server.source = "global"
			const projectConnection: ConnectedMcpConnection = {
				...connection,
				server: { ...connection.server, source: "project" },
			}
			hub.connections.push(projectConnection)
			const confirm = vi.fn().mockResolvedValue(true)
			await expect(hub.grantBrowserOSAccess("browseros-neo", confirm, "global")).rejects.toThrow("shadowed")
			expect(confirm).not.toHaveBeenCalled()
			hub.connections = [connection]
			const alias: ConnectedMcpConnection = {
				...connection,
				server: {
					...connection.server,
					name: "unmarked-alias",
					config: JSON.stringify({ type: "streamable-http", url: "http://localhost:9200/other-path" }),
				},
			}
			hub.connections.push(alias)
			await expect(hub.callTool("unmarked-alias", "snapshot", { page: 7 }, undefined, task)).rejects.toThrow(
				"not been granted",
			)
			hub.connections = [alias]
			await expect(hub.readResource("unmarked-alias", "page://current", undefined, task)).rejects.toThrow(
				"not been granted",
			)
			hub.connections = [connection]
			const call = (owner = task) => hub.callTool("browseros-neo", "snapshot", { page: 7 }, undefined, owner)
			const read = (owner = task) => hub.readResource("browseros-neo", "page://current", undefined, owner)
			await expect(call()).rejects.toThrow("not been granted")
			await expect(read()).rejects.toThrow("not been granted")
			expect(connection.client.request).not.toHaveBeenCalled()
			await hub.grantBrowserOSAccess("browseros-neo", async () => true)
			await expect(hub.callTool("browseros-neo", "snapshot", { page: 7 })).rejects.toThrow(
				"calling task instance",
			)
			await expect(hub.readResource("browseros-neo", "page://current")).rejects.toThrow("calling task instance")
			await call()
			hub.browserOSAccess.pause()
			await expect(call()).rejects.toThrow("paused")
			await expect(read()).rejects.toThrow("paused")
			expect(connection.client.request).toHaveBeenCalledOnce()
			hub.browserOSAccess.revoke()

			// A new task's grant must never authorize a delayed call from the old task.
			const replacement = {} as any
			vi.mocked(mockProvider.getCurrentTask!).mockReturnValue(replacement)
			await hub.grantBrowserOSAccess("browseros-neo", async () => true)
			await expect(call(task)).rejects.toThrow("calling task instance")
			await expect(read(task)).rejects.toThrow("calling task instance")
			expect(connection.client.request).toHaveBeenCalledOnce()
			await call(replacement)
			expect(connection.client.request).toHaveBeenCalledTimes(2)

			// Check again after waiting in the queue, before sending anything to the browser.
			const queued = call(replacement)
			vi.mocked(mockProvider.getCurrentTask!).mockReturnValue(task)
			await expect(queued).rejects.toThrow("caller changed")
			expect(connection.client.request).toHaveBeenCalledTimes(2)
			expect(hub.browserOSAccess.getStatus()).toBe("active")

			// Host consent survives replacing the chat, but only its current caller can send commands.
			await call(task)
			expect(connection.client.request).toHaveBeenCalledTimes(3)
			await expect(call(replacement)).rejects.toThrow("calling task instance")
			hub.browserOSAccess.revoke()
			await expect(
				hub.grantBrowserOSAccess("browseros-neo", async () => {
					vi.mocked(mockProvider.getCurrentTask!).mockReturnValue(replacement)
					return true
				}),
			).resolves.toBeUndefined()
			expect(hub.browserOSAccess.getStatus()).toBe("active")
			expect(connection.client.request).toHaveBeenCalledTimes(3)
			hub.browserOSAccess.revoke()
			hub.connections = []
			await hub.dispose()
		})

		it("should handle type narrowing correctly in callTool", async () => {
			// Mock fs.readFile to return empty config so no servers are initialized
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {},
				}),
			)

			// Create a mock McpHub instance
			const mcpHub = new McpHub(mockProvider as ClineProvider)

			// Wait for initialization
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Clear any connections that might have been created
			mcpHub.connections = []

			// Directly set up a connected connection
			const connectedConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					config: JSON.stringify({ command: "node", args: ["test.js"] }),
					status: "connected",
					source: "global",
					errorHistory: [],
				} as any,
				client: {
					request: vi.fn().mockResolvedValue({ result: "success" }),
				} as any,
				transport: {} as any,
			}

			// Add the connected connection
			mcpHub.connections = [connectedConnection]

			// Call tool should work with connected server
			const result = await mcpHub.callTool("test-server", "test-tool", {})
			expect(result).toEqual({ result: "success" })
			expect(connectedConnection.client.request).toHaveBeenCalled()

			// Now test with a disconnected connection
			const disconnectedConnection: DisconnectedMcpConnection = {
				type: "disconnected",
				server: {
					name: "disabled-server",
					config: JSON.stringify({ command: "node", args: ["test.js"], disabled: true }),
					status: "disconnected",
					disabled: true,
					source: "global",
					errorHistory: [],
				} as any,
				client: null,
				transport: null,
			}

			// Replace connections with disconnected one
			mcpHub.connections = [disconnectedConnection]

			// Call tool should fail with disconnected server
			await expect(mcpHub.callTool("disabled-server", "test-tool", {})).rejects.toThrow(
				"No connection found for server: disabled-server",
			)
		})
	})

	describe("File watcher cleanup", () => {
		it("should clean up file watchers when server is disabled", async () => {
			// Get the mocked chokidar
			const chokidar = (await import("chokidar")).default
			const mockWatcher = {
				on: vi.fn().mockReturnThis(),
				close: vi.fn(),
			}
			vi.mocked(chokidar.watch).mockReturnValue(mockWatcher as any)

			// Mock StdioClientTransport
			const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js")
			const StdioClientTransport = stdioModule.StdioClientTransport as ReturnType<typeof vi.fn>

			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(() => mockTransport)

			// Mock Client
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			const Client = clientModule.Client as ReturnType<typeof vi.fn>

			const mockClient = {
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				getServerCapabilities: vi.fn().mockResolvedValue({ tools: {} }), // kilocode_change
			}

			Client.mockImplementation(() => mockClient)

			// Create server with watchPaths
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"watcher-test-server": {
							command: "node",
							args: ["test.js"],
							watchPaths: ["/path/to/watch"],
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Verify watcher was created
			expect(chokidar.watch).toHaveBeenCalledWith(["/path/to/watch"], expect.any(Object))

			// Now disable the server
			await mcpHub.toggleServerDisabled("watcher-test-server", true)

			// Verify watcher was closed
			expect(mockWatcher.close).toHaveBeenCalled()
		})

		it("should clean up all file watchers when server is deleted", async () => {
			// Get the mocked chokidar
			const chokidar = (await import("chokidar")).default
			const mockWatcher1 = {
				on: vi.fn().mockReturnThis(),
				close: vi.fn(),
			}
			const mockWatcher2 = {
				on: vi.fn().mockReturnThis(),
				close: vi.fn(),
			}

			// Return different watchers for different paths
			let watcherIndex = 0
			vi.mocked(chokidar.watch).mockImplementation(() => {
				return (watcherIndex++ === 0 ? mockWatcher1 : mockWatcher2) as any
			})

			// Mock StdioClientTransport
			const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js")
			const StdioClientTransport = stdioModule.StdioClientTransport as ReturnType<typeof vi.fn>

			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(() => mockTransport)

			// Mock Client
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			const Client = clientModule.Client as ReturnType<typeof vi.fn>

			const mockClient = {
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				getServerCapabilities: vi.fn().mockResolvedValue({ tools: {} }), // kilocode_change
			}

			Client.mockImplementation(() => mockClient)

			// Create server with multiple watchPaths
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"multi-watcher-server": {
							command: "node",
							args: ["test.js", "build/index.js"], // This will create a watcher for build/index.js
							watchPaths: ["/path/to/watch1", "/path/to/watch2"],
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Verify watchers were created
			expect(chokidar.watch).toHaveBeenCalled()

			// Delete the connection (this should clean up all watchers)
			await mcpHub.deleteConnection("multi-watcher-server")

			// Verify all watchers were closed
			expect(mockWatcher1.close).toHaveBeenCalled()
			expect(mockWatcher2.close).toHaveBeenCalled()
		})

		it("should not create file watchers for disabled servers on initialization", async () => {
			// Get the mocked chokidar
			const chokidar = (await import("chokidar")).default

			// Create disabled server with watchPaths
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"disabled-watcher-server": {
							command: "node",
							args: ["test.js"],
							watchPaths: ["/path/to/watch"],
							disabled: true,
						},
					},
				}),
			)

			vi.mocked(chokidar.watch).mockClear()

			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Verify no watcher was created for disabled server
			expect(chokidar.watch).not.toHaveBeenCalled()
		})
	})

	describe("DisableReason enum usage", () => {
		it("should use MCP_DISABLED reason when MCP is globally disabled", async () => {
			// Mock provider with mcpEnabled: false
			mockProvider.getState = vi.fn().mockResolvedValue({ mcpEnabled: false })

			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"mcp-disabled-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Find the connection
			const connection = mcpHub.connections.find((conn) => conn.server.name === "mcp-disabled-server")
			expect(connection).toBeDefined()
			expect(connection?.type).toBe("disconnected")
			expect(connection?.server.status).toBe("disconnected")

			// The server should not be marked as disabled individually
			expect(connection?.server.disabled).toBeUndefined()
		})

		it("should use SERVER_DISABLED reason when server is individually disabled", async () => {
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"server-disabled-server": {
							command: "node",
							args: ["test.js"],
							disabled: true,
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Find the connection
			const connection = mcpHub.connections.find((conn) => conn.server.name === "server-disabled-server")
			expect(connection).toBeDefined()
			expect(connection?.type).toBe("disconnected")
			expect(connection?.server.status).toBe("disconnected")
			expect(connection?.server.disabled).toBe(true)
		})

		it("should handle both disable reasons correctly", async () => {
			// First test with MCP globally disabled
			mockProvider.getState = vi.fn().mockResolvedValue({ mcpEnabled: false })

			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"both-reasons-server": {
							command: "node",
							args: ["test.js"],
							disabled: true, // Server is also individually disabled
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Find the connection
			const connection = mcpHub.connections.find((conn) => conn.server.name === "both-reasons-server")
			expect(connection).toBeDefined()
			expect(connection?.type).toBe("disconnected")

			// When MCP is globally disabled, it takes precedence
			// The server's individual disabled state should be preserved
			expect(connection?.server.disabled).toBe(true)
		})
	})

	describe("Null safety improvements", () => {
		it("should handle null client safely in disconnected connections", async () => {
			// Mock fs.readFile to return a disabled server config
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"null-safety-server": {
							command: "node",
							args: ["test.js"],
							disabled: true,
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)

			// Wait for initialization
			await new Promise((resolve) => setTimeout(resolve, 100))

			// The server should be created as a disconnected connection with null client/transport
			const connection = mcpHub.connections.find((conn) => conn.server.name === "null-safety-server")
			expect(connection).toBeDefined()
			expect(connection?.type).toBe("disconnected")

			// Type guard to ensure it's a disconnected connection
			if (connection?.type === "disconnected") {
				expect(connection.client).toBeNull()
				expect(connection.transport).toBeNull()
			}

			// Try to call tool on disconnected server
			await expect(mcpHub.callTool("null-safety-server", "test-tool", {})).rejects.toThrow(
				"No connection found for server: null-safety-server",
			)

			// Try to read resource on disconnected server
			await expect(mcpHub.readResource("null-safety-server", "test-uri")).rejects.toThrow(
				"No connection found for server: null-safety-server",
			)
		})

		it("should handle connection type checks safely", async () => {
			// Mock StdioClientTransport
			const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js")
			const StdioClientTransport = stdioModule.StdioClientTransport as ReturnType<typeof vi.fn>

			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(() => mockTransport)

			// Mock Client
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			const Client = clientModule.Client as ReturnType<typeof vi.fn>

			const mockClient = {
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				getServerCapabilities: vi.fn().mockResolvedValue({ tools: {} }), // kilocode_change
			}

			Client.mockImplementation(() => mockClient)

			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"type-check-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Get the connection
			const connection = mcpHub.connections.find((conn) => conn.server.name === "type-check-server")
			expect(connection).toBeDefined()

			// Safe type checking
			if (connection?.type === "connected") {
				expect(connection.client).toBeDefined()
				expect(connection.transport).toBeDefined()
			} else if (connection?.type === "disconnected") {
				expect(connection.client).toBeNull()
				expect(connection.transport).toBeNull()
			}
		})

		it("should handle missing connections safely", async () => {
			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Try operations on non-existent server
			await expect(mcpHub.callTool("non-existent-server", "test-tool", {})).rejects.toThrow(
				"No connection found for server: non-existent-server",
			)

			await expect(mcpHub.readResource("non-existent-server", "test-uri")).rejects.toThrow(
				"No connection found for server: non-existent-server",
			)
		})

		it("should handle connection deletion safely", async () => {
			// Mock StdioClientTransport
			const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js")
			const StdioClientTransport = stdioModule.StdioClientTransport as ReturnType<typeof vi.fn>

			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(() => mockTransport)

			// Mock Client
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			const Client = clientModule.Client as ReturnType<typeof vi.fn>

			const mockClient = {
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				getServerCapabilities: vi.fn().mockResolvedValue({ tools: {} }), // kilocode_change
			}

			Client.mockImplementation(() => mockClient)

			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"delete-safety-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Delete the connection
			await mcpHub.deleteConnection("delete-safety-server")

			// Verify connection is removed
			const connection = mcpHub.connections.find((conn) => conn.server.name === "delete-safety-server")
			expect(connection).toBeUndefined()

			// Verify transport and client were closed
			expect(mockTransport.close).toHaveBeenCalled()
			expect(mockClient.close).toHaveBeenCalled()
		})
	})

	describe("toggleToolAlwaysAllow", () => {
		it("should add tool to always allow list when enabling", async () => {
			const mockConfig = {
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
						alwaysAllow: [],
					},
				},
			}

			// Mock reading initial config
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockConfig))

			// Set up mock connection without alwaysAllow
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					type: "stdio",
					command: "node",
					args: ["test.js"],
					source: "global",
				} as any,
				client: {} as any,
				transport: {} as any,
			}
			mcpHub.connections = [mockConnection]

			await mcpHub.toggleToolAlwaysAllow("test-server", "global", "new-tool", true)

			// Verify the config was updated correctly
			const writeCalls = vi.mocked(fs.writeFile).mock.calls
			expect(writeCalls.length).toBeGreaterThan(0)

			// Find the write call
			const callToUse = writeCalls[writeCalls.length - 1]
			expect(callToUse).toBeTruthy()

			// The path might be normalized differently on different platforms,
			// so we'll just check that we have a call with valid content
			const writtenConfig = JSON.parse(callToUse[1] as string)
			expect(writtenConfig.mcpServers).toBeDefined()
			expect(writtenConfig.mcpServers["test-server"]).toBeDefined()
			expect(Array.isArray(writtenConfig.mcpServers["test-server"].alwaysAllow)).toBe(true)
			expect(writtenConfig.mcpServers["test-server"].alwaysAllow).toContain("new-tool")
		})

		it("should remove tool from always allow list when disabling", async () => {
			const mockConfig = {
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
						alwaysAllow: ["existing-tool"],
					},
				},
			}

			// Mock reading initial config
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockConfig))

			// Set up mock connection
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					type: "stdio",
					command: "node",
					args: ["test.js"],
					alwaysAllow: ["existing-tool"],
					source: "global",
				} as any,
				client: {} as any,
				transport: {} as any,
			}
			mcpHub.connections = [mockConnection]

			await mcpHub.toggleToolAlwaysAllow("test-server", "global", "existing-tool", false)

			// Verify the config was updated correctly
			const writeCalls = vi.mocked(fs.writeFile).mock.calls
			expect(writeCalls.length).toBeGreaterThan(0)

			// Find the write call
			const callToUse = writeCalls[writeCalls.length - 1]
			expect(callToUse).toBeTruthy()

			// The path might be normalized differently on different platforms,
			// so we'll just check that we have a call with valid content
			const writtenConfig = JSON.parse(callToUse[1] as string)
			expect(writtenConfig.mcpServers).toBeDefined()
			expect(writtenConfig.mcpServers["test-server"]).toBeDefined()
			expect(Array.isArray(writtenConfig.mcpServers["test-server"].alwaysAllow)).toBe(true)
			expect(writtenConfig.mcpServers["test-server"].alwaysAllow).not.toContain("existing-tool")
		})

		it("should initialize alwaysAllow if it does not exist", async () => {
			const mockConfig = {
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
					},
				},
			}

			// Mock reading initial config
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockConfig))

			// Set up mock connection
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					type: "stdio",
					command: "node",
					args: ["test.js"],
					alwaysAllow: [],
					source: "global",
				} as any,
				client: {} as any,
				transport: {} as any,
			}
			mcpHub.connections = [mockConnection]

			await mcpHub.toggleToolAlwaysAllow("test-server", "global", "new-tool", true)

			// Verify the config was updated with initialized alwaysAllow
			// Find the write call with the normalized path
			const normalizedSettingsPath = "/mock/settings/path/cline_mcp_settings.json"
			const writeCalls = vi.mocked(fs.writeFile).mock.calls

			// Find the write call with the normalized path
			const writeCall = writeCalls.find((call: any) => call[0] === normalizedSettingsPath)
			const callToUse = writeCall || writeCalls[0]

			const writtenConfig = JSON.parse(callToUse[1] as string)
			expect(writtenConfig.mcpServers["test-server"].alwaysAllow).toBeDefined()
			expect(writtenConfig.mcpServers["test-server"].alwaysAllow).toContain("new-tool")
		})
	})

	describe("toggleToolEnabledForPrompt", () => {
		it("should add tool to disabledTools list when enabling", async () => {
			const mockConfig = {
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
						disabledTools: [],
					},
				},
			}

			// Set up mock connection
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					config: "test-server-config",
					status: "connected",
					source: "global",
				},
				client: {} as any,
				transport: {} as any,
			}
			mcpHub.connections = [mockConnection]

			// Mock reading initial config
			;(fs.readFile as Mock).mockResolvedValueOnce(JSON.stringify(mockConfig))

			await mcpHub.toggleToolEnabledForPrompt("test-server", "global", "new-tool", false)

			// Verify the config was updated correctly
			const writeCalls = (fs.writeFile as Mock).mock.calls
			expect(writeCalls.length).toBeGreaterThan(0)

			// Find the write call
			const callToUse = writeCalls[writeCalls.length - 1]
			expect(callToUse).toBeTruthy()

			// The path might be normalized differently on different platforms,
			// so we'll just check that we have a call with valid content
			const writtenConfig = JSON.parse(callToUse[1])
			expect(writtenConfig.mcpServers).toBeDefined()
			expect(writtenConfig.mcpServers["test-server"]).toBeDefined()
			expect(Array.isArray(writtenConfig.mcpServers["test-server"].enabledForPrompt)).toBe(false)
			expect(writtenConfig.mcpServers["test-server"].disabledTools).toContain("new-tool")
		})

		it("should remove tool from disabledTools list when disabling", async () => {
			const mockConfig = {
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
						disabledTools: ["existing-tool"],
					},
				},
			}

			// Set up mock connection
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					config: "test-server-config",
					status: "connected",
					source: "global",
				},
				client: {} as any,
				transport: {} as any,
			}
			mcpHub.connections = [mockConnection]

			// Mock reading initial config
			;(fs.readFile as Mock).mockResolvedValueOnce(JSON.stringify(mockConfig))

			await mcpHub.toggleToolEnabledForPrompt("test-server", "global", "existing-tool", true)

			// Verify the config was updated correctly
			const writeCalls = (fs.writeFile as Mock).mock.calls
			expect(writeCalls.length).toBeGreaterThan(0)

			// Find the write call
			const callToUse = writeCalls[writeCalls.length - 1]
			expect(callToUse).toBeTruthy()

			// The path might be normalized differently on different platforms,
			// so we'll just check that we have a call with valid content
			const writtenConfig = JSON.parse(callToUse[1])
			expect(writtenConfig.mcpServers).toBeDefined()
			expect(writtenConfig.mcpServers["test-server"]).toBeDefined()
			expect(Array.isArray(writtenConfig.mcpServers["test-server"].enabledForPrompt)).toBe(false)
			expect(writtenConfig.mcpServers["test-server"].disabledTools).not.toContain("existing-tool")
		})

		it("should initialize disabledTools if it does not exist", async () => {
			const mockConfig = {
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
					},
				},
			}

			// Set up mock connection
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					config: "test-server-config",
					status: "connected",
					source: "global",
				},
				client: {} as any,
				transport: {} as any,
			}
			mcpHub.connections = [mockConnection]

			// Mock reading initial config
			;(fs.readFile as Mock).mockResolvedValueOnce(JSON.stringify(mockConfig))

			// Call with false because of "true" is default value
			await mcpHub.toggleToolEnabledForPrompt("test-server", "global", "new-tool", false)

			// Verify the config was updated with initialized disabledTools
			// Find the write call with the normalized path
			const normalizedSettingsPath = "/mock/settings/path/cline_mcp_settings.json"
			const writeCalls = (fs.writeFile as Mock).mock.calls

			// Find the write call with the normalized path
			const writeCall = writeCalls.find((call) => call[0] === normalizedSettingsPath)
			const callToUse = writeCall || writeCalls[0]

			const writtenConfig = JSON.parse(callToUse[1])
			expect(writtenConfig.mcpServers["test-server"].disabledTools).toBeDefined()
			expect(writtenConfig.mcpServers["test-server"].disabledTools).toContain("new-tool")
		})
	})

	describe("server disabled state", () => {
		it("should toggle server disabled state", async () => {
			const mockConfig = {
				mcpServers: {
					"test-server": {
						type: "stdio",
						command: "node",
						args: ["test.js"],
						disabled: false,
					},
				},
			}

			// Mock reading initial config
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockConfig))

			// Set up mock connection
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					type: "stdio",
					command: "node",
					args: ["test.js"],
					disabled: false,
					source: "global",
				} as any,
				client: {} as any,
				transport: {} as any,
			}
			mcpHub.connections = [mockConnection]

			await mcpHub.toggleServerDisabled("test-server", true)

			// Verify the config was updated correctly
			// Find the write call with the normalized path
			const normalizedSettingsPath = "/mock/settings/path/cline_mcp_settings.json"
			const writeCalls = vi.mocked(fs.writeFile).mock.calls

			// Find the write call with the normalized path
			const writeCall = writeCalls.find((call: any) => call[0] === normalizedSettingsPath)
			const callToUse = writeCall || writeCalls[0]

			const writtenConfig = JSON.parse(callToUse[1] as string)
			expect(writtenConfig.mcpServers["test-server"].disabled).toBe(true)
		})

		// kilocode_change: browser selection controls model-visible tools, not saved connections.
		it.each(["chrome-extension", "isolated", "browseros"])(
			"advertises BrowserOS only in its selected mode (%s)",
			(mode) => {
				const get = mockProvider.context!.globalState.get
				mockProvider.context!.globalState.get = vi.fn(() => mode) as any
				mcpHub.connections = [
					["browseros-neo", { url: "http://127.0.0.1:9010/mcp" }],
					["browser-alias", { url: "http://localhost:9010/mcp" }],
					["custom-browser", { browserOS: true, url: "http://127.0.0.1:9011/mcp" }],
					["ordinary", { command: "node" }],
				].map(([name, config]) => ({
					type: "connected",
					server: { name, config: JSON.stringify(config), status: "connected" },
					client: {},
					transport: {},
				})) as ConnectedMcpConnection[]
				try {
					expect(mcpHub.getServers().map((server) => server.name)).toEqual(
						mode === "browseros"
							? ["browseros-neo", "browser-alias", "custom-browser", "ordinary"]
							: ["ordinary"],
					)
					expect(mcpHub.getAllServers()).toHaveLength(4)
					// A continuing chat reads the same hub again after a saved mode change.
					mockProvider.context!.globalState.get = vi.fn(() => "chrome-extension") as any
					expect(mcpHub.getServers().map((server) => server.name)).toEqual(["ordinary"])
					mockProvider.context!.globalState.get = vi.fn(() => "browseros") as any
					expect(mcpHub.getServers()).toHaveLength(4)
				} finally {
					mockProvider.context!.globalState.get = get
				}
			},
		)

		it("should filter out disabled servers from getServers", () => {
			const mockConnections: McpConnection[] = [
				{
					type: "connected",
					server: {
						name: "enabled-server",
						config: "{}",
						status: "connected",
						disabled: false,
					},
					client: {} as any,
					transport: {} as any,
				} as ConnectedMcpConnection,
				{
					type: "disconnected",
					server: {
						name: "disabled-server",
						config: "{}",
						status: "disconnected",
						disabled: true,
					},
					client: null,
					transport: null,
				} as DisconnectedMcpConnection,
			]

			mcpHub.connections = mockConnections
			const servers = mcpHub.getServers()

			expect(servers.length).toBe(1)
			expect(servers[0].name).toBe("enabled-server")
		})

		it("should deduplicate servers by name with project servers taking priority", () => {
			const mockConnections: McpConnection[] = [
				{
					type: "connected",
					server: {
						name: "shared-server",
						config: '{"source":"global"}',
						status: "connected",
						disabled: false,
						source: "global",
					},
					client: {} as any,
					transport: {} as any,
				} as ConnectedMcpConnection,
				{
					type: "connected",
					server: {
						name: "shared-server",
						config: '{"source":"project"}',
						status: "connected",
						disabled: false,
						source: "project",
					},
					client: {} as any,
					transport: {} as any,
				} as ConnectedMcpConnection,
				{
					type: "connected",
					server: {
						name: "unique-global-server",
						config: "{}",
						status: "connected",
						disabled: false,
						source: "global",
					},
					client: {} as any,
					transport: {} as any,
				} as ConnectedMcpConnection,
			]

			mcpHub.connections = mockConnections
			const servers = mcpHub.getServers()

			// Should have 2 servers: deduplicated "shared-server" + "unique-global-server"
			expect(servers.length).toBe(2)

			// Find the shared-server - it should be the project version
			const sharedServer = servers.find((s) => s.name === "shared-server")
			expect(sharedServer).toBeDefined()
			expect(sharedServer!.source).toBe("project")
			expect(sharedServer!.config).toBe('{"source":"project"}')

			// The unique global server should also be present
			const uniqueServer = servers.find((s) => s.name === "unique-global-server")
			expect(uniqueServer).toBeDefined()
		})

		it("should keep global server when no project server with same name exists", () => {
			const mockConnections: McpConnection[] = [
				{
					type: "connected",
					server: {
						name: "global-only-server",
						config: "{}",
						status: "connected",
						disabled: false,
						source: "global",
					},
					client: {} as any,
					transport: {} as any,
				} as ConnectedMcpConnection,
			]

			mcpHub.connections = mockConnections
			const servers = mcpHub.getServers()

			expect(servers.length).toBe(1)
			expect(servers[0].name).toBe("global-only-server")
			expect(servers[0].source).toBe("global")
		})

		it("should prevent calling tools on disabled servers", async () => {
			// Mock fs.readFile to return a disabled server config
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"disabled-server": {
							command: "node",
							args: ["test.js"],
							disabled: true,
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)

			// Wait for initialization
			await new Promise((resolve) => setTimeout(resolve, 100))

			// The server should be created as a disconnected connection
			const connection = mcpHub.connections.find((conn) => conn.server.name === "disabled-server")
			expect(connection).toBeDefined()
			expect(connection?.type).toBe("disconnected")
			expect(connection?.server.disabled).toBe(true)

			// Try to call tool on disabled server
			await expect(mcpHub.callTool("disabled-server", "some-tool", {})).rejects.toThrow(
				"No connection found for server: disabled-server",
			)
		})

		it("should prevent reading resources from disabled servers", async () => {
			// Mock fs.readFile to return a disabled server config
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"disabled-server": {
							command: "node",
							args: ["test.js"],
							disabled: true,
						},
					},
				}),
			)

			const mcpHub = new McpHub(mockProvider as ClineProvider)

			// Wait for initialization
			await new Promise((resolve) => setTimeout(resolve, 100))

			// The server should be created as a disconnected connection
			const connection = mcpHub.connections.find((conn) => conn.server.name === "disabled-server")
			expect(connection).toBeDefined()
			expect(connection?.type).toBe("disconnected")
			expect(connection?.server.disabled).toBe(true)

			// Try to read resource from disabled server
			await expect(mcpHub.readResource("disabled-server", "some/uri")).rejects.toThrow(
				"No connection found for server: disabled-server",
			)
		})
	})

	describe("callTool", () => {
		it("should execute tool successfully", async () => {
			// Mock the connection with a minimal client implementation
			const mockConnection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name: "test-server",
					config: JSON.stringify({}),
					status: "connected" as const,
				},
				client: {
					request: vi.fn().mockResolvedValue({ result: "success" }),
				} as any,
				transport: {
					start: vi.fn(),
					close: vi.fn(),
					stderr: { on: vi.fn() },
				} as any,
			}

			mcpHub.connections = [mockConnection]

			await mcpHub.callTool("test-server", "some-tool", {})

			// Verify the request was made with correct parameters
			expect(mockConnection.client!.request).toHaveBeenCalledWith(
				{
					method: "tools/call",
					params: {
						name: "some-tool",
						arguments: {},
					},
				},
				expect.any(Object),
				expect.objectContaining({ timeout: 60000 }), // Default 60 second timeout
			)
		})

		it("should throw error if server not found", async () => {
			await expect(mcpHub.callTool("non-existent-server", "some-tool", {})).rejects.toThrow(
				"No connection found for server: non-existent-server",
			)
		})

		describe("timeout configuration", () => {
			it("should validate timeout values", () => {
				// Test valid timeout values
				const validConfig = {
					type: "stdio",
					command: "test",
					timeout: 60,
				}
				expect(() => ServerConfigSchema.parse(validConfig)).not.toThrow()

				// Test invalid timeout values
				const invalidConfigs = [
					{ type: "stdio", command: "test", timeout: 0 }, // Too low
					{ type: "stdio", command: "test", timeout: 3601 }, // Too high
					{ type: "stdio", command: "test", timeout: -1 }, // Negative
				]

				invalidConfigs.forEach((config) => {
					expect(() => ServerConfigSchema.parse(config)).toThrow()
				})
			})

			it("should use default timeout of 60 seconds if not specified", async () => {
				const mockConnection: ConnectedMcpConnection = {
					type: "connected",
					server: {
						name: "test-server",
						config: JSON.stringify({ type: "stdio", command: "test" }), // No timeout specified
						status: "connected",
					},
					client: {
						request: vi.fn().mockResolvedValue({ content: [] }),
					} as any,
					transport: {} as any,
				}

				mcpHub.connections = [mockConnection]
				await mcpHub.callTool("test-server", "test-tool")

				expect(mockConnection.client!.request).toHaveBeenCalledWith(
					expect.anything(),
					expect.anything(),
					expect.objectContaining({ timeout: 60000 }), // 60 seconds in milliseconds
				)
			})

			it("should apply configured timeout to tool calls", async () => {
				const mockConnection: ConnectedMcpConnection = {
					type: "connected",
					server: {
						name: "test-server",
						config: JSON.stringify({ type: "stdio", command: "test", timeout: 120 }), // 2 minutes
						status: "connected",
					},
					client: {
						request: vi.fn().mockResolvedValue({ content: [] }),
					} as any,
					transport: {} as any,
				}

				mcpHub.connections = [mockConnection]
				await mcpHub.callTool("test-server", "test-tool")

				expect(mockConnection.client!.request).toHaveBeenCalledWith(
					expect.anything(),
					expect.anything(),
					expect.objectContaining({ timeout: 120000 }), // 120 seconds in milliseconds
				)
			})
		})

		describe("updateServerTimeout", () => {
			it("should update server timeout in settings file", async () => {
				const mockConfig = {
					mcpServers: {
						"test-server": {
							type: "stdio",
							command: "node",
							args: ["test.js"],
							timeout: 60,
						},
					},
				}

				// Mock reading initial config
				vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockConfig))

				// Set up mock connection
				const mockConnection: ConnectedMcpConnection = {
					type: "connected",
					server: {
						name: "test-server",
						type: "stdio",
						command: "node",
						args: ["test.js"],
						timeout: 60,
						source: "global",
					} as any,
					client: {} as any,
					transport: {} as any,
				}
				mcpHub.connections = [mockConnection]

				await mcpHub.updateServerTimeout("test-server", 120)

				// Verify the config was updated correctly
				// Find the write call with the normalized path
				const normalizedSettingsPath = "/mock/settings/path/cline_mcp_settings.json"
				const writeCalls = vi.mocked(fs.writeFile).mock.calls

				// Find the write call with the normalized path
				const writeCall = writeCalls.find((call: any) => call[0] === normalizedSettingsPath)
				const callToUse = writeCall || writeCalls[0]

				const writtenConfig = JSON.parse(callToUse[1] as string)
				expect(writtenConfig.mcpServers["test-server"].timeout).toBe(120)
			})

			it("should fallback to default timeout when config has invalid timeout", async () => {
				const mockConfig = {
					mcpServers: {
						"test-server": {
							type: "stdio",
							command: "node",
							args: ["test.js"],
							timeout: 60,
						},
					},
				}

				// Mock initial read
				vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockConfig))

				// Set up mock connection before updating
				const mockConnectionInitial: ConnectedMcpConnection = {
					type: "connected",
					server: {
						name: "test-server",
						type: "stdio",
						command: "node",
						args: ["test.js"],
						timeout: 60,
						source: "global",
					} as any,
					client: {
						request: vi.fn().mockResolvedValue({ content: [] }),
					} as any,
					transport: {} as any,
				}
				mcpHub.connections = [mockConnectionInitial]

				// Update with invalid timeout
				await mcpHub.updateServerTimeout("test-server", 3601)

				// Config is written
				expect(fs.writeFile).toHaveBeenCalled()

				// Setup connection with invalid timeout
				const mockConnectionInvalid: ConnectedMcpConnection = {
					type: "connected",
					server: {
						name: "test-server",
						config: JSON.stringify({
							type: "stdio",
							command: "node",
							args: ["test.js"],
							timeout: 3601, // Invalid timeout
						}),
						status: "connected",
					},
					client: {
						request: vi.fn().mockResolvedValue({ content: [] }),
					} as any,
					transport: {} as any,
				}

				mcpHub.connections = [mockConnectionInvalid]

				// Call tool - should use default timeout
				await mcpHub.callTool("test-server", "test-tool")

				// Verify default timeout was used
				expect(mockConnectionInvalid.client!.request).toHaveBeenCalledWith(
					expect.anything(),
					expect.anything(),
					expect.objectContaining({ timeout: 60000 }), // Default 60 seconds
				)
			})

			it("should accept valid timeout values", async () => {
				const mockConfig = {
					mcpServers: {
						"test-server": {
							type: "stdio",
							command: "node",
							args: ["test.js"],
							timeout: 60,
						},
					},
				}

				vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockConfig))

				// Set up mock connection
				const mockConnection: ConnectedMcpConnection = {
					type: "connected",
					server: {
						name: "test-server",
						type: "stdio",
						command: "node",
						args: ["test.js"],
						timeout: 60,
						source: "global",
					} as any,
					client: {} as any,
					transport: {} as any,
				}
				mcpHub.connections = [mockConnection]

				// Test valid timeout values
				const validTimeouts = [1, 60, 3600]
				for (const timeout of validTimeouts) {
					await mcpHub.updateServerTimeout("test-server", timeout)
					expect(fs.writeFile).toHaveBeenCalled()
					vi.clearAllMocks() // Reset for next iteration
					;(fs.readFile as any).mockResolvedValueOnce(JSON.stringify(mockConfig))
				}
			})

			it("should notify webview after updating timeout", async () => {
				const mockConfig = {
					mcpServers: {
						"test-server": {
							type: "stdio",
							command: "node",
							args: ["test.js"],
							timeout: 60,
						},
					},
				}

				vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockConfig))

				// Set up mock connection
				const mockConnection: ConnectedMcpConnection = {
					type: "connected",
					server: {
						name: "test-server",
						type: "stdio",
						command: "node",
						args: ["test.js"],
						timeout: 60,
						source: "global",
					} as any,
					client: {} as any,
					transport: {} as any,
				}
				mcpHub.connections = [mockConnection]

				await mcpHub.updateServerTimeout("test-server", 120)

				expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "mcpServers",
					}),
				)
			})
		})
	})

	describe("MCP global enable/disable", () => {
		beforeEach(() => {
			// Clear all mocks before each test
			vi.clearAllMocks()
		})

		it("should disconnect all servers when MCP is toggled from enabled to disabled", async () => {
			// Mock StdioClientTransport
			const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js")
			const StdioClientTransport = stdioModule.StdioClientTransport as ReturnType<typeof vi.fn>

			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(() => mockTransport)

			// Mock Client
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			const Client = clientModule.Client as ReturnType<typeof vi.fn>

			const mockClient = {
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				getServerCapabilities: vi.fn().mockResolvedValue({ tools: {} }), // kilocode_change
			}

			Client.mockImplementation(() => mockClient)

			// Start with MCP enabled
			mockProvider.getState = vi.fn().mockResolvedValue({ mcpEnabled: true })

			// Mock the config file read
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"toggle-test-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			// Create McpHub and let it initialize with MCP enabled
			const mcpHub = new McpHub(mockProvider as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Verify server is connected
			const connectedServer = mcpHub.connections.find((conn) => conn.server.name === "toggle-test-server")
			expect(connectedServer).toBeDefined()
			expect(connectedServer!.server.status).toBe("connected")
			expect(connectedServer!.client).toBeDefined()
			expect(connectedServer!.transport).toBeDefined()

			// Now simulate toggling MCP to disabled
			mockProvider.getState = vi.fn().mockResolvedValue({ mcpEnabled: false })

			// Manually trigger what would happen when MCP is disabled
			// (normally this would be triggered by the webview message handler)
			const existingConnections = [...mcpHub.connections]
			for (const conn of existingConnections) {
				await mcpHub.deleteConnection(conn.server.name, conn.server.source)
			}
			await mcpHub.refreshAllConnections()

			// Verify server is now tracked but disconnected
			const disconnectedServer = mcpHub.connections.find((conn) => conn.server.name === "toggle-test-server")
			expect(disconnectedServer).toBeDefined()
			expect(disconnectedServer!.server.status).toBe("disconnected")
			expect(disconnectedServer!.client).toBeNull()
			expect(disconnectedServer!.transport).toBeNull()

			// Verify close was called on the original client and transport
			expect(mockClient.close).toHaveBeenCalled()
			expect(mockTransport.close).toHaveBeenCalled()
		})

		it("should not connect to servers when MCP is globally disabled", async () => {
			// Mock provider with mcpEnabled: false
			const disabledMockProvider = {
				ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
				ensureMcpServersDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
				postMessageToWebview: vi.fn(),
				getState: vi.fn().mockResolvedValue({ mcpEnabled: false }),
				context: mockProvider.context,
			}

			// Mock the config file read with a different server name to avoid conflicts
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"disabled-test-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			// Create a new McpHub instance with disabled MCP
			const mcpHub = new McpHub(disabledMockProvider as unknown as ClineProvider)

			// Wait for initialization
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Find the disabled-test-server
			const disabledServer = mcpHub.connections.find((conn) => conn.server.name === "disabled-test-server")

			// Verify that the server is tracked but not connected
			expect(disabledServer).toBeDefined()
			expect(disabledServer!.server.status).toBe("disconnected")
			expect(disabledServer!.client).toBeNull()
			expect(disabledServer!.transport).toBeNull()
		})

		it("should connect to servers when MCP is globally enabled", async () => {
			// Clear all mocks
			vi.clearAllMocks()

			// Mock StdioClientTransport
			const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js")
			const StdioClientTransport = stdioModule.StdioClientTransport as ReturnType<typeof vi.fn>

			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation(() => mockTransport)

			// Mock Client
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			const Client = clientModule.Client as ReturnType<typeof vi.fn>

			Client.mockImplementation(() => ({
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				getServerCapabilities: vi.fn().mockResolvedValue({ tools: {} }), // kilocode_change
			}))

			// Mock provider with mcpEnabled: true
			const enabledMockProvider = {
				ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
				ensureMcpServersDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
				postMessageToWebview: vi.fn(),
				getState: vi.fn().mockResolvedValue({ mcpEnabled: true }),
				context: mockProvider.context,
			}

			// Mock the config file read with a different server name
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"enabled-test-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			// Create a new McpHub instance with enabled MCP
			const mcpHub = new McpHub(enabledMockProvider as unknown as ClineProvider)

			// Wait for initialization
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Find the enabled-test-server
			const enabledServer = mcpHub.connections.find((conn) => conn.server.name === "enabled-test-server")

			// Verify that the server is connected
			expect(enabledServer).toBeDefined()
			expect(enabledServer!.server.status).toBe("connected")
			expect(enabledServer!.client).toBeDefined()
			expect(enabledServer!.transport).toBeDefined()

			// Verify StdioClientTransport was called
			expect(StdioClientTransport).toHaveBeenCalled()
		})

		it("should handle refreshAllConnections when MCP is disabled", async () => {
			// Mock provider with mcpEnabled: false
			const disabledMockProvider = {
				ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
				ensureMcpServersDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
				postMessageToWebview: vi.fn(),
				getState: vi.fn().mockResolvedValue({ mcpEnabled: false }),
				context: mockProvider.context,
			}

			// Mock the config file read
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"refresh-test-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			// Create McpHub with disabled MCP
			const mcpHub = new McpHub(disabledMockProvider as unknown as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Clear previous calls
			vi.clearAllMocks()

			// Call refreshAllConnections
			await mcpHub.refreshAllConnections()

			// Verify that servers are tracked but not connected
			const server = mcpHub.connections.find((conn) => conn.server.name === "refresh-test-server")
			expect(server).toBeDefined()
			expect(server!.server.status).toBe("disconnected")
			expect(server!.client).toBeNull()
			expect(server!.transport).toBeNull()

			// Verify postMessageToWebview was called to update the UI
			expect(disabledMockProvider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "mcpServers",
				}),
			)
		})

		it("should skip restarting connection when MCP is disabled", async () => {
			// Mock provider with mcpEnabled: false
			const disabledMockProvider = {
				ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
				ensureMcpServersDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
				postMessageToWebview: vi.fn(),
				getState: vi.fn().mockResolvedValue({ mcpEnabled: false }),
				context: mockProvider.context,
			}

			// Mock the config file read
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"restart-test-server": {
							command: "node",
							args: ["test.js"],
						},
					},
				}),
			)

			// Create McpHub with disabled MCP
			const mcpHub = new McpHub(disabledMockProvider as unknown as ClineProvider)
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Set isConnecting to false to ensure it's properly reset
			mcpHub.isConnecting = false

			// Try to restart a connection
			await mcpHub.restartConnection("restart-test-server")

			// Verify that isConnecting was reset to false
			expect(mcpHub.isConnecting).toBe(false)

			// Verify that the server remains disconnected
			const server = mcpHub.connections.find((conn) => conn.server.name === "restart-test-server")
			expect(server).toBeDefined()
			expect(server!.server.status).toBe("disconnected")
			expect(server!.client).toBeNull()
			expect(server!.transport).toBeNull()
		})
	})

	// kilocode_change start: background recovery must not spam IDE notifications.
	describe("restart notifications", () => {
		let hub: McpHub
		let connection: McpConnection

		beforeEach(() => {
			hub = Object.create(McpHub.prototype) as McpHub
			connection = {
				server: {
					name: "browseros-neo",
					source: "global",
					status: "disconnected",
					config: JSON.stringify({ type: "streamable-http", url: "http://127.0.0.1:9010/mcp" }),
				},
			} as McpConnection
			hub.connections = [connection]
			vi.spyOn(hub as any, "isMcpEnabled").mockResolvedValue(true)
			vi.spyOn(hub as any, "notifyWebviewOfServerChanges").mockResolvedValue(undefined)
			vi.spyOn(hub as any, "deleteConnection").mockResolvedValue(undefined)
			vi.spyOn(hub as any, "connectToServer").mockImplementation(async () => {
				connection.server.status = "connected"
			})
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it("keeps automatic recovery silent", async () => {
			Object.assign(hub, { reconnectTimers: new Map(), reconnectAttempts: new Map(), isDisposed: false })
			const restart = vi.spyOn(hub, "restartConnection")
			;(hub as any).scheduleReconnect("browseros-neo", "global")
			await vi.advanceTimersByTimeAsync(1000)
			expect(restart).toHaveBeenCalledWith("browseros-neo", "global", { silent: true })
			expect(connection.server.status).toBe("connected")
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
			expect(hub.isConnecting).toBe(false)
		})

		it("retains notifications for a successful manual restart", async () => {
			const pending = hub.restartConnection("browseros-neo", "global")
			await vi.advanceTimersByTimeAsync(500)
			await pending
			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
				t("mcp:info.server_restarting", { serverName: "browseros-neo" }),
			)
			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
				t("mcp:info.server_connected", { serverName: "browseros-neo" }),
			)
		})

		it("does not announce success for a disconnected placeholder", async () => {
			vi.mocked((hub as any).connectToServer).mockImplementation(async () => {
				connection.server.status = "disconnected"
			})
			const pending = hub.restartConnection("browseros-neo", "global")
			await vi.advanceTimersByTimeAsync(500)
			await pending
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(
				t("mcp:info.server_connected", { serverName: "browseros-neo" }),
			)
		})
	})
	// kilocode_change end

	describe("Windows command wrapping", () => {
		let StdioClientTransport: ReturnType<typeof vi.fn>
		let Client: ReturnType<typeof vi.fn>

		beforeEach(async () => {
			// Reset mocks
			vi.clearAllMocks()

			// Get references to the mocked constructors
			const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js")
			const clientModule = await import("@modelcontextprotocol/sdk/client/index.js")
			StdioClientTransport = stdioModule.StdioClientTransport as ReturnType<typeof vi.fn>
			Client = clientModule.Client as ReturnType<typeof vi.fn>

			// Mock Windows platform
			Object.defineProperty(process, "platform", {
				value: "win32",
				writable: true,
				enumerable: true,
				configurable: true,
			})
		})

		it("should wrap commands with cmd.exe on Windows", async () => {
			// Mock StdioClientTransport
			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation((config: any) => {
				// Verify that cmd.exe wrapping is applied
				expect(config.command).toBe("cmd.exe")
				expect(config.args).toEqual([
					"/c",
					"npx",
					"-y",
					"@modelcontextprotocol/server-filesystem",
					"/test/path",
				])
				return mockTransport
			})

			// Mock Client
			Client.mockImplementation(() => ({
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				getServerCapabilities: vi.fn().mockResolvedValue({ tools: {} }), // kilocode_change
			}))

			// Create a new McpHub instance
			const mcpHub = new McpHub(mockProvider as ClineProvider)

			// Mock the config file read
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"test-npx-server": {
							command: "npx",
							args: ["-y", "@modelcontextprotocol/server-filesystem", "/test/path"],
						},
					},
				}),
			)

			// Initialize servers (this will trigger connectToServer)
			await mcpHub["initializeGlobalMcpServers"]()

			// Verify StdioClientTransport was called with wrapped command
			expect(StdioClientTransport).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "cmd.exe",
					args: ["/c", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/test/path"],
				}),
			)
		})

		it("should not wrap commands on non-Windows platforms", async () => {
			// Mock non-Windows platform
			Object.defineProperty(process, "platform", {
				value: "darwin",
				writable: true,
				enumerable: true,
				configurable: true,
			})

			// Mock StdioClientTransport
			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation((config: any) => {
				// Verify that no cmd.exe wrapping is applied
				expect(config.command).toBe("npx")
				expect(config.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/test/path"])
				return mockTransport
			})

			// Mock Client
			Client.mockImplementation(() => ({
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				getServerCapabilities: vi.fn().mockResolvedValue({ tools: {} }), // kilocode_change
			}))

			// Create a new McpHub instance
			const mcpHub = new McpHub(mockProvider as ClineProvider)

			// Mock the config file read
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"test-npx-server": {
							command: "npx",
							args: ["-y", "@modelcontextprotocol/server-filesystem", "/test/path"],
						},
					},
				}),
			)

			// Initialize servers (this will trigger connectToServer)
			await mcpHub["initializeGlobalMcpServers"]()

			// Verify StdioClientTransport was called without wrapping
			expect(StdioClientTransport).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "npx",
					args: ["-y", "@modelcontextprotocol/server-filesystem", "/test/path"],
				}),
			)
		})

		it("should not double-wrap commands that are already cmd.exe", async () => {
			// Mock Windows platform
			Object.defineProperty(process, "platform", {
				value: "win32",
				writable: true,
				enumerable: true,
				configurable: true,
			})

			// Mock StdioClientTransport
			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation((config: any) => {
				// Verify that cmd.exe is not double-wrapped
				expect(config.command).toBe("cmd.exe")
				expect(config.args).toEqual(["/c", "echo", "test"])
				return mockTransport
			})

			// Mock Client
			Client.mockImplementation(() => ({
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				getServerCapabilities: vi.fn().mockResolvedValue({ tools: {} }), // kilocode_change
			}))

			// Create a new McpHub instance
			const mcpHub = new McpHub(mockProvider as ClineProvider)

			// Mock the config file read with cmd.exe already as command
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"test-cmd-server": {
							command: "cmd.exe",
							args: ["/c", "echo", "test"],
						},
					},
				}),
			)

			// Initialize servers (this will trigger connectToServer)
			await mcpHub["initializeGlobalMcpServers"]()

			// Verify StdioClientTransport was called without double-wrapping
			expect(StdioClientTransport).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "cmd.exe",
					args: ["/c", "echo", "test"],
				}),
			)
		})

		it("should handle npx.ps1 scenario from node version managers", async () => {
			// Mock Windows platform
			Object.defineProperty(process, "platform", {
				value: "win32",
				writable: true,
				enumerable: true,
				configurable: true,
			})

			// Mock StdioClientTransport to simulate the ENOENT error without wrapping
			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			let callCount = 0
			StdioClientTransport.mockImplementation((config: any) => {
				callCount++
				// First call would fail with ENOENT if not wrapped
				// Second call should be wrapped with cmd.exe
				if (callCount === 1) {
					// This simulates what would happen without wrapping
					expect(config.command).toBe("cmd.exe")
					expect(config.args[0]).toBe("/c")
					expect(config.args[1]).toBe("npx")
				}
				return mockTransport
			})

			// Mock Client
			Client.mockImplementation(() => ({
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				getServerCapabilities: vi.fn().mockResolvedValue({ tools: {} }), // kilocode_change
			}))

			// Create a new McpHub instance
			const mcpHub = new McpHub(mockProvider as ClineProvider)

			// Mock the config file read - simulating fnm/nvm-windows scenario
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"test-fnm-npx-server": {
							command: "npx",
							args: ["-y", "@modelcontextprotocol/server-example"],
							env: {
								// Simulate fnm environment
								FNM_DIR: "C:\\Users\\test\\.fnm",
								FNM_NODE_DIST_MIRROR: "https://nodejs.org/dist",
								FNM_ARCH: "x64",
							},
						},
					},
				}),
			)

			// Initialize servers (this will trigger connectToServer)
			await mcpHub["initializeGlobalMcpServers"]()

			// Verify that the command was wrapped with cmd.exe
			expect(StdioClientTransport).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "cmd.exe",
					args: ["/c", "npx", "-y", "@modelcontextprotocol/server-example"],
					env: expect.objectContaining({
						FNM_DIR: "C:\\Users\\test\\.fnm",
						FNM_NODE_DIST_MIRROR: "https://nodejs.org/dist",
						FNM_ARCH: "x64",
					}),
				}),
			)
		})

		it("should handle case-insensitive cmd command check", async () => {
			// Mock Windows platform
			Object.defineProperty(process, "platform", {
				value: "win32",
				writable: true,
				enumerable: true,
				configurable: true,
			})

			// Mock StdioClientTransport
			const mockTransport = {
				start: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				stderr: {
					on: vi.fn(),
				},
				onerror: null,
				onclose: null,
			}

			StdioClientTransport.mockImplementation((config: any) => {
				// Verify that CMD (uppercase) is not double-wrapped
				expect(config.command).toBe("CMD")
				expect(config.args).toEqual(["/c", "echo", "test"])
				return mockTransport
			})

			// Mock Client
			Client.mockImplementation(() => ({
				connect: vi.fn().mockResolvedValue(undefined),
				close: vi.fn().mockResolvedValue(undefined),
				getInstructions: vi.fn().mockReturnValue("test instructions"),
				request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
				getServerCapabilities: vi.fn().mockResolvedValue({ tools: {} }), // kilocode_change
			}))

			// Create a new McpHub instance
			const mcpHub = new McpHub(mockProvider as ClineProvider)

			// Mock the config file read with CMD (uppercase) as command
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					mcpServers: {
						"test-cmd-uppercase-server": {
							command: "CMD",
							args: ["/c", "echo", "test"],
						},
					},
				}),
			)

			// Initialize servers (this will trigger connectToServer)
			await mcpHub["initializeGlobalMcpServers"]()

			// Verify StdioClientTransport was called without double-wrapping
			expect(StdioClientTransport).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "CMD",
					args: ["/c", "echo", "test"],
				}),
			)
		})
	})
})
