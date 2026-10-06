// kilocode_change - new file
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { randomUUID, createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as vscode from "vscode"
import type { HistoryItem, ProjectTaskCopyProgress } from "@roo-code/types"
import { historyItemSchema } from "@roo-code/types"
import { safeWriteJson } from "../../utils/safeWriteJson"
import * as lockfile from "proper-lockfile"

const exec = promisify(execFile)
const DIRECTORY = ".ivol"
const CONFIG = "project.json"
const INDEX = "task-history.json"
const taskLocations = new Map<string, string>()
const preparations = new Map<string, Promise<void>>()
const ignoreUpdates = new Map<string, Promise<void>>()

export interface ProjectTaskStorageConfig {
	version: 1
	projectId: string
	enabled: boolean
	hide: boolean
}
interface ProjectIndex {
	version: 1
	items: HistoryItem[]
	deletedIds: string[]
}

export function validateTaskId(id: string): void {
	if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid task identifier")
}

function assertNotSymlink(file: string): void {
	try {
		if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Task storage must not use symbolic links: ${file}`)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
}

export function projectStorageRoot(workspace: string): string {
	const root = path.join(workspace, DIRECTORY)
	assertNotSymlink(root)
	return root
}

export function readProjectTaskStorage(workspace: string): ProjectTaskStorageConfig | undefined {
	if (!workspace) return undefined
	const file = path.join(projectStorageRoot(workspace), CONFIG)
	assertNotSymlink(file)
	let value: ProjectTaskStorageConfig
	try {
		value = JSON.parse(fs.readFileSync(file, "utf8"))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw error
	}
	if (
		value.version !== 1 ||
		typeof value.projectId !== "string" ||
		typeof value.enabled !== "boolean" ||
		typeof value.hide !== "boolean"
	) {
		throw new Error(`Invalid project task storage configuration: ${file}`)
	}
	return value
}

function workspaceRoots(): string[] {
	return (vscode.workspace?.workspaceFolders ?? [])
		.filter((folder) => folder.uri.scheme === "file")
		.map((folder) => folder.uri.fsPath)
}

function readIndex(workspace: string): ProjectIndex {
	const file = path.join(projectStorageRoot(workspace), INDEX)
	assertNotSymlink(file)
	let data: ProjectIndex
	try {
		data = JSON.parse(fs.readFileSync(file, "utf8"))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, items: [], deletedIds: [] }
		throw error
	}
	if (data.version !== 1 || !Array.isArray(data.items) || !Array.isArray(data.deletedIds)) {
		throw new Error(`Invalid project task index: ${file}`)
	}
	data.items = data.items.map((item) => {
		const parsed = historyItemSchema.parse(item)
		validateTaskId(parsed.id)
		return parsed
	})
	data.deletedIds.forEach(validateTaskId)
	return data
}

export function hasProjectTaskStorage(): boolean {
	return workspaceRoots().some((workspace) => !!readProjectTaskStorage(workspace))
}

export function getLocalTaskIds(): Set<string> {
	const ids = new Set<string>()
	for (const workspace of workspaceRoots()) {
		if (!readProjectTaskStorage(workspace)) continue
		const index = readIndex(workspace)
		for (const id of [...index.items.map((item) => item.id), ...index.deletedIds]) ids.add(id)
	}
	return ids
}

/** Merge local indexes into the IDE history without persisting machine-specific paths locally. */
export function mergeProjectTaskHistory(global: HistoryItem[]): HistoryItem[] {
	const result = new Map(global.map((item) => [item.id, item]))
	for (const workspace of workspaceRoots()) {
		if (!readProjectTaskStorage(workspace)) continue
		const index = readIndex(workspace)
		for (const id of index.deletedIds) result.delete(id)
		for (const item of index.items) {
			result.set(item.id, { ...item, workspace })
		}
	}
	return [...result.values()]
}

/** Pin an existing task to its original store. Changing the default never moves a live task. */
export function resolveProjectTaskDirectory(taskId: string, workspace?: string, isNew = false): string | undefined {
	validateTaskId(taskId)
	const pinned = taskLocations.get(taskId)
	if (pinned && workspaceRoots().some((root) => pinned === path.join(root, DIRECTORY, "tasks", taskId))) {
		assertNotSymlink(path.dirname(path.dirname(pinned)))
		assertNotSymlink(path.dirname(pinned))
		assertNotSymlink(pinned)
		return pinned
	}
	const roots = workspace ? [workspace, ...workspaceRoots().filter((root) => root !== workspace)] : workspaceRoots()
	for (const root of roots) {
		const config = readProjectTaskStorage(root)
		const index: ProjectIndex = config ? readIndex(root) : { version: 1, items: [], deletedIds: [] }
		const indexed = index.items.some((item) => item.id === taskId) || index.deletedIds.includes(taskId)
		const defaultLocal = workspaceRoots().includes(root) && vscode.workspace.isTrusted !== false
		if (indexed || (isNew && root === workspace && (config?.enabled ?? defaultLocal))) {
			const directory = path.join(projectStorageRoot(root), "tasks", taskId)
			assertNotSymlink(path.dirname(directory))
			assertNotSymlink(directory)
			taskLocations.set(taskId, directory)
			return directory
		}
	}
	return undefined
}

export function pinTaskDirectory(taskId: string, directory: string): void {
	validateTaskId(taskId)
	taskLocations.set(taskId, directory)
}

function localWorkspaceForTask(id: string): string | undefined {
	const directory = resolveProjectTaskDirectory(id)
	if (!directory) return undefined
	return workspaceRoots().find((root) => directory === path.join(root, DIRECTORY, "tasks", id))
}

export function assertProjectTaskWritable(taskId: string): void {
	const workspace = localWorkspaceForTask(taskId)
	if (workspace && readIndex(workspace).deletedIds.includes(taskId))
		throw new Error("This project task has been deleted in another window.")
}

/** Apply only changed items under the atomic writer's cross-process lock. */
export async function updateProjectTaskHistory(previous: HistoryItem[], next: HistoryItem[]): Promise<HistoryItem[]> {
	const before = new Map(previous.map((item) => [item.id, item]))
	const after = new Map(next.map((item) => [item.id, item]))
	const changes = new Map<string, string[]>()
	for (const id of new Set([...before.keys(), ...after.keys()])) {
		if (JSON.stringify(before.get(id)) === JSON.stringify(after.get(id))) continue
		const workspace = localWorkspaceForTask(id)
		if (workspace) changes.set(workspace, [...(changes.get(workspace) ?? []), id])
	}
	for (const [workspace, ids] of changes) {
		await ensureProjectTaskIgnore(workspace)
		const output: ProjectIndex = { version: 1, items: [], deletedIds: [] }
		await safeWriteJson(path.join(projectStorageRoot(workspace), INDEX), output, async () => {
			const latest = readIndex(workspace)
			const items = new Map(latest.items.map((item) => [item.id, item]))
			const deleted = new Set(latest.deletedIds)
			for (const id of ids) {
				const item = after.get(id)
				if (!item) {
					items.delete(id)
					deleted.add(id)
				} else if (!deleted.has(id)) {
					const old = before.get(id)
					const delta = Object.fromEntries(
						Object.entries(item).filter(
							([key, value]) => JSON.stringify(value) !== JSON.stringify(old?.[key as keyof HistoryItem]),
						),
					)
					items.set(id, { ...(items.get(id) ?? item), ...delta, id, workspace: "." } as HistoryItem)
				}
			}
			output.items = [...items.values()]
			output.deletedIds = [...deleted]
		})
	}
	return next.filter((item) => !localWorkspaceForTask(item.id))
}

/** Protect history inside its own directory; never edit a project's shared .gitignore. */
export async function ensureProjectTaskIgnore(workspace: string): Promise<void> {
	let pending = ignoreUpdates.get(workspace)
	if (!pending) {
		pending = updateProjectTaskIgnore(workspace)
		ignoreUpdates.set(workspace, pending)
	}
	try {
		await pending
	} finally {
		if (ignoreUpdates.get(workspace) === pending) ignoreUpdates.delete(workspace)
	}
}

async function updateProjectTaskIgnore(workspace: string): Promise<void> {
	const root = projectStorageRoot(workspace)
	await fsp.mkdir(root, { recursive: true, mode: 0o700 })
	const file = path.join(root, ".gitignore")
	assertNotSymlink(file)
	// A nested ignore takes precedence over parent negations, also before git init
	// and when the workspace is a subdirectory of a repository. It ignores itself.
	// Serialize creation/repair across extension hosts without touching editor buffers.
	const release = await lockfile.lock(root, {
		lockfilePath: path.join(root, ".gitignore.lock"),
		realpath: false,
		retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
	})
	try {
		let existing = ""
		try {
			existing = await fsp.readFile(file, "utf8")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		if (existing.trimEnd().split(/\r?\n/).at(-1) !== "*") {
			const eol = existing.includes("\r\n") ? "\r\n" : "\n"
			await fsp.appendFile(
				file,
				`${existing && !existing.endsWith("\n") ? eol : ""}# Private IVOL task history${eol}*${eol}`,
				{ mode: 0o600 },
			)
		}
	} finally {
		await release()
	}
	try {
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
		const { stdout } = await exec("git", ["ls-files", "--", ".ivol"], {
			cwd: workspace,
			env: { ...env, LC_ALL: "C" },
		})
		if (stdout.trim())
			throw new Error(
				"Project task history is already tracked by Git. Untrack .ivol before enabling local storage.",
			)
	} catch (error) {
		// A directory without Git is supported; other Git failures must not silently bypass protection.
		if (!String((error as { stderr?: string }).stderr).includes("not a git repository")) throw error
	}
}

