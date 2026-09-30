import { parseWorkspaceDisabled, readWorkspaceDisabled } from "../workspaceDisabled"
import type { ExtensionContext } from "vscode"
const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	stat: vi.fn(),
	dirs: vi.fn(),
	execute: vi.fn(),
	wrapped: false,
	version: "1.139.1",
	remote: undefined as string | undefined,
}))
vi.mock("node:fs/promises", () => ({ readFile: mocks.read, stat: mocks.stat, readdir: mocks.dirs }))
vi.mock("node:util", () => ({ promisify: () => mocks.execute }))
vi.mock("../../../../core/kilocode/wrapper", () => ({
	getKiloCodeWrapperProperties: () => ({ kiloCodeWrapped: mocks.wrapped }),
}))
vi.mock("vscode", () => ({
	get version() {
		return mocks.version
	},
	env: {
		appName: "Visual Studio Code",
		get remoteName() {
			return mocks.remote
		},
	},
	workspace: { workspaceFolders: [{ uri: { toString: () => "file:///project" } }] },
	extensions: { getExtension: () => undefined },
}))
const context = {
	storageUri: { scheme: "file", fsPath: "/user/workspaceStorage/current/ivol" },
	extensionUri: { fsPath: "/extensions/ivol" },
} as ExtensionContext
const row = (key: string, values: unknown[]) => ({ key: `extensionsIdentifiers/${key}`, value: JSON.stringify(values) })
beforeEach(() => {
	vi.clearAllMocks()
	mocks.wrapped = false
	mocks.version = "1.139.1"
	mocks.remote = undefined
	mocks.stat.mockResolvedValue({ size: 100 })
	mocks.read.mockResolvedValue(JSON.stringify({ folder: "file:///project" }))
	mocks.dirs.mockResolvedValue([])
	mocks.execute.mockResolvedValue({ stdout: JSON.stringify([row("disabled", [{ id: "redhat.java" }])]) })
})
it("lists explicit workspace disables, deduplicates, and respects explicit workspace enables", () => {
	expect(
		parseWorkspaceDisabled([
			row("disabled", [{ id: "RedHat.Java" }, { id: "redhat.java" }, { id: "test.enabled" }]),
			row("enabled", [{ id: "test.enabled" }]),
		]),
	).toEqual(["redhat.java"])
	expect(parseWorkspaceDisabled([])).toEqual([])
})
it("rejects corrupt and unexpected storage instead of claiming an empty list", () => {
	expect(() => parseWorkspaceDisabled([row("disabled", [{ id: "@disabled" }])])).toThrow()
	expect(() => parseWorkspaceDisabled([row("global", [])])).toThrow()
	expect(() => parseWorkspaceDisabled([{ key: "extensionsIdentifiers/disabled", value: "broken" }])).toThrow()
})
it("reads only two enablement keys from the verified current database in read-only mode", async () => {
	const result = await readWorkspaceDisabled(context)
	expect(result.status).toBe("available")
	expect(result.entries).toEqual([{ id: "redhat.java", name: "redhat.java" }])
	expect(mocks.execute).toHaveBeenCalledWith(
		"/usr/bin/sqlite3",
		[
			"-readonly",
			"-json",
			"/user/workspaceStorage/current/state.vscdb",
			expect.stringContaining("SELECT key,value"),
		],
		expect.objectContaining({ timeout: 5000 }),
	)
	expect(mocks.read).toHaveBeenCalledTimes(1)
})
it("never opens a database for another workspace", async () => {
	mocks.read.mockResolvedValue(JSON.stringify({ folder: "file:///other" }))
	expect((await readWorkspaceDisabled(context)).status).toBe("unsupported")
	expect(mocks.execute).not.toHaveBeenCalled()
})
it.each(["version", "wrapped", "remote"])("fails closed for unsupported %s", async (guard) => {
	if (guard === "version") mocks.version = "1.140.0"
	if (guard === "wrapped") mocks.wrapped = true
	if (guard === "remote") mocks.remote = "ssh-remote"
	expect((await readWorkspaceDisabled(context)).status).toBe("unsupported")
	expect(mocks.read).not.toHaveBeenCalled()
	expect(mocks.execute).not.toHaveBeenCalled()
})
it("reports database failures instead of falling back to available extensions", async () => {
	mocks.execute.mockRejectedValue(new Error("database locked"))
	expect(await readWorkspaceDisabled(context)).toMatchObject({
		status: "unsupported",
		entries: [],
		reason: expect.stringContaining("database locked"),
	})
})
