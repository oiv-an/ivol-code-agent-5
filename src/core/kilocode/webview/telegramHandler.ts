import type { WebviewMessage } from "@roo-code/types"
import type { ClineProvider } from "../../webview/ClineProvider"
import { TelegramManager } from "../../../services/kilocode/telegram/TelegramManager"
import type { Task } from "../../task/Task"

export function beginTelegramTransfer(provider: ClineProvider, from: Task, returningTo?: string) {
	return managers.get(provider)?.beginTransfer(from, returningTo)
}

const managers = new WeakMap<ClineProvider, TelegramManager>()

export function disposeTelegram(provider: ClineProvider): void {
	managers.get(provider)?.dispose()
	managers.delete(provider)
}

export async function handleTelegram(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	let manager = managers.get(provider)
	if (!manager) {
		manager = new TelegramManager(provider)
		managers.set(provider, manager)
	}
	try {
		switch (message.type) {
			case "getTelegramState":
				await manager.load()
				break
			case "saveTelegramSettings":
				if (!message.telegramSettings) throw new Error("Missing Telegram settings")
				await manager.save(message.telegramSettings.token, message.telegramSettings.ownerId)
				await provider.postMessageToWebview({
					type: "telegramSettingsSaved",
					telegramSettingsSaved: true,
					telegramRequestId: message.telegramSettings.requestId,
				})
				break
			case "activateTelegram":
				if (!message.telegramTaskId) throw new Error("Missing Telegram task")
				await manager.activate(message.telegramTaskId)
				break
			case "deactivateTelegram":
				await manager.deactivate(message.telegramTaskId)
				break
		}
	} catch {
		// Never log the incoming message: it can contain the bot token.
		provider.log("Telegram operation failed")
		if (message.type === "saveTelegramSettings") {
			await provider.postMessageToWebview({
				type: "telegramSettingsSaved",
				telegramSettingsSaved: false,
				telegramRequestId: message.telegramSettings?.requestId,
			})
		}
	}
}
