import type { WebviewMessage } from "@roo-code/types"
import type { ClineProvider } from "../../webview/ClineProvider"
import { TelegramManager } from "../../../services/kilocode/telegram/TelegramManager"
import type { Task } from "../../task/Task"

export function beginTelegramTransfer(provider: ClineProvider, from: Task, returningTo?: string) {
	return managers.get(provider)?.beginTransfer(from, returningTo)
}

const managers = new WeakMap<ClineProvider, TelegramManager>()

/** After a task rename, its Telegram topic (if any) takes the new name; failures never block the rename. */
export function renameTelegramTopic(provider: ClineProvider, taskId: string): void {
	void managers
		.get(provider)
		?.renameTask(taskId)
		.catch(() => provider.log("Telegram topic rename failed"))
}

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
			case "saveGroqApiKey":
				if (!message.groqApiKey) throw new Error("Missing Groq settings")
				await manager.saveGroqKey(message.groqApiKey.apiKey)
				await provider.postMessageToWebview({
					type: "telegramSettingsSaved",
					telegramSettingsSaved: true,
					telegramRequestId: message.groqApiKey.requestId,
				})
				break
			case "activateTelegram":
				// Project control topic always; the task topic too when pressed inside a task.
				await manager.activateAll(message.telegramTaskId)
				break
			case "deactivateTelegram":
				await manager.deactivateAll()
				break
		}
	} catch {
		// Never log the incoming message: it can contain the bot token.
		provider.log("Telegram operation failed")
		if (message.type === "saveTelegramSettings" || message.type === "saveGroqApiKey") {
			await provider.postMessageToWebview({
				type: "telegramSettingsSaved",
				telegramSettingsSaved: false,
				telegramRequestId: message.telegramSettings?.requestId ?? message.groqApiKey?.requestId,
			})
		}
	}
}