/** Initialize only on the first actual task write, never by merely viewing settings. */
export async function prepareProjectTaskStorage(workspace: string): Promise<void> {
	let pending = preparations.get(workspace)
	if (!pending) {
		pending = (async () => {
			if (!readProjectTaskStorage(workspace)) await configureProjectTaskStorage(workspace, true, true)
			await applyProjectTaskVisibility(workspace, readProjectTaskStorage(workspace)?.hide ?? true)
		})()
		preparations.set(workspace, pending)
	}
	try {
		await pending
		await ensureProjectTaskIgnore(workspace)
	} catch (error) {
		preparations.delete(workspace)
		throw error
	}
}

export async function applyProjectTaskVisibility(workspace: string, hide: boolean): Promise<void> {
	const commands = await vscode.commands.getCommands(true)
	if (commands.includes("ivol.refreshProjectTaskStorage")) {
		await vscode.commands.executeCommand("ivol.refreshProjectTaskStorage")
	} else {
		const config = vscode.workspace.getConfiguration("files", vscode.Uri.file(workspace))
		const inspected = config.inspect<Record<string, boolean>>("exclude")
		const excluded = {
			...(inspected?.workspaceValue ?? {}),
			...(inspected?.workspaceFolderValue ?? {}),
			".ivol": hide,
		}
		await config.update("exclude", excluded, vscode.ConfigurationTarget.WorkspaceFolder)
	}
}

