import * as vscode from "vscode"
import { readFile, readdir, stat } from "node:fs/promises"
import * as path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { AdvisorState } from "@roo-code/types"
import { getKiloCodeWrapperProperties } from "../../../core/kilocode/wrapper"

const execute = promisify(execFile)
const idPattern = /^[a-z0-9-]+\.[a-z0-9._-]+$/i
const query =
	"SELECT key,value FROM ItemTable WHERE key IN ('extensionsIdentifiers/disabled','extensionsIdentifiers/enabled');"
type Inventory = NonNullable<AdvisorState["workspaceDisabled"]>

// Audited against the installed VS Code 1.139.1 workbench enablement service:
// workspace scope = 1; explicit workspace enable wins over workspace disable.
// Never infer disablement from extensions.all, and never read profile/global storage.
export function parseWorkspaceDisabled(rows: unknown): string[] {
	if (!Array.isArray(rows) || rows.length > 2) throw new Error("Unexpected workspace storage rows")
	const values = new Map<string, { id: string; uuid?: string }[]>()
	for (const row of rows) {
		if (
			!row ||
			!["extensionsIdentifiers/disabled", "extensionsIdentifiers/enabled"].includes(row.key) ||
			values.has(row.key)
		)
			throw new Error("Unexpected workspace storage key")
		const entries: unknown = JSON.parse(row.value)
		if (
			!Array.isArray(entries) ||
			entries.length > 10000 ||
			entries.some(
				(entry) =>
					!entry ||
					typeof entry.id !== "string" ||
					!idPattern.test(entry.id) ||
					(entry.uuid !== undefined && typeof entry.uuid !== "string"),
			)
		)
			throw new Error("Unsupported workspace enablement format")
		values.set(row.key, entries)
	}
	const enabled = values.get("extensionsIdentifiers/enabled") ?? []
	return [
		...new Set(
			(values.get("extensionsIdentifiers/disabled") ?? [])
				.filter(
					(entry) =>
						!enabled.some((other) =>
							entry.uuid && other.uuid
								? entry.uuid === other.uuid
								: entry.id.toLowerCase() === other.id.toLowerCase(),
						),
				)
				.map((entry) => entry.id.toLowerCase()),
		),
	].sort()
}

async function readSmallJson(file: string): Promise<unknown> {
	if ((await stat(file)).size > 2_000_000) throw new Error("Metadata exceeds size limit")
	return JSON.parse(await readFile(file, "utf8"))
}

export async function readWorkspaceDisabled(context: vscode.ExtensionContext): Promise<Inventory> {
	const unavailable = (reason: string): Inventory => ({ status: "unsupported", entries: [], reason })
	if (
		getKiloCodeWrapperProperties().kiloCodeWrapped ||
		process.env.AGENT_CONFIG ||
		process.platform !== "darwin" ||
		vscode.env.appName !== "Visual Studio Code" ||
		vscode.version !== "1.139.1" ||
		vscode.env.remoteName
	)
		return unavailable(
			"Requires the audited local macOS VS Code 1.139.1 adapter; other versions and IDEs are not supported.",
		)
	if (context.storageUri?.scheme !== "file") return unavailable("No local workspace storage is available.")
	try {
		const directory = path.dirname(context.storageUri.fsPath)
		if (path.basename(path.dirname(directory)) !== "workspaceStorage")
			throw new Error("Unexpected workspace storage location")
		const identity = (await readSmallJson(path.join(directory, "workspace.json"))) as {
			folder?: string
			workspace?: string
		}
		const expected =
			vscode.workspace.workspaceFile?.toString() ??
			(vscode.workspace.workspaceFolders?.length === 1
				? vscode.workspace.workspaceFolders[0].uri.toString()
				: undefined)
		if (!expected || (vscode.workspace.workspaceFile ? identity.workspace : identity.folder) !== expected)
			throw new Error("Workspace storage identity does not match the current workspace")
		const database = path.join(directory, "state.vscdb")
		await stat(database) // Do not let sqlite create a missing database.
		const { stdout } = await execute("/usr/bin/sqlite3", ["-readonly", "-json", database, query], {
			timeout: 5000,
			maxBuffer: 2_000_000,
		})
		const ids = parseWorkspaceDisabled(stdout.trim() ? JSON.parse(stdout) : [])
		// Resolve labels only; membership comes exclusively from the workspace database.
		const entries = ids.map((id) => ({
			id,
			name: vscode.extensions.getExtension(id)?.packageJSON.displayName || id,
		}))
		const extensionRoot = path.dirname(context.extensionUri.fsPath)
		const directories = await readdir(extensionRoot, { withFileTypes: true })
		for (const entry of entries) {
			if (entry.name !== entry.id) continue
			const candidates = directories.filter(
				(item) => item.isDirectory() && item.name.toLowerCase().startsWith(`${entry.id}-`),
			)
			for (const candidate of candidates.slice(0, 10)) {
				try {
					const manifest = (await readSmallJson(
						path.join(extensionRoot, candidate.name, "package.json"),
					)) as { publisher?: string; name?: string; displayName?: string }
					if (
						`${manifest.publisher}.${manifest.name}`.toLowerCase() === entry.id &&
						typeof manifest.displayName === "string" &&
						!manifest.displayName.startsWith("%")
					) {
						entry.name = manifest.displayName
						break
					}
				} catch (error) {
					console.warn("Advisor extension label unavailable", entry.id, String(error))
				}
			}
		}
		return { status: "available", entries, readAt: new Date().toISOString() }
	} catch (error) {
		return unavailable(
			`Cannot verify saved workspace enablement: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}
