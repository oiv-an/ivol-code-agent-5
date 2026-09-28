import { fork } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { TelegramLocalClient } from "./TelegramLocalClient"
import { telegramLocalPaths } from "./localPaths"
import { telegramBootstrapSchema } from "./protocol"
import { isTelegramStartupReason, TelegramStartupError } from "./startupFailure"

/** Launch only on explicit task activation. Never persist the bot token or pass it in argv. */
export async function launchTelegramCoordinator(
	extensionPath: string,
	token: string,
	ownerId: number,
): Promise<TelegramLocalClient> {
	const config = telegramBootstrapSchema.parse({ token, ownerId })
	const paths = await telegramLocalPaths(token.split(":")[0])
	try {
		return await TelegramLocalClient.connect(paths.socket, token, ownerId)
	} catch {
		// A missing listener is expected on first activation. Binding below elects one process.
	}
	const executable = path.join(extensionPath, "dist", "telegram-coordinator.js")
	await fs.access(executable)
	const child = fork(executable, [], {
		detached: true,
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		execArgv: [],
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	})
	const outcome = await new Promise<"ready" | "already-running">((resolve, reject) => {
		let settled = false
		const finish = (error?: Error, result?: "ready" | "already-running") => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			child.off("message", onMessage)
			child.off("error", onError)
			child.off("exit", onExit)
			if (error) {
				child.kill()
				reject(error)
			} else resolve(result!)
		}
		const timeout = setTimeout(() => finish(new TelegramStartupError("startup-failed")), 90_000)
		const onError = () => finish(new TelegramStartupError("local-runtime"))
		const onExit = () => finish(new TelegramStartupError("local-runtime"))
		const onMessage = (value: unknown) => {
			if (!value || typeof value !== "object") return
			const message = value as { type?: string; reason?: string }
			if (message.type === "ready") finish(undefined, "ready")
			else if (message.type === "failed") {
				if (message.reason === "already-running") finish(undefined, "already-running")
				else
					finish(
						new TelegramStartupError(
							isTelegramStartupReason(message.reason) ? message.reason : "startup-failed",
						),
					)
			}
		}
		child.on("message", onMessage)
		child.once("error", onError)
		child.once("exit", onExit)
		child.send(config, (error) => {
			if (error) onError()
		})
	})
	child.unref()
	// A competing process may still be verifying its token. No socket deletion is permitted here.
	for (let attempt = 0; attempt < (outcome === "ready" ? 2 : 30); attempt++) {
		try {
			return await TelegramLocalClient.connect(paths.socket, token, ownerId)
		} catch {
			await delay(1000)
		}
	}
	throw new Error("Telegram coordinator unavailable; another token or a stale local listener may be present")
}
