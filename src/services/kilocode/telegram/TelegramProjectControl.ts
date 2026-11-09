import * as path from "node:path"
import pWaitFor from "p-wait-for"
import { getAllModes } from "../../../shared/modes"
import { isPersonalProvider } from "@roo-code/types"
import type { ClineProvider } from "../../../core/webview/ClineProvider"
import { t } from "../../../i18n"
import type { TelegramLocalClient } from "./TelegramLocalClient"
import type { TelegramInput, TelegramRoute } from "./TelegramRouter"

type Keyboard = { text: string; callback_data: string }[][]

export const TELEGRAM_PROJECT_COMMANDS = ["new", "tasks", "stop", "mode", "profile", "status", "help"] as const

export function telegramProjectCommands() {
	return TELEGRAM_PROJECT_COMMANDS.map((command) => ({
		command,
		description: t(`common:telegram.project.commands.${command}`),
	}))
}

export function telegramProjectHelp(project: string): string {
	const lines = TELEGRAM_PROJECT_COMMANDS.map(
		(command) => `/${command} — ${t(`common:telegram.project.commands.${command}`)}`,
	)
	return [
		t("common:telegram.project.helpTitle", { project }),
		"",
		...lines,
		"",
		t("common:telegram.project.helpFooter"),
	].join("\n")
}

function shorten(text: string, limit: number): string {
	const clean = text
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
	const chars = Array.from(clean)
	return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : clean || "—"
}

/**
 * Handles owner input from the project control topic of one IDE window.
 * Every action re-validates against this window's provider; Telegram data is never trusted as an id.
 */
export class TelegramProjectControl {
	private tail: Promise<void> = Promise.resolve()
	private lastUpdateId = -1
	private disposed = false

	constructor(
		private readonly provider: ClineProvider,
		private readonly client: TelegramLocalClient,
		private readonly route: TelegramRoute,
		private readonly hooks: {
			/** Connect the task topic for a task that is now current in this window. */
			activateTask: (taskId: string) => Promise<void>
			transcribe: (audio: string) => Promise<string>
			fault: () => void
		},
	) {
		client.on("input", this.onInput)
		client.on("fault", this.onFault)
		client.on("disconnected", this.onFault)
	}

	private onFault = () => {
		if (!this.disposed) this.hooks.fault()
	}