export function getProjectTasksToCopy(workspace: string, history: HistoryItem[]): HistoryItem[] {
	if (!workspace) return []
	const index = readProjectTaskStorage(workspace) ? readIndex(workspace) : { items: [], deletedIds: [] }
	const localIds = new Set([...index.items.map((item) => item.id), ...index.deletedIds])
	return history.filter((item) => item.workspace === workspace && !localIds.has(item.id))
}

export async function configureProjectTaskStorage(workspace: string, enabled: boolean, hide: boolean): Promise<void> {
	if (!workspace || !workspaceRoots().includes(workspace)) throw new Error("Open a local project folder first.")
	if (vscode.workspace.isTrusted === false)
		throw new Error("Trust this workspace before enabling project task storage.")
	const previous = readProjectTaskStorage(workspace)
	await ensureProjectTaskIgnore(workspace)
	const root = projectStorageRoot(workspace)
	await fsp.mkdir(root, { recursive: true, mode: 0o700 })
	await safeWriteJson(path.join(root, CONFIG), {
		version: 1,
		projectId: previous?.projectId ?? randomUUID(),
		enabled,
		hide,
	})
}

async function directoryDigest(directory: string): Promise<string> {
	const hash = createHash("sha256")
	async function visit(folder: string): Promise<void> {
		for (const name of (await fsp.readdir(folder)).sort()) {
			const file = path.join(folder, name)
			const stat = await fsp.lstat(file)
			if (stat.isSymbolicLink()) throw new Error("Cannot copy task history containing symbolic links.")
			hash.update(path.relative(directory, file))
			if (stat.isDirectory()) await visit(file)
			else if (stat.isFile()) {
				hash.update(`file:${stat.size}:`)
				for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
			} else throw new Error("Unsupported file in task history.")
		}
	}
	await visit(directory)
	return hash.digest("hex")
}

