import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"

/** Shared across IDE editions, outside workspaces and project history. */
export async function telegramLocalPaths(
	botId: string,
): Promise<{ directory: string; socket: string; topics: string }> {
	if (!/^\d{1,20}$/.test(botId)) throw new Error("Invalid Telegram bot identifier")
	const directory = path.join(os.homedir(), ".ivol-telegram")
	await fs.mkdir(directory, { mode: 0o700, recursive: true })
	const stat = await fs.lstat(directory)
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe Telegram runtime directory")
	if (process.platform !== "win32") {
		if (process.getuid && stat.uid !== process.getuid())
			throw new Error("Telegram runtime directory owner mismatch")
		await fs.chmod(directory, 0o700)
	}
	const scope = createHash("sha256").update(`${os.homedir()}:${botId}`).digest("hex").slice(0, 24)
	const socket =
		process.platform === "win32" ? `\\\\.\\pipe\\ivol-telegram-${scope}` : path.join(directory, `${scope}.sock`)
	if (process.platform !== "win32" && Buffer.byteLength(socket) > 100) {
		throw new Error("Telegram runtime socket path exceeds the platform limit")
	}
	return { directory, socket, topics: path.join(directory, `${scope}.topics.json`) }
}
