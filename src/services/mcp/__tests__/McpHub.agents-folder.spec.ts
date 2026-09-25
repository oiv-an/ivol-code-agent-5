// kilocode_change - new file
import { normalizeForeignServerConfig, ServerConfigSchema } from "../McpHub"

vi.mock("vscode", () => ({
	workspace: { workspaceFolders: [], onDidChangeWorkspaceFolders: vi.fn(), createFileSystemWatcher: vi.fn() },
	window: { showErrorMessage: vi.fn(), showInformationMessage: vi.fn() },
	Disposable: { from: vi.fn() },
	RelativePattern: vi.fn(),
}))

describe("normalizeForeignServerConfig", () => {
	it("maps Windsurf/Antigravity serverUrl to a streamable-http url", () => {
		const out = normalizeForeignServerConfig({ serverUrl: "https://mcp.example.com/mcp", headers: { a: "b" } })
		expect(out).toEqual({ url: "https://mcp.example.com/mcp", type: "streamable-http", headers: { a: "b" } })
		expect(ServerConfigSchema.safeParse(out).success).toBe(true)
	})

	it("keeps an explicit type", () => {
		expect(normalizeForeignServerConfig({ serverUrl: "https://x.test/sse", type: "sse" })).toEqual({
			url: "https://x.test/sse",
			type: "sse",
		})
	})

	it("leaves native configs untouched", () => {
		const stdio = { command: "npx", args: ["server"] }
		const http = { type: "sse", url: "https://x.test" }
		expect(normalizeForeignServerConfig(stdio)).toBe(stdio)
		expect(normalizeForeignServerConfig(http)).toBe(http)
		expect(normalizeForeignServerConfig(null)).toBe(null)
	})
})
