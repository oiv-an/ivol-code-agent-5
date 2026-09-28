import * as path from "node:path"
import * as vscode from "vscode"
import { z } from "zod"
import { RooCodeEventName, type TelegramState, type ClineMessage, type TaskLike } from "@roo-code/types"
import type { ClineProvider } from "../../../core/webview/ClineProvider"
import { t } from "../../../i18n"
import { readProjectTaskStorage } from "../project-task-storage"
import { telegramBootstrapSchema } from "./protocol"
import { launchTelegramCoordinator } from "./launchCoordinator"
import { telegramTopicTitle } from "./presentation"
import { TelegramTaskBridge } from "./TelegramTaskBridge"
import type { TelegramLocalClient } from "./TelegramLocalClient"
import { TelegramStartupError } from "./startupFailure"

import type { TelegramInput, TelegramRoute } from "./TelegramRouter"
import type { Task } from "../../../core/task/Task"

export interface TelegramTransfer {
	finish(task: Task): Promise<void>
	cancel(): void
}

const SECRET_KEY = "ivol.telegram.credentials.v1"
const routeSchema = z.object({
	key: z.string(),
	clientId: z.string(),
	taskId: z.string(),
	chatId: z.number().int(),
	threadId: z.number().int().positive(),
	ownerId: z.number().int(),
	activatedAt: z.number(),
	minimumUpdateId: z.number().int(),
	epoch: z.string().min(1),
})

export class TelegramManager {
	private state: TelegramState = { configured: false, status: "inactive" }
	private generation = 0
	private bridge?: TelegramTaskBridge
	private client?: TelegramLocalClient
	private disposed = false
	private saving = false
	private settingsRevision = 0
	private stateDelivery: Promise<void> = Promise.resolve()
	private route?: TelegramRoute
	private lineage: string[] = []
	private transfer?: { from: string; cancel: () => void }

	constructor(private readonly provider: ClineProvider) {
		provider.on(RooCodeEventName.TaskUnfocused, this.onUnfocused)
		provider.on(RooCodeEventName.TaskAborted, this.onUnfocused)
		provider.context.subscriptions.push(this)
	}

	private onUnfocused = (taskId: string): void => {
		if (this.state.taskId !== taskId) return
		if (this.transfer?.from === taskId) return
		void this.deactivate()
	}

	async publishState(): Promise<void> {
		if (this.disposed) return
		const state = { ...this.state }
		this.stateDelivery = this.stateDelivery.then(async () => {
			if (this.disposed) return
			try {
				await this.provider.postMessageToWebview({ type: "telegramState", telegramState: state })
			} catch {
				this.provider.log("Telegram state delivery failed")
			}
		})
		await this.stateDelivery
	}

	async load(): Promise<void> {
		const generation = this.generation
		const revision = this.settingsRevision
		const credentials = await this.credentials()
		if (this.disposed || generation !== this.generation || revision !== this.settingsRevision || this.saving) return
		this.state.configured = !!credentials
		this.state.ownerId = credentials?.ownerId
		await this.publishState()
	}

	private async credentials(): Promise<z.infer<typeof telegramBootstrapSchema> | undefined> {
		const stored = await this.provider.context.secrets.get(SECRET_KEY)
		if (!stored) return undefined
		return telegramBootstrapSchema.parse(JSON.parse(stored))
	}

	async save(token: string | undefined, ownerId: string): Promise<void> {
		if (this.saving || this.disposed) throw new Error("Telegram settings unavailable")
		this.saving = true
		this.settingsRevision++
		this.resetConnection()
		const generation = this.generation
		try {
			const existing = await this.credentials()
			if (!/^\d+$/.test(ownerId.trim())) throw new Error("Invalid Telegram owner ID")
			const credentials = telegramBootstrapSchema.parse({
				token: token?.trim() || existing?.token,
				ownerId: Number(ownerId),
			})
			await this.provider.context.secrets.store(SECRET_KEY, JSON.stringify(credentials))
			if (this.disposed) return
			this.settingsRevision++
			this.state = { ...this.state, configured: true, ownerId: credentials.ownerId }
			await this.publishState()
		} catch (error) {
			if (!this.disposed && generation === this.generation) await this.fail()
			throw error
		} finally {
			this.saving = false
		}
	}

