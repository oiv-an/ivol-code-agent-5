// kilocode_change - new file
import * as fs from "node:fs/promises"
import { writeFileSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import type { HistoryItem, ProjectTaskCopyProgress } from "@roo-code/types"

import type { ExtensionContext, TextDocumentWillSaveEvent } from "vscode"
import { ContextProxy } from "../../../core/config/ContextProxy"
import { RepoPerTaskCheckpointService } from "../../checkpoints/RepoPerTaskCheckpointService"
vi.mock("../../search/file-search", () => ({ executeRipgrep: vi.fn(async () => []) }))
vi.mock("@roo-code/telemetry", () => ({ TelemetryService: { instance: { captureEvent: vi.fn() } } }))

const environment = vi.hoisted(() => ({
	workspaceFolders: [] as { uri: { scheme: string; fsPath: string } }[],
	isTrusted: true,
	dirty: false,
	saveSucceeds: true,
	beforeSave: undefined as ((event: TextDocumentWillSaveEvent) => void) | undefined,
}))
vi.mock("vscode", async () => {
	const fs = await import("node:fs/promises")
	type Uri = { scheme: string; fsPath: string }
	const documents = new Map<string, ReturnType<typeof makeDocument>>()
	function makeDocument(uri: Uri, content: string) {
		return {
			uri,
			content,
			isDirty: environment.dirty,
			getText() {
				return this.content
			},
			positionAt(offset: number) {
				return offset
			},
			async save() {
				if (!environment.saveSucceeds) return false
				await fs.writeFile(uri.fsPath, this.content)
				this.isDirty = false
				return true
			},
		}
	}
	class WorkspaceEdit {
		operations: { uri: Uri; text?: string }[] = []
		createFile(uri: Uri) {
			this.operations.push({ uri })
		}
		insert(uri: Uri, _position: number, text: string) {
			this.operations.push({ uri, text })
		}
	}
	return {
		workspace: {
			get workspaceFolders() {
				return environment.workspaceFolders
			},
			get isTrusted() {
				return environment.isTrusted
			},
			onWillSaveTextDocument(callback: (event: TextDocumentWillSaveEvent) => void) {
				environment.beforeSave = callback
				return {
					dispose() {
						environment.beforeSave = undefined
					},
				}
			},
			async openTextDocument(uri: Uri) {
				const document = makeDocument(uri, await fs.readFile(uri.fsPath, "utf8"))
				documents.set(uri.fsPath, document)
				return document
			},
			async applyEdit(edit: WorkspaceEdit) {
				for (const { uri, text } of edit.operations) {
					if (text === undefined) {
						try {
							await fs.writeFile(uri.fsPath, "", { flag: "wx" })
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
						}
					} else {
						const document = documents.get(uri.fsPath)!
						document.content += text
						document.isDirty = true
					}
				}
				return true
			},
		},
		Uri: { file: (fsPath: string) => ({ scheme: "file", fsPath }) },
		WorkspaceEdit,
		TextEdit: { insert: (position: number, newText: string) => ({ position, newText }) },
		commands: { getCommands: async () => ["ivol.refreshProjectTaskStorage"], executeCommand: vi.fn() },
	}
})
import {
	configureProjectTaskStorage,
	readProjectTaskStorage,
	mergeProjectTaskHistory,
	resolveProjectTaskDirectory,
	updateProjectTaskHistory,
	copyTasksToProject,
	assertProjectTaskWritable,
	prepareProjectTaskStorage,
	getProjectTasksToCopy,
	ensureProjectTaskIgnore,
} from "../project-task-storage"

let root: string
let workspace: string
let globalBase: string
const item = (id = randomUUID()): HistoryItem => ({
	id,
	number: 1,
	ts: 1,
	task: "Project task",
	tokensIn: 3,
	tokensOut: 4,
	totalCost: 0,
	workspace,
})
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "ivol-project-storage-"))
	workspace = path.join(root, "project")
	globalBase = path.join(root, "global")
	await fs.mkdir(workspace)
	environment.workspaceFolders = [{ uri: { scheme: "file", fsPath: workspace } }]
	environment.isTrusted = true
	environment.dirty = false
	environment.saveSucceeds = true
})
afterEach(async () => {
	environment.workspaceFolders = []
	await fs.rm(root, { recursive: true, force: true })
})

async function enable() {
	await configureProjectTaskStorage(workspace, true, true)
}
async function save(entry: HistoryItem) {
	const directory = resolveProjectTaskDirectory(entry.id, workspace, true)!
	await fs.mkdir(directory, { recursive: true })
	await fs.writeFile(path.join(directory, "ui_messages.json"), "[]")
	await updateProjectTaskHistory([], [entry])
	return directory
}

