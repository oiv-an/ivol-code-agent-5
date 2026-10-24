import * as fs from "node:fs/promises"
import * as path from "node:path"
import { agentSessionSchema, type AgentSession } from "./types"
import { safeWriteJson } from "../../../utils/safeWriteJson"
import {
	projectStorageRoot,
	ensureProjectTaskIgnore,
	resolveProjectTaskDirectory,
} from "../../../services/kilocode/project-task-storage"

export interface LocalSessionRecord {
	session: AgentSession
	taskId?: string
	workspace: string
}

/** Metadata only. Canonical task histories remain in their existing task directories. */
export class LocalSessionStore {
	private pending: Promise<void> = Promise.resolve()
	constructor(private readonly workspace: string) {}

	private get file() {
		return path.join(projectStorageRoot(this.workspace), "agent-sessions.json")
	}

	async read(): Promise<LocalSessionRecord[]> {
		try {
			const data = JSON.parse(await fs.readFile(this.file, "utf8"))
			if (data.version !== 1 || !Array.isArray(data.sessions)) throw new Error("Invalid agent session index")
			return data.sessions.map((record: LocalSessionRecord) => {
				const session = agentSessionSchema.parse(record.session)
				if (typeof record.workspace !== "string" || !path.isAbsolute(record.workspace)) {
					throw new Error("Invalid agent session workspace")
				}
				if (record.taskId !== undefined && !/^[a-zA-Z0-9_-]+$/.test(record.taskId)) {
					throw new Error("Invalid agent task identifier")
				}
				return { session, workspace: record.workspace, taskId: record.taskId }
			})
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
			throw error
		}
	}

	/** Merge under the atomic writer's lock so another window's sessions are never dropped. */
	save(records: LocalSessionRecord[]): Promise<void> {
		const snapshot = structuredClone(records)
		const write = async () => {
			await ensureProjectTaskIgnore(this.workspace)
			for (const record of snapshot) {
				if (!record.taskId) continue
				const directory = resolveProjectTaskDirectory(record.taskId, record.workspace)
				if (!directory) continue
				const marker = path.join(directory, "agent-session.json")
				try {
					await fs.writeFile(marker, JSON.stringify({ version: 1, sessionId: record.session.sessionId }), {
						flag: "wx",
					})
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
				}
			}
			const output = { version: 1, sessions: [] as LocalSessionRecord[] }
			await safeWriteJson(this.file, output, async () => {
				const merged = new Map((await this.read()).map((record) => [record.session.sessionId, record]))
				for (const record of snapshot) merged.set(record.session.sessionId, record)
				output.sessions = [...merged.values()]
			})
		}
		// A failed write is reported to its caller; subsequent writes may retry without erasing the index.
		this.pending = this.pending.then(write, write)
		return this.pending
	}
}