	async activate(taskId: string): Promise<void> {
		if (this.disposed || this.saving || this.state.status === "connecting") return
		if (this.state.status === "active" && this.state.taskId === taskId) return
		const task = this.provider.getCurrentTask()
		if (!task || task.taskId !== taskId || task.abort || !vscode.workspace.isTrusted)
			throw new Error("No trusted active task")
		this.resetConnection()
		const generation = this.generation
		this.state = { ...this.state, status: "connecting", taskId, rootTaskId: taskId, error: undefined }
		const current = () =>
			!this.disposed && this.generation === generation && this.provider.getCurrentTask() === task && !task.abort
		let client: TelegramLocalClient | undefined
		const buffered = new Map<number, ClineMessage>()
		let overflow = false
		const inputs: TelegramInput[] = []
		const captureInput = (input: TelegramInput) => {
			if (!current()) return
			if (inputs.length >= 100) {
				overflow = true
				return
			}
			inputs.push(input)
		}
		let connectionFault = false
		const captureFault = () => {
			connectionFault = true
		}
		const capture = ({ message }: { message: ClineMessage }) => {
			if (!current()) return
			if (buffered.size >= 1000 && !buffered.has(message.ts)) {
				overflow = true
				return
			}
			buffered.set(message.ts, { ...message })
		}
		task.on(RooCodeEventName.Message, capture)
		try {
			await this.publishState()
			const credentials = await this.credentials()
			if (!current()) return
			if (!credentials) throw new Error("Telegram configuration unavailable")
			this.state = {
				configured: true,
				ownerId: credentials.ownerId,
				status: "connecting",
				taskId,
				rootTaskId: taskId,
			}
			client = await launchTelegramCoordinator(
				this.provider.context.extensionPath,
				credentials.token,
				credentials.ownerId,
			)
			if (!current()) {
				client.close()
				return
			}
			this.client = client
			client.on("input", captureInput)
			client.on("fault", captureFault)
			client.on("disconnected", captureFault)
			const project = path.basename(task.cwd)
			const taskText = task.clineMessages[0]?.text ?? ""
			const title = telegramTopicTitle(taskText, t("common:telegram.taskTitle"))
			const projectId = readProjectTaskStorage(task.cwd)?.projectId ?? task.cwd
			const route = routeSchema.parse(
				await client.request({
					operation: "activate",
					projectId,
					taskId,
					title,
					taskText,
					notice: t("common:telegram.notice", { project, task: title }),
				}),
			)
			if (!current()) {
				client.close()
				return
			}
			if (
				route.taskId !== taskId ||
				route.ownerId !== credentials.ownerId ||
				route.chatId !== credentials.ownerId
			)
				throw new Error("Invalid Telegram route")
			if (overflow || connectionFault) throw new Error("Telegram activation interrupted")
			this.route = route
			this.lineage = [taskId]
			this.bridge = new TelegramTaskBridge(
				task,
				client,
				route,
				current,
				() => {
					if (current()) void this.fail()
				},
				{
					approve: t("common:telegram.approve"),
					deny: t("common:telegram.deny"),
					thinking: t("common:telegram.thinking"),
					confirmation: t("common:telegram.confirmation"),
				},
				[...buffered.values()],
			)
			client.off("input", captureInput)
			for (const input of inputs) client.emit("input", input)
			if (!current()) return
			this.state.status = "active"
			await this.publishState()
		} catch (error) {
			client?.close()
			if (current()) await this.fail(error, true)
		} finally {
			client?.off("input", captureInput)
			client?.off("fault", captureFault)
			client?.off("disconnected", captureFault)
			task.off(RooCodeEventName.Message, capture)
			buffered.clear()
		}
	}