	private onInput = (input: TelegramInput): void => {
		if (this.disposed || input.kind !== "project" || input.epoch !== this.route.epoch) return
		if (!Number.isSafeInteger(input.updateId) || input.updateId <= this.lastUpdateId) return
		this.lastUpdateId = input.updateId
		this.tail = this.tail
			.then(() => this.handle(input))
			.catch((error) => {
				this.provider.log(
					`Telegram project command failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
				)
				return this.send(t("common:telegram.project.failed")).catch(() => undefined)
			})
	}

	private async send(text: string, keyboard?: Keyboard): Promise<void> {
		if (this.disposed) return
		await this.client.request({ operation: "projectSend", epoch: this.route.epoch, text, keyboard })
	}

	private async handle(input: Extract<TelegramInput, { kind: "project" }>): Promise<void> {
		if (this.disposed) return
		if (input.data) return this.handleButton(input.data)
		let text = input.text.trim()
		if (input.audio) {
			let transcript: string
			try {
				transcript = (await this.hooks.transcribe(input.audio)).trim()
			} catch {
				await this.send(t("common:telegram.voiceFailed"))
				return
			}
			text = [text, transcript].filter(Boolean).join("\n\n")
		}
		if (!text) return
		const match = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text)
		if (!match) return this.newTask(text)
		const argument = (match[2] ?? "").trim()
		switch (match[1].toLowerCase()) {
			case "start":
			case "help":
				return this.send(telegramProjectHelp(this.projectName()))
			case "new":
				return argument ? this.newTask(argument) : this.send(t("common:telegram.project.newUsage"))
			case "tasks":
				return this.listTasks()
			case "stop":
				return this.stop()
			case "mode":
				return this.listModes()
			case "profile":
				return this.listProfiles()
			case "status":
				return this.status()
			default:
				return this.send(t("common:telegram.project.unknown"))
		}
	}

	private projectName(): string {
		return path.basename(this.provider.cwd)
	}

	private async newTask(text: string): Promise<void> {
		const provider = this.provider
		await provider.removeClineFromStack()
		await provider.postStateToWebview()
		await provider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		const task = await provider.createTask(text)
		await provider.postMessageToWebview({ type: "invoke", invoke: "newChat" })
		await this.send(t("common:telegram.project.created", { task: shorten(text, 80) }))
		// The task topic is named from the first message; give the task a moment to record it.
		await pWaitFor(() => task.clineMessages.length > 0 || task.abort, { interval: 100, timeout: 5000 }).catch(
			() => undefined,
		)
		if (this.provider.getCurrentTask() === task) await this.hooks.activateTask(task.taskId)
	}

	private projectTasks() {
		const cwd = this.provider.cwd
		return this.provider
			.getTaskHistory()
			.filter((item) => item.task && (!item.workspace || item.workspace === cwd) && !item.parentTaskId)
			.sort((a, b) => b.ts - a.ts)
	}

	private async listTasks(): Promise<void> {
		const tasks = this.projectTasks().slice(0, 10)
		if (!tasks.length) return this.send(t("common:telegram.project.noTasks"))
		const current = this.provider.getCurrentTask()?.taskId
		const keyboard: Keyboard = tasks.map((item) => [
			{ text: `${item.id === current ? "▶️ " : ""}${shorten(item.task, 48)}`, callback_data: `o:${item.id}` },
		])
		await this.send(t("common:telegram.project.tasksTitle"), keyboard)
	}

	private async listModes(): Promise<void> {
		const customModes = await this.provider.customModesManager.getCustomModes()
		const { mode } = await this.provider.getState()
		const keyboard: Keyboard = getAllModes(customModes)
			.filter((item) => /^[A-Za-z0-9_.:-]{1,56}$/.test(item.slug))
			.slice(0, 20)
			.map((item) => [
				{
					text: `${item.slug === mode ? "✅ " : ""}${shorten(item.name, 48)}`,
					callback_data: `m:${item.slug}`,
				},
			])
		await this.send(t("common:telegram.project.modeTitle"), keyboard)
	}

	private async personalProfiles() {
		return (await this.provider.providerSettingsManager.listConfig()).filter(
			(item) =>
				isPersonalProvider(item.apiProvider) &&
				item.profileType !== "autocomplete" &&
				/^[A-Za-z0-9_.:-]{1,56}$/.test(item.id),
		)
	}

	private async listProfiles(): Promise<void> {
		const { currentApiConfigName } = await this.provider.getState()
		const keyboard: Keyboard = (await this.personalProfiles()).slice(0, 20).map((item) => [
			{
				text: `${item.name === currentApiConfigName ? "✅ " : ""}${shorten(item.name, 48)}`,
				callback_data: `p:${item.id}`,
			},
		])
		if (!keyboard.length) return this.send(t("common:telegram.project.noProfiles"))
		await this.send(t("common:telegram.project.profileTitle"), keyboard)
	}

	private async stop(): Promise<void> {
		if (!this.provider.getCurrentTask()) return this.send(t("common:telegram.project.noCurrent"))
		await this.provider.cancelTask()
		await this.send(t("common:telegram.project.stopped"))
	}

	private async status(): Promise<void> {
		const { mode, currentApiConfigName } = await this.provider.getState()
		const task = this.provider.getCurrentTask()
		const title = task ? shorten(task.clineMessages[0]?.text ?? task.taskId, 120) : "—"
		await this.send(
			t("common:telegram.project.statusText", {
				project: this.projectName(),
				task: title,
				mode,
				profile: currentApiConfigName ?? "—",
			}),
		)
	}

	private async handleButton(data: string): Promise<void> {
		const value = data.slice(2)
		switch (data[0]) {
			case "o": {
				const item = this.projectTasks().find((entry) => entry.id === value)
				if (!item) return this.send(t("common:telegram.project.taskMissing"))
				await this.provider.showTaskWithId(item.id)
				await this.send(t("common:telegram.project.opened", { task: shorten(item.task, 80) }))
				const current = this.provider.getCurrentTask()
				if (current?.taskId === item.id) await this.hooks.activateTask(item.id)
				return
			}
			case "m": {
				const customModes = await this.provider.customModesManager.getCustomModes()
				const mode = getAllModes(customModes).find((item) => item.slug === value)
				if (!mode) return this.send(t("common:telegram.project.unknown"))
				await this.provider.handleModeSwitch(mode.slug)
				return this.send(t("common:telegram.project.modeSet", { mode: mode.name }))
			}
			case "p": {
				const profile = (await this.personalProfiles()).find((item) => item.id === value)
				if (!profile) return this.send(t("common:telegram.project.noProfiles"))
				await this.provider.activateProviderProfile({ id: profile.id })
				return this.send(t("common:telegram.project.profileSet", { profile: profile.name }))
			}
		}
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.client.off("input", this.onInput)
		this.client.off("fault", this.onFault)
		this.client.off("disconnected", this.onFault)
	}
}
