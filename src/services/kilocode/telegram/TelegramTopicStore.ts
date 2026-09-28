import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomBytes, createHash } from "node:crypto"
import { z } from "zod"

const storeSchema = z.object({
	version: z.literal(1),
	topics: z.record(z.string(), z.number().int().positive().safe().nullable()),
})

/** Only the elected coordinator writes this file. Tokens and conversation content are never persisted here. */
export class TelegramTopicStore {
	private topics: Record<string, number | null> = {}
	private writes: Promise<void> = Promise.resolve()

	constructor(private readonly filePath: string) {}

	static key(botId: number, ownerId: number, projectId: string, taskId: string): string {
		return createHash("sha256")
			.update(JSON.stringify([botId, ownerId, projectId, taskId]))
			.digest("hex")
	}

	async load(): Promise<void> {
		try {
			const stat = await fs.lstat(this.filePath)
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10_000_000) {
				throw new Error("Invalid Telegram topic registry")
			}
			const data = storeSchema.parse(JSON.parse(await fs.readFile(this.filePath, "utf8")))
			this.topics = data.topics
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
	}

	get(key: string): number | undefined {
		if (this.topics[key] === null) throw new Error("Telegram topic creation needs manual recovery")
		return this.topics[key]
	}

	async set(key: string, threadId: number | null): Promise<void> {
		if ((threadId !== null && (!Number.isSafeInteger(threadId) || threadId <= 0)) || !/^[a-f0-9]{64}$/.test(key)) {
			throw new Error("Invalid Telegram topic mapping")
		}
		const write = this.writes.then(async () => {
			const next = { ...this.topics, [key]: threadId }
			const directory = path.dirname(this.filePath)
			await fs.mkdir(directory, { recursive: true, mode: 0o700 })
			const parent = await fs.lstat(directory)
			if (
				!parent.isDirectory() ||
				parent.isSymbolicLink() ||
				(process.platform !== "win32" && process.getuid && parent.uid !== process.getuid())
			) {
				throw new Error("Unsafe Telegram registry directory")
			}
			const temporary = `${this.filePath}.${randomBytes(8).toString("hex")}.tmp`
			try {
				await fs.writeFile(temporary, JSON.stringify({ version: 1, topics: next }), { mode: 0o600, flag: "wx" })
				await fs.rename(temporary, this.filePath)
				this.topics = next
			} finally {
				await fs.rm(temporary, { force: true })
			}
		})
		// Keep subsequent writes usable without swallowing the caller's failure.
		this.writes = write.catch((error) => {
			console.error("Telegram topic registry write failed:", (error as NodeJS.ErrnoException).code ?? "storage")
		})
		await write
	}
}