/** Explicit copy, never overwrite a destination or delete the global original. */
export async function copyTasksToProject(
	workspace: string,
	globalBase: string,
	history: HistoryItem[],
	onProgress?: (progress: ProjectTaskCopyProgress) => void,
): Promise<number> {
	if (readProjectTaskStorage(workspace)?.enabled === false) throw new Error("Enable project task storage first.")
	await prepareProjectTaskStorage(workspace)
	await ensureProjectTaskIgnore(workspace)
	const release = await lockfile.lock(path.join(projectStorageRoot(workspace), "copy-operation"), {
		realpath: false,
		retries: 0,
	})
	try {
		return await copyProjectTasksLocked(workspace, globalBase, history, onProgress)
	} finally {
		await release()
	}
}

async function copyProjectTasksLocked(
	workspace: string,
	globalBase: string,
	history: HistoryItem[],
	onProgress?: (progress: ProjectTaskCopyProgress) => void,
): Promise<number> {
	let copied = 0
	const candidates = getProjectTasksToCopy(workspace, history)
	const report = (phase: ProjectTaskCopyProgress["phase"]) => {
		// A disconnected UI must never interrupt or roll back a verified copy.
		try {
			onProgress?.({ phase, copied, total: candidates.length })
		} catch (error) {
			console.error("Project task copy progress:", error)
		}
	}
	report("preparing")
	for (const item of candidates) {
		validateTaskId(item.id)
		const index = readIndex(workspace)
		if (index.items.some((entry) => entry.id === item.id) || index.deletedIds.includes(item.id)) continue
		const source = path.join(globalBase, "tasks", item.id)
		const destination = path.join(projectStorageRoot(workspace), "tasks", item.id)
		assertNotSymlink(source)
		assertNotSymlink(path.dirname(destination))
		assertNotSymlink(destination)
		if (fs.existsSync(destination))
			throw new Error(`Destination already exists for task ${item.id}; nothing was overwritten.`)
		report("verifying")
		const initial = await directoryDigest(source)
		const staging = `${destination}.copy-${randomUUID()}`
		await fsp.mkdir(path.dirname(destination), { recursive: true })
		try {
			report("copying")
			await fsp.cp(source, staging, {
				recursive: true,
				errorOnExist: true,
				force: false,
				filter: async (file) => {
					if ((await fsp.lstat(file)).isSymbolicLink())
						throw new Error("Cannot copy task history containing symbolic links.")
					return true
				},
			})
			report("verifying")
			if (initial !== (await directoryDigest(staging)) || initial !== (await directoryDigest(source))) {
				throw new Error(`Task ${item.id} changed while copying. Close it in other IDE windows and retry.`)
			}
			await fsp.rename(staging, destination)
			pinTaskDirectory(item.id, destination)
			try {
				await updateProjectTaskHistory([], [item])
			} catch (error) {
				// Roll back only our new copy, never the untouched source or another existing task.
				taskLocations.delete(item.id)
				await fsp.rm(destination, { recursive: true, force: true })
				throw error
			}
			copied++
			report("verifying")
		} finally {
			await fsp.rm(staging, { recursive: true, force: true })
		}
	}
	return copied
}
