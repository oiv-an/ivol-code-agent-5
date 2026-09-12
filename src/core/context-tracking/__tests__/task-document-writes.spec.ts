// kilocode_change - new file
import fs from "fs/promises"
import * as vscode from "vscode"
import { FileContextTracker } from "../FileContextTracker"
import type { ClineProvider } from "../../webview/ClineProvider"

vi.mock("fs/promises", () => ({ default: { lstat: vi.fn() } }))
vi.mock("../../webview/ClineProvider", () => ({ ClineProvider: vi.fn() }))

function tracker(taskId = "task") {
	const result = new FileContextTracker({} as ClineProvider, taskId)
	vi.spyOn(result, "addFileToFileContextTracker").mockResolvedValue(undefined)
	vi.spyOn(result, "setupFileWatcher").mockResolvedValue(undefined)
	return result
}

describe("ordinary task document write evidence", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		Object.defineProperty(vscode.workspace, "workspaceFolders", {
			configurable: true,
			value: [{ uri: { fsPath: "/project" } }],
		})
		vi.mocked(fs.lstat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof fs.lstat>>)
	})

	it("counts only root file edits during the observation", async () => {
		const subject = tracker()
		await subject.trackFileContext("CURRENT_TASK.md", "roo_edited")
		const observation = subject.observeTaskDocumentWrites("/project")
		expect(observation.wasWritten()).toBe(false)
		for (const operation of ["read_tool", "file_mentioned", "user_edited"] as const) {
			await subject.trackFileContext("CURRENT_TASK.md", operation)
		}
		await subject.trackFileContext("nested/CURRENT_TASK.md", "roo_edited")
		await subject.trackFileContext("/other/CURRENT_TASK.md", "roo_edited")
		expect(observation.wasWritten()).toBe(false)
		await subject.trackFileContext("./CURRENT_TASK.md", "roo_edited")
		expect(observation.wasWritten()).toBe(true)
		observation.dispose()
		expect(subject.observeTaskDocumentWrites("/project").wasWritten()).toBe(false)
	})

	it("does not share evidence with another task", async () => {
		const first = tracker("first")
		const observation = first.observeTaskDocumentWrites("/project")
		await tracker("second").trackFileContext("CURRENT_TASK.md", "roo_edited")
		expect(observation.wasWritten()).toBe(false)
	})

	it("rejects missing workspaces, deleted files, directories and symlinks", async () => {
		const subject = tracker()
		const observation = subject.observeTaskDocumentWrites("/project")
		Object.defineProperty(vscode.workspace, "workspaceFolders", { value: undefined })
		await subject.trackFileContext("CURRENT_TASK.md", "roo_edited")
		expect(observation.wasWritten()).toBe(false)
		Object.defineProperty(vscode.workspace, "workspaceFolders", { value: [{ uri: { fsPath: "/project" } }] })
		vi.mocked(fs.lstat).mockResolvedValue({ isFile: () => false } as Awaited<ReturnType<typeof fs.lstat>>)
		await subject.trackFileContext("CURRENT_TASK.md", "roo_edited")
		expect(observation.wasWritten()).toBe(false)
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
		vi.mocked(fs.lstat).mockRejectedValue(new Error("ENOENT"))
		await subject.trackFileContext("CURRENT_TASK.md", "roo_edited")
		expect(observation.wasWritten()).toBe(false)
		expect(log).toHaveBeenCalled()
		log.mockRestore()
	})

	it("does not credit an in-flight observation to its replacement", async () => {
		const subject = tracker()
		const old = subject.observeTaskDocumentWrites("/project")
		let resolve!: (stat: Awaited<ReturnType<typeof fs.lstat>>) => void
		vi.mocked(fs.lstat).mockReturnValue(new Promise((done) => (resolve = done)))
		const pending = subject.trackFileContext("CURRENT_TASK.md", "roo_edited")
		old.dispose()
		const current = subject.observeTaskDocumentWrites("/project")
		resolve({ isFile: () => true } as Awaited<ReturnType<typeof fs.lstat>>)
		await pending
		expect(old.wasWritten()).toBe(false)
		expect(current.wasWritten()).toBe(false)
	})
})
