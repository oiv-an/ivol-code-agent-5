// kilocode_change - new file
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import type { HistoryItem } from "@roo-code/types"

import type { ExtensionContext } from "vscode"
import { ContextProxy } from "../../../core/config/ContextProxy"
import { RepoPerTaskCheckpointService } from "../../checkpoints/RepoPerTaskCheckpointService"
vi.mock("../../search/file-search", () => ({ executeRipgrep: vi.fn(async () => []) }))
vi.mock("@roo-code/telemetry", () => ({ TelemetryService: { instance: { captureEvent: vi.fn() } } }))

const environment = vi.hoisted(() => ({
	workspaceFolders: [] as { uri: { scheme: string; fsPath: string } }[],
	isTrusted: true,
}))
vi.mock("vscode", () => ({
	workspace: environment,
	commands: { getCommands: async () => ["ivol.refreshProjectTaskStorage"], executeCommand: vi.fn() },
}))
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
		expect(ignore.startsWith("node_modules/\n")).toBe(true)
		expect(ignore.match(/\/\.ivol\//g)).toHaveLength(1)
		execFileSync("git", ["init", "-q"], { cwd: workspace })
		expect(execFileSync("git", ["check-ignore", ".ivol/project.json"], { cwd: workspace }).toString().trim()).toBe(
			".ivol/project.json",
		)
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
	it("repairs a later Git negation without removing unrelated rules", async () => {
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
