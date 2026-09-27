// kilocode_change - new file
import { handleProjectTaskStorage } from "../projectTaskStorageHandler"
import type { ClineProvider } from "../../../webview/ClineProvider"

const mocks = vi.hoisted(() => ({
	configure: vi.fn(),
	copy: vi.fn(),
	read: vi.fn(),
	commands: vi.fn(),
	execute: vi.fn(),
	update: vi.fn(),
}))
vi.mock("../../../../services/kilocode/project-task-storage", () => ({
	configureProjectTaskStorage: mocks.configure,
	copyTasksToProject: mocks.copy,
	readProjectTaskStorage: mocks.read,
	getProjectTasksToCopy: () => [],
	applyProjectTaskVisibility: async (workspace: string, hide: boolean) => {
		if ((await mocks.commands()).includes("ivol.refreshProjectTaskStorage"))
			await mocks.execute("ivol.refreshProjectTaskStorage")
		else await mocks.update("exclude", { "*.tmp": true, ".ivol": hide }, 3)
	},
}))
vi.mock("../../../../utils/storage", () => ({ getStorageBasePath: async () => "/global" }))
vi.mock("vscode", () => ({
	commands: { getCommands: mocks.commands, executeCommand: mocks.execute },
	Uri: { file: (value: string) => value },
	workspace: {
		getConfiguration: () => ({
			inspect: () => ({ workspaceFolderValue: { "*.tmp": true } }),
			update: mocks.update,
		}),
	},
	ConfigurationTarget: { WorkspaceFolder: 3 },
}))
function provider(task?: object) {
	return {
		cwd: "/project",
		getCurrentTask: () => task,
		postMessageToWebview: vi.fn(),
		refreshProjectTaskHistory: vi.fn(),
		contextProxy: { globalStorageUri: { fsPath: "/global" }, rawContext: { globalState: { get: () => [] } } },
	} as unknown as ClineProvider
}
beforeEach(() => {
	vi.clearAllMocks()
	mocks.commands.mockResolvedValue([])
	mocks.read.mockReturnValue({ enabled: true, hide: true })
	mocks.copy.mockResolvedValue(2)
})
it("rejects mutation while the current task remains open", async () => {
	const host = provider({})
	await handleProjectTaskStorage(host, {
		type: "setProjectTaskStorage",
		projectTaskStorage: { enabled: true, hide: true },
	})
	expect(mocks.configure).not.toHaveBeenCalled()
	expect(host.postMessageToWebview).toHaveBeenCalledWith(
		expect.objectContaining({
			projectTaskStorage: expect.objectContaining({ busy: true, error: expect.stringContaining("Close") }),
		}),
	)
})
it("saves VS Code folder visibility without dropping other exclusions", async () => {
	const host = provider()
	await handleProjectTaskStorage(host, {
		type: "setProjectTaskStorage",
		projectTaskStorage: { enabled: true, hide: true },
	})
	expect(mocks.update).toHaveBeenCalledWith("exclude", { "*.tmp": true, ".ivol": true }, 3)
	expect(mocks.copy).not.toHaveBeenCalled()
	expect(host.refreshProjectTaskHistory).toHaveBeenCalled()
})
it("uses JetBrains project tree refresh instead of unsupported configuration updates", async () => {
	mocks.commands.mockResolvedValue(["ivol.refreshProjectTaskStorage"])
	await handleProjectTaskStorage(provider(), {
		type: "setProjectTaskStorage",
		projectTaskStorage: { enabled: true, hide: false },
	})
	expect(mocks.execute).toHaveBeenCalledWith("ivol.refreshProjectTaskStorage")
	expect(mocks.update).not.toHaveBeenCalled()
})
it("copies only on the separate explicit action and refreshes history", async () => {
	const host = provider()
	await handleProjectTaskStorage(host, { type: "copyTasksToProject" })
	expect(mocks.copy).toHaveBeenCalledWith("/project", "/global", [])
	expect(host.postMessageToWebview).toHaveBeenCalledWith(
		expect.objectContaining({ projectTaskStorage: expect.objectContaining({ copied: 2 }) }),
	)
})