describe("portable project task storage", () => {
	it("defaults new tasks to local without moving old tasks or creating files on read", async () => {
		const entry = item()
		expect(readProjectTaskStorage(workspace)).toBeUndefined()
		expect(resolveProjectTaskDirectory(entry.id, workspace, false)).toBeUndefined()
		expect(resolveProjectTaskDirectory(item().id, workspace, true)).toContain(".ivol/tasks/")
		expect(readProjectTaskStorage(workspace)).toBeUndefined()
		await prepareProjectTaskStorage(workspace)
		expect(readProjectTaskStorage(workspace)).toMatchObject({ enabled: true, hide: true })
		expect(mergeProjectTaskHistory([entry])).toEqual([entry])
	})
	it("creates a stable identity and idempotent Git exclusion, preserving unrelated content", async () => {
		await fs.writeFile(path.join(workspace, ".gitignore"), "node_modules/")
		await enable()
		const id = readProjectTaskStorage(workspace)!.projectId
		await configureProjectTaskStorage(workspace, true, false)
		expect(readProjectTaskStorage(workspace)).toMatchObject({ projectId: id, hide: false })
		const ignore = await fs.readFile(path.join(workspace, ".gitignore"), "utf8")
		expect(ignore).toBe("node_modules/")
		const privateIgnore = await fs.readFile(path.join(workspace, ".ivol/.gitignore"), "utf8")
		expect(privateIgnore).toBe("# Private IVOL task history\n*\n")
		execFileSync("git", ["init", "-q"], { cwd: workspace })
		expect(execFileSync("git", ["check-ignore", ".ivol/project.json"], { cwd: workspace }).toString().trim()).toBe(
			".ivol/project.json",
		)
	})
	it("does not rewrite an effective exclusion followed by unrelated rules while the editor is dirty", async () => {
		const content = "/.ivol/\n/CURRENT_TASK.md\n/vendor/\n"
		await fs.writeFile(path.join(workspace, ".gitignore"), content)
		environment.dirty = true
		await Promise.all([ensureProjectTaskIgnore(workspace), ensureProjectTaskIgnore(workspace)])
		expect(await fs.readFile(path.join(workspace, ".gitignore"), "utf8")).toBe(content)
	})
	it("saves history without touching a dirty or unsaveable root ignore document", async () => {
		const file = path.join(workspace, ".gitignore")
		const content = "vendor/\r\n!/.ivol/\r\n!/.ivol/**\r\n"
		await fs.writeFile(file, content)
		const before = await fs.stat(file)
		environment.dirty = true
		environment.saveSucceeds = false
		await enable()
		await save(item())
		await Promise.all(Array.from({ length: 10 }, () => ensureProjectTaskIgnore(workspace)))
		expect(await fs.readFile(file, "utf8")).toBe(content)
		expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs)
	})
	it("never creates a root ignore and protects history after git init", async () => {
		await enable()
		await save(item())
		await expect(fs.stat(path.join(workspace, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" })
		execFileSync("git", ["init", "-q"], { cwd: workspace })
		expect(
			execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: workspace }).toString(),
		).toBe("")
	})
	it("protects a nested workspace without editing the repository ignore", async () => {
		execFileSync("git", ["init", "-q"], { cwd: root })
		await fs.writeFile(path.join(root, ".gitignore"), "!**/.ivol/**\n")
		await enable()
		await save(item())
		expect(
			execFileSync("git", ["check-ignore", "project/.ivol/project.json", "project/.ivol/.gitignore"], {
				cwd: root,
			})
				.toString()
				.trim()
				.split("\n"),
		).toHaveLength(2)
		expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toBe("!**/.ivol/**\n")
		await expect(fs.stat(path.join(workspace, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" })
	})
	it("repairs private protection idempotently and refuses a symlinked private ignore", async () => {
		await enable()
		const file = path.join(workspace, ".ivol/.gitignore")
		await fs.writeFile(file, "# existing\r\n*\r\n!project.json\r\n")
		await ensureProjectTaskIgnore(workspace)
		const repaired = await fs.readFile(file, "utf8")
		expect(repaired).toBe("# existing\r\n*\r\n!project.json\r\n# Private IVOL task history\r\n*\r\n")
		await ensureProjectTaskIgnore(workspace)
		expect(await fs.readFile(file, "utf8")).toBe(repaired)
		await fs.unlink(file)
		await fs.writeFile(path.join(root, "outside"), "unchanged")
		await fs.symlink(path.join(root, "outside"), file)
		await expect(ensureProjectTaskIgnore(workspace)).rejects.toThrow("symbolic")
		expect(await fs.readFile(path.join(root, "outside"), "utf8")).toBe("unchanged")
	})
	it("rehydrates a moved project's index with its new root and reads the same files", async () => {
		await enable()
		const entry = item()
		await save(entry)
		const raw = JSON.parse(await fs.readFile(path.join(workspace, ".ivol/task-history.json"), "utf8"))
		expect(raw.items[0].workspace).toBe(".")
		const moved = path.join(root, "moved")
		await fs.rename(workspace, moved)
		environment.workspaceFolders = [{ uri: { scheme: "file", fsPath: moved } }]
		expect(mergeProjectTaskHistory([])).toEqual([{ ...entry, workspace: moved }])
		expect(await fs.readFile(path.join(resolveProjectTaskDirectory(entry.id)!, "ui_messages.json"), "utf8")).toBe(
			"[]",
		)
	})
	it("does not move existing global tasks when enabled; disabling only changes new tasks", async () => {
		await enable()
		const old = item()
		expect(resolveProjectTaskDirectory(old.id, workspace, false)).toBeUndefined()
		const local = item()
		const directory = await save(local)
		await configureProjectTaskStorage(workspace, false, false)
		expect(resolveProjectTaskDirectory(local.id)).toBe(directory)
		expect(resolveProjectTaskDirectory(item().id, workspace, true)).toBeUndefined()
		expect(mergeProjectTaskHistory([old])).toEqual([old, local])
	})
	it("merges concurrent additions and stale metadata deltas without losing other tasks", async () => {
		await enable()
		const a = item(),
			b = item()
		resolveProjectTaskDirectory(a.id, workspace, true)
		resolveProjectTaskDirectory(b.id, workspace, true)
		await Promise.all([updateProjectTaskHistory([], [a]), updateProjectTaskHistory([], [b])])
		expect(mergeProjectTaskHistory([])).toHaveLength(2)
		await Promise.all([
			updateProjectTaskHistory([a, b], [{ ...a, isFavorited: true }, b]),
			updateProjectTaskHistory([a, b], [{ ...a, tokensIn: 42 }, b]),
		])
		expect(mergeProjectTaskHistory([]).find((entry) => entry.id === a.id)).toMatchObject({
			isFavorited: true,
			tokensIn: 42,
		})
	})
	it("keeps tombstones so stale windows and global originals cannot resurrect deleted tasks", async () => {
		await enable()
		const entry = item()
		await save(entry)
		await updateProjectTaskHistory([entry], [])
		await updateProjectTaskHistory([entry], [{ ...entry, tokensIn: 77 }])
		expect(mergeProjectTaskHistory([entry])).toEqual([])
		expect(() => assertProjectTaskWritable(entry.id)).toThrow("deleted")
	})
	it("copies only current-project history, preserves originals and skips existing local tasks", async () => {
		await enable()
		const entry = item()
		expect(getProjectTasksToCopy(workspace, [entry, { ...item(), workspace: "/other" }])).toEqual([entry])
		const source = path.join(globalBase, "tasks", entry.id)
		await fs.mkdir(source, { recursive: true })
		await fs.writeFile(path.join(source, "ui_messages.json"), '[{"text":"private"}]')
		expect(await copyTasksToProject(workspace, globalBase, [entry, { ...item(), workspace: "/other" }])).toBe(1)
		expect(await fs.readFile(path.join(source, "ui_messages.json"), "utf8")).toContain("private")
		expect(mergeProjectTaskHistory([entry])).toEqual([entry])
		expect(await copyTasksToProject(workspace, globalBase, [entry])).toBe(0)
		expect(getProjectTasksToCopy(workspace, [entry])).toEqual([])
	})
	it("reports phases and counts only verified, indexed copies, preserving partial progress on failure", async () => {
		await enable()
		const first = item(),
			second = item(),
			local = item()
		await save(local)
		const source = path.join(globalBase, "tasks", first.id)
		await fs.mkdir(source, { recursive: true })
		await fs.writeFile(path.join(source, "ui_messages.json"), "[]")
		const events: ProjectTaskCopyProgress[] = []
		const indexed: number[] = []
		await expect(
			copyTasksToProject(workspace, globalBase, [local, first, second], (progress) => {
				events.push(progress)
				indexed.push(mergeProjectTaskHistory([]).filter((entry) => entry.id === first.id).length)
			}),
		).rejects.toThrow()
		expect(events.map(({ phase, copied, total }) => [phase, copied, total])).toEqual([
			["preparing", 0, 2],
			["verifying", 0, 2],
			["copying", 0, 2],
			["verifying", 0, 2],
			["verifying", 1, 2],
			["verifying", 1, 2],
		])
		expect(indexed).toEqual([0, 0, 0, 0, 1, 1])
		expect(await fs.readFile(path.join(source, "ui_messages.json"), "utf8")).toBe("[]")
	})
	it("does not count a copy when its source changes during verification", async () => {
		await enable()
		const entry = item()
		const source = path.join(globalBase, "tasks", entry.id)
		await fs.mkdir(source, { recursive: true })
		await fs.writeFile(path.join(source, "ui_messages.json"), "[]")
		const events: ProjectTaskCopyProgress[] = []
		await expect(
			copyTasksToProject(workspace, globalBase, [entry], (progress) => {
				events.push(progress)
				if (progress.phase === "copying") writeFileSync(path.join(source, "extra.json"), "[]")
			}),
		).rejects.toThrow("changed while copying")
		expect(events.every((progress) => progress.copied === 0)).toBe(true)
		expect(mergeProjectTaskHistory([])).toEqual([])
	})
	it("relocates local checkpoints and never snapshots the private task folder", async () => {
		await enable()
		const entry = item()
		await save(entry)
		await fs.writeFile(path.join(workspace, "source.txt"), "before")
		const service = RepoPerTaskCheckpointService.create({
			taskId: entry.id,
			workspaceDir: workspace,
			shadowDir: globalBase,
			log: () => undefined,
		})
		await service.initShadowGit()
		const moved = path.join(root, "moved-checkpoints")
		await fs.rename(workspace, moved)
		environment.workspaceFolders = [{ uri: { scheme: "file", fsPath: moved } }]
		const reopened = RepoPerTaskCheckpointService.create({
			taskId: entry.id,
			workspaceDir: moved,
			shadowDir: globalBase,
			log: () => undefined,
		})
		await reopened.initShadowGit()
		const shadow = path.join(moved, ".ivol/tasks", entry.id, "checkpoints")
		expect(execFileSync("git", ["config", "core.worktree"], { cwd: shadow }).toString().trim()).toBe(moved)
		const tracked = execFileSync("git", ["ls-tree", "--full-tree", "-r", "--name-only", "HEAD"], {
			cwd: shadow,
		}).toString()
		expect(tracked).toContain("source.txt")
		expect(tracked).not.toContain(".ivol/")
		await fs.writeFile(path.join(moved, "source.txt"), "after")
		expect(await reopened.saveCheckpoint("after move")).toBeDefined()
	})
	it("keeps global originals unchanged through local updates and deletion via ContextProxy", async () => {
		await enable()
		const entry = item()
		await save(entry)
		const unrelated = { ...item(), workspace: "/other" }
		let global = [entry, unrelated]
		const update = vi.fn(async (_key: string, value: HistoryItem[]) => {
			global = value
		})
		const proxy = new ContextProxy({ globalState: { get: () => global, update } } as unknown as ExtensionContext)
		const history = proxy.getGlobalState("taskHistory")!
		await proxy.updateGlobalState(
			"taskHistory",
			history.map((row) => (row.id === entry.id ? { ...row, tokensIn: 99 } : row)),
		)
		expect(update).not.toHaveBeenCalled()
		expect(proxy.getGlobalState("taskHistory")!.find((row) => row.id === entry.id)?.tokensIn).toBe(99)
		await proxy.updateGlobalState(
			"taskHistory",
			proxy.getGlobalState("taskHistory")!.filter((row) => row.id !== entry.id),
		)
		expect(global).toEqual([entry, unrelated])
		expect(proxy.getGlobalState("taskHistory")).toEqual([unrelated])
	})
	it("protects history despite parent Git negations without modifying them", async () => {
		await enable()
		execFileSync("git", ["init", "-q"], { cwd: workspace })
		await fs.appendFile(path.join(workspace, ".gitignore"), "!/.ivol/\n!/.ivol/**\n")
		await enable()
		expect(execFileSync("git", ["check-ignore", ".ivol/project.json"], { cwd: workspace }).toString().trim()).toBe(
			".ivol/project.json",
		)
		expect(await fs.readFile(path.join(workspace, ".gitignore"), "utf8")).toContain("!/.ivol/**")
	})
	it("fails closed on malformed indexes, traversal and symlinked storage", async () => {
		expect(() => resolveProjectTaskDirectory("../outside")).toThrow("identifier")
		await fs.symlink(globalBase, path.join(workspace, ".ivol"))
		await expect(enable()).rejects.toThrow("symbolic")
		await fs.unlink(path.join(workspace, ".ivol"))
		await enable()
		await fs.writeFile(path.join(workspace, ".ivol/task-history.json"), "broken")
		expect(() => mergeProjectTaskHistory([])).toThrow()
	})
	it("refuses tracked history and untrusted workspaces", async () => {
		environment.isTrusted = false
		await expect(enable()).rejects.toThrow("Trust")
		environment.isTrusted = true
		execFileSync("git", ["init", "-q"], { cwd: workspace })
		await fs.mkdir(path.join(workspace, ".ivol"))
		await fs.writeFile(path.join(workspace, ".ivol/private.txt"), "private")
		execFileSync("git", ["add", ".ivol/private.txt"], { cwd: workspace })
		await expect(enable()).rejects.toThrow("already tracked")
	})
})
