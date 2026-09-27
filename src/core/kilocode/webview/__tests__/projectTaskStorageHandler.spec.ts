// kilocode_change - new file
import { handleProjectTaskStorage } from "../projectTaskStorageHandler"
import type { ClineProvider } from "../../../webview/ClineProvider"
import type { ProjectTaskCopyProgress } from "@roo-code/types"

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
let project = 0
function provider(task?: object) {
	return {
		cwd: `/project-${project++}`,
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
	expect(mocks.copy).toHaveBeenCalledWith(host.cwd, "/global", [], expect.any(Function))
	expect(host.postMessageToWebview).toHaveBeenCalledWith(
		expect.objectContaining({ projectTaskStorage: expect.objectContaining({ copied: 2 }) }),
	)
})

it("restores active progress, rejects duplicate starts and retains partial failure on return", async () => {
	const host = provider()
	let report!: (progress: ProjectTaskCopyProgress) => void
	let reject!: (error: Error) => void
	let started!: () => void
	const ready = new Promise<void>((resolve) => {
		started = resolve
	})
	mocks.copy.mockImplementationOnce((_workspace, _base, _history, callback) => {
		report = callback
		started()
		return new Promise<number>((_resolve, fail) => {
			reject = fail
		})
	})
	const running = handleProjectTaskStorage(host, { type: "copyTasksToProject" })
	await ready
	report({ phase: "verifying", copied: 1, total: 3 })
	await handleProjectTaskStorage(host, { type: "getProjectTaskStorage" })
	expect(host.postMessageToWebview).toHaveBeenLastCalledWith(
		expect.objectContaining({
			projectTaskStorage: expect.objectContaining({
				busy: true,
				copied: 1,
				copyProgress: { phase: "verifying", copied: 1, total: 3 },
			}),
		}),
	)
	await handleProjectTaskStorage(host, { type: "copyTasksToProject" })
	await handleProjectTaskStorage(host, {
		type: "setProjectTaskStorage",
		projectTaskStorage: { enabled: false, hide: false },
	})
	expect(mocks.copy).toHaveBeenCalledTimes(1)
	expect(mocks.configure).not.toHaveBeenCalled()
	reject(new Error("Verification failed"))
	await running
	await handleProjectTaskStorage(host, { type: "getProjectTaskStorage" })
	expect(host.postMessageToWebview).toHaveBeenLastCalledWith(
		expect.objectContaining({
			projectTaskStorage: expect.objectContaining({
				busy: false,
				copied: 1,
				error: "Verification failed",
				copyProgress: { phase: "failed", copied: 1, total: 3 },
			}),
		}),
	)
})

it("does not fail the copy when the webview is disconnected and restores completion", async () => {
	const host = provider()
	vi.mocked(host.postMessageToWebview).mockRejectedValueOnce(new Error("Disconnected"))
	await handleProjectTaskStorage(host, { type: "copyTasksToProject" })
	await handleProjectTaskStorage(host, { type: "getProjectTaskStorage" })
	expect(host.postMessageToWebview).toHaveBeenLastCalledWith(
		expect.objectContaining({
			projectTaskStorage: expect.objectContaining({
				busy: false,
				copied: 2,
				error: undefined,
				copyProgress: expect.objectContaining({ phase: "completed" }),
			}),
		}),
	)
})
