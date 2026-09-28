import * as fs from "node:fs/promises"
import * as net from "node:net"
import * as lockfile from "proper-lockfile"

/** All starters hold this renewable lease before inspecting or binding the shared socket. */
export async function acquireCoordinatorLock(
	socketPath: string,
	leasePath: string,
	onCompromised: () => void,
): Promise<() => Promise<void>> {
	const release = await lockfile.lock(leasePath, {
		realpath: false,
		stale: 30_000,
		update: 5000,
		retries: { retries: 35, minTimeout: 1000, maxTimeout: 1000 },
		onCompromised,
	})
	try {
		if (process.platform === "win32") return release
		const stat = await fs.lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined
			throw error
		})
		if (!stat) return release
		if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid())) {
			throw new Error("Unsafe Telegram socket")
		}
		const refused = await new Promise<boolean>((resolve) => {
			const socket = net.createConnection(socketPath)
			const finish = (value: boolean) => {
				socket.destroy()
				resolve(value)
			}
			socket.setTimeout(2000, () => finish(false))
			socket.once("connect", () => finish(false))
			socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED"))
		})
		if (!refused) throw new Error("Telegram listener is already running")
		const current = await fs.lstat(socketPath)
		if (current.ino !== stat.ino || current.dev !== stat.dev || !current.isSocket()) {
			throw new Error("Telegram socket changed during recovery")
		}
		await fs.unlink(socketPath)
		return release
	} catch (error) {
		await release()
		throw error
	}
}