	/** Called before provider unfocus/abort; no manager or connection is created by delegation. */
	async beginTransfer(from: Task, returningTo?: string): Promise<TelegramTransfer | undefined> {
		if (
			this.state.status !== "active" ||
			this.state.taskId !== from.taskId ||
			!this.bridge ||
			!this.client ||
			!this.route
		)
			return undefined
		if (this.transfer) return undefined
		if (from.messageQueueService.messages.some((message) => message.source === "telegram")) {
			// Pending input belongs to the old task, never silently move it to a different ask.
			await this.fail(undefined, true)
			return undefined
		}
		if (returningTo && this.lineage.at(-2) !== returningTo) {
			await this.deactivate()
			return undefined
		}
		const generation = this.generation
		const client = this.client
		const oldRoute = this.route
		let candidate: Task | undefined
		const buffered = new Map<number, ClineMessage>()
		let bytes = 0
		let cleaned = false
		const inputs: TelegramInput[] = []
		let inputBytes = 0
		const captureInput = (input: TelegramInput) => {
			if (input.epoch === oldRoute.epoch) return
			inputBytes += JSON.stringify(input).length
			// Only the new epoch is replayed after finish. Old approvals/media are never reassigned.
			if (inputs.length >= 32 || inputBytes > 32 * 1024 * 1024) {
				cancel()
				return
			}
			inputs.push(input)
		}
		let expire!: () => void
		const expired = new Promise<never>((_resolve, reject) => {
			expire = () => reject(new Error("Telegram transfer expired"))
		})
		const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, expired])
		const valid = () => !this.disposed && generation === this.generation && this.client === client
		const capture = ({ message }: { message: ClineMessage }) => {
			if (!valid()) return
			bytes +=
				JSON.stringify(message).length -
				(buffered.has(message.ts) ? JSON.stringify(buffered.get(message.ts)).length : 0)
			if ((buffered.size >= 1000 && !buffered.has(message.ts)) || bytes > 32 * 1024 * 1024) {
				cancel()
				return
			}
			buffered.set(message.ts, { ...message })
		}
		const created = (value: TaskLike) => {
			const task = value as Task
			if (!valid()) return
			if (candidate || (returningTo ? task.taskId !== returningTo : task.parentTask?.taskId !== from.taskId)) {
				cancel()
				return
			}
			candidate = task
			this.state = { ...this.state, status: "connecting", taskId: task.taskId }
			void this.publishState()
			task.on(RooCodeEventName.Message, capture)
		}
		const focused = (id: string) => {
			if (id !== candidate?.taskId) cancel()
		}
		const fault = () => cancel()
		const cleanup = () => {
			if (cleaned) return
			cleaned = true
			clearTimeout(timer)
			expire()
			candidate?.off(RooCodeEventName.Message, capture)
			this.provider.off(RooCodeEventName.TaskCreated, created)
			this.provider.off(RooCodeEventName.TaskFocused, focused)
			client.off("input", captureInput)
			client.off("fault", fault)
			client.off("disconnected", fault)
			buffered.clear()
		}
		const cancel = () => {
			cleanup()
			if (valid()) void this.fail(undefined, true)
		}
		const timer = setTimeout(() => {
			expire()
			cancel()
		}, 15_000)
		timer.unref()
		this.transfer = { from: from.taskId, cancel: cleanup }
		this.provider.on(RooCodeEventName.TaskCreated, created)
		this.provider.on(RooCodeEventName.TaskFocused, focused)
		client.on("input", captureInput)
		client.on("fault", fault)
		client.on("disconnected", fault)
		this.state = { ...this.state, status: "connecting" }
		void this.publishState()
		try {
			await bounded(this.bridge.prepareTransfer())
			if (!valid()) return undefined
			this.bridge = undefined
			const suspended = routeSchema.parse(
				await bounded(
					client.request({ operation: "beginTransfer", taskId: from.taskId, epoch: oldRoute.epoch }),
				),
			)
			if (!valid()) return undefined
			this.state.status = "connecting"
			await this.publishState()
			return {
				cancel,
				finish: async (task: Task) => {
					if (!valid() || cleaned) return
					try {
						if (task !== candidate || this.provider.getCurrentTask() !== task || task.abort)
							throw new Error("Telegram transfer target changed")
						const route = routeSchema.parse(
							await bounded(
								client.request({
									operation: "finishTransfer",
									taskId: task.taskId,
									epoch: suspended.epoch,
								}),
							),
						)
						if (!valid() || cleaned) return
						if (
							this.provider.getCurrentTask() !== task ||
							task.abort ||
							route.taskId !== task.taskId ||
							route.key !== oldRoute.key ||
							route.threadId !== oldRoute.threadId ||
							route.ownerId !== oldRoute.ownerId
						)
							throw new Error("Telegram transfer target changed")
						this.route = route
						const current = () => valid() && this.provider.getCurrentTask() === task && !task.abort
						this.bridge = new TelegramTaskBridge(
							task,
							client,
							route,
							current,
							() => {
								if (current()) void this.fail()
							},
							{
								approve: t("common:telegram.approve"),
								deny: t("common:telegram.deny"),
								thinking: t("common:telegram.thinking"),
								confirmation: t("common:telegram.confirmation"),
							},
							[...buffered.values()],
						)
						cleanup()
						this.transfer = undefined
						if (returningTo) this.lineage.pop()
						else this.lineage.push(task.taskId)
						for (const input of inputs) if (input.epoch === route.epoch) client.emit("input", input)
						if (!current()) return
						this.state = { ...this.state, status: "active", taskId: task.taskId }
						await this.publishState()
					} catch {
						cancel()
					}
				},
			}
		} catch {
			cancel()
			return undefined
		}
	}

	async fail(error?: unknown, notify = false): Promise<void> {
		const reason = error instanceof TelegramStartupError ? error.reason : "startup-failed"
		const message = t(`common:telegram.failure.${reason}`)
		// A fixed reason is safe for the output channel; never log exceptions, IPC payloads or bot credentials.
		this.provider.log(`Telegram activation failed (${reason})`)
		this.resetConnection()
		this.state.status = "error"
		this.state.error = message
		await this.publishState()
		if (notify) void vscode.window.showErrorMessage(message)
	}

	private resetConnection(): void {
		this.generation++
		this.transfer?.cancel()
		this.transfer = undefined
		this.route = undefined
		this.lineage = []
		this.bridge?.dispose()
		this.bridge = undefined
		this.client?.close()
		this.client = undefined
		this.state = { configured: this.state.configured, ownerId: this.state.ownerId, status: "inactive" }
	}

	async deactivate(taskId?: string): Promise<void> {
		if (taskId && taskId !== this.state.taskId && !this.lineage.includes(taskId)) return
		this.resetConnection()
		await this.publishState()
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.provider.off(RooCodeEventName.TaskUnfocused, this.onUnfocused)
		this.provider.off(RooCodeEventName.TaskAborted, this.onUnfocused)
		void this.deactivate()
	}
}
