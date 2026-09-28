import { TelegramApi } from "./TelegramApi"
import { TelegramCoordinator } from "./TelegramCoordinator"
import { TelegramLocalServer } from "./TelegramLocalServer"
import { TelegramTopicStore } from "./TelegramTopicStore"
import { telegramLocalPaths } from "./localPaths"
import { telegramBootstrapSchema } from "./protocol"
import { telegramStartupReason } from "./startupFailure"

import { acquireCoordinatorLock } from "./coordinatorLock"

// Credentials arrive once over the parent's private IPC channel, never argv or a disk file.
let server: TelegramLocalServer | undefined
let initialized = false
let shuttingDown = false
let idleTimer: NodeJS.Timeout | undefined
let releaseLock: (() => Promise<void>) | undefined
const bootstrapTimeout = setTimeout(() => void shutdown(), 10_000)

async function shutdown(): Promise<void> {
	if (shuttingDown) return
	shuttingDown = true
	clearTimeout(bootstrapTimeout)
	if (idleTimer) clearTimeout(idleTimer)
	try {
		await server?.close()
		await releaseLock?.()
	} catch {
		console.error("Telegram coordinator shutdown failed")
	} finally {
		process.exit(0)
	}
}

function scheduleIdleShutdown(): void {
	if (idleTimer) clearTimeout(idleTimer)
	idleTimer = setTimeout(() => {
		if (!server?.connectionCount) void shutdown()
	}, 30_000)
}

process.once("message", (value: unknown) => {
	clearTimeout(bootstrapTimeout)
	void (async () => {
		const config = telegramBootstrapSchema.parse(value)
		const paths = await telegramLocalPaths(config.token.split(":")[0])
		const coordinator = new TelegramCoordinator(
			new TelegramApi(config.token),
			config.ownerId,
			new TelegramTopicStore(paths.topics),
			(message) => server?.broadcastError(message),
		)
		server = new TelegramLocalServer(config.token, config.ownerId, coordinator, scheduleIdleShutdown)
		// A renewable cross-process lease serializes startup and stale-socket recovery.
		releaseLock = await acquireCoordinatorLock(paths.socket, `${paths.topics}.coordinator`, () => void shutdown())
		if (shuttingDown) {
			await releaseLock()
			return
		}
		await server.listen(paths.socket)
		const bot = await coordinator.start()
		if (shuttingDown) return
		server.markReady()
		initialized = true
		process.send?.({ type: "ready", botUsername: bot.username }, () => {
			if (process.connected) process.disconnect()
		})
		scheduleIdleShutdown()
	})().catch((error: unknown) => {
		const busy = ["EADDRINUSE", "ELOCKED"].includes((error as NodeJS.ErrnoException).code ?? "")
		const reason = busy ? "already-running" : telegramStartupReason(error)
		// Only a fixed code crosses IPC. Raw errors can contain the bot token or response URL.
		const message = { type: "failed", reason }
		if (process.connected) process.send?.(message, () => void shutdown())
		else void shutdown()
	})
})

process.on("disconnect", () => {
	// A ready coordinator outlives its original IDE, but exits after the final client leaves.
	if (!initialized) void shutdown()
})
process.on("SIGTERM", () => void shutdown())
process.on("SIGINT", () => void shutdown())
