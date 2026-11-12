import * as path from "node:path"
import { randomUUID } from "node:crypto"
import pWaitFor from "p-wait-for"
import * as vscode from "vscode"
import { z } from "zod"
import { RooCodeEventName, type TelegramState, type ClineMessage, type TaskLike } from "@roo-code/types"
import type { ClineProvider } from "../../../core/webview/ClineProvider"
import { t } from "../../../i18n"
import { readProjectTaskStorage } from "../project-task-storage"
import { telegramBootstrapSchema } from "./protocol"
import { launchTelegramCoordinator } from "./launchCoordinator"
import { telegramTopicTitle } from "./presentation"
import { generateTelegramTopicName } from "./topicTitle"
import { TelegramTaskBridge } from "./TelegramTaskBridge"
import type { TelegramLocalClient } from "./TelegramLocalClient"
import { TelegramStartupError, telegramFailure, telegramFailureDetails, decodeTelegramFailure } from "./startupFailure"
import { transcribeWithGroq } from "./groqTranscription"
import {
	TelegramProjectControl,
	telegramProjectCommands,
	telegramProjectHelp,
	telegramProjectTasks,
	taskLabel,
} from "./TelegramProjectControl"

import type { TelegramInput, TelegramRoute } from "./TelegramRouter"
import type { Task } from "../../../core/task/Task"

export interface TelegramTransfer {
	finish(task: Task): Promise<void>
	cancel(): void
}

const SECRET_KEY = "ivol.telegram.credentials.v1"
const GROQ_SECRET_KEY = "ivol.groq.apiKey.v1"
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

interface ProjectConnection {
	client?: TelegramLocalClient
	control?: TelegramProjectControl
	generation: number
}

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
	/** Project control topic: own coordinator connection, independent of the task topic lifecycle. */
	private project?: ProjectConnection
	private projectGeneration = 0

	/** Retained across socket/coordinator recovery, reset only for a new manual activation. */
	private projectSession?: { id: string; reconnects: number }

	/** User intent is independent of socket health. Only the off button/disposal clears it. */
	private enabled = false
	private recoveryEpoch = 0
	private recoveryTimer?: NodeJS.Timeout
	private recoveryRunning = false
	private retryDelay = 1000

	constructor(private readonly provider: ClineProvider) {
		provider.on(RooCodeEventName.TaskUnfocused, this.onUnfocused)
		provider.on(RooCodeEventName.TaskAborted, this.onUnfocused)
		provider.on(RooCodeEventName.TaskFocused, this.onFocused)
		provider.context.subscriptions.push(this)
	}

	/** While the button is on (project topic active), every task opened in the IDE follows into its own topic. */
	private onFocused = (taskId: string): void => {
		if (this.enabled) {
			this.scheduleRecovery(0)
			return
		}
		if (!this.project?.control || this.transfer) return
		const generation = this.project.generation
		void (async () => {
			const task = this.provider.getCurrentTask()
			if (!task || task.taskId !== taskId) return
			// The topic is named from the first message; give a new task a moment to record it.
			await pWaitFor(() => task.clineMessages.length > 0 || task.abort, { interval: 100, timeout: 5000 }).catch(
				() => undefined,
			)
			if (
				this.project?.generation !== generation ||
				this.transfer ||
				this.provider.getCurrentTask() !== task ||
				(this.state.status === "active" && this.state.taskId === taskId)
			)
				return
			await this.activate(taskId)
		})().catch(() => this.provider.log("Telegram auto-follow failed"))
	}

	private onUnfocused = (taskId: string): void => {
		if (this.state.taskId !== taskId) return
		if (this.transfer?.from === taskId) return
		void this.deactivate()
	}

	async publishState(): Promise<void> {
		if (this.disposed) return
		const state = {
			...this.state,
			enabled: this.enabled,
			...(this.enabled && this.state.status === "error" ? { status: "connecting" as const } : {}),
			...(this.enabled && !this.project?.control ? { projectStatus: "connecting" as const } : {}),
		}
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
		const groqConfigured = !!(await this.provider.context.secrets.get(GROQ_SECRET_KEY))
		if (this.disposed || generation !== this.generation || revision !== this.settingsRevision || this.saving) return
		this.state.configured = !!credentials
		this.state.ownerId = credentials?.ownerId
		this.state.groqConfigured = groqConfigured
		await this.publishState()
	}

	/** An empty key removes the stored one. The key never leaves secret storage except in the Groq request. */
	async saveGroqKey(apiKey: string | undefined): Promise<void> {
		const value = apiKey?.trim()
		if (value && (value.length > 512 || /\s/.test(value))) throw new Error("Invalid Groq API key")
		if (value) await this.provider.context.secrets.store(GROQ_SECRET_KEY, value)
		else await this.provider.context.secrets.delete(GROQ_SECRET_KEY)
		this.state = { ...this.state, groqConfigured: !!value }
		await this.publishState()
	}

	private transcribe = async (audio: string): Promise<string> =>
		transcribeWithGroq(audio, await this.provider.context.secrets.get(GROQ_SECRET_KEY))

	private bridgeLabels() {
		return {
			approve: t("common:telegram.approve"),
			deny: t("common:telegram.deny"),
			thinking: t("common:telegram.thinking"),
			confirmation: t("common:telegram.confirmation"),
			voiceFailed: t("common:telegram.voiceFailed"),
		}
	}

	private async credentials(): Promise<z.infer<typeof telegramBootstrapSchema> | undefined> {
		const stored = await this.provider.context.secrets.get(SECRET_KEY).then(undefined, (error) => {
			throw telegramFailure(error, "configuration")
		})
		if (!stored) return undefined
		try {
			return telegramBootstrapSchema.parse(JSON.parse(stored))
		} catch (error) {
			throw telegramFailure(error, "configuration")
		}
	}

	/** Opens the project topic and updates this manual session's saved introduction. */
	async activateProject(): Promise<void> {
		if (this.disposed || this.saving || this.project) return
		if (!vscode.workspace.isTrusted) throw new Error("Untrusted workspace")
		const generation = ++this.projectGeneration
		const entry: ProjectConnection = { generation }
		this.project = entry
		const current = () => !this.disposed && this.project === entry && this.projectGeneration === generation
		this.state = { ...this.state, projectStatus: "connecting", error: undefined }
		await this.publishState()
		let client: TelegramLocalClient | undefined
		let interrupted = false
		const captureFault = () => {
			interrupted = true
		}
		try {
			const credentials = await this.credentials()
			if (!credentials) throw new TelegramStartupError("startup-failed", "configuration", "unavailable")
			if (!current()) return
			client = await launchTelegramCoordinator(
				this.provider.context.extensionPath,
				credentials.token,
				credentials.ownerId,
			)
			if (!current()) {
				client.close()
				return
			}
			entry.client = client
			client.on("fault", captureFault)
			client.on("disconnected", captureFault)
			const cwd = this.provider.cwd
			const project = path.basename(cwd)
			const projectId = readProjectTaskStorage(cwd)?.projectId ?? cwd
			const recent = telegramProjectTasks(this.provider).map(taskLabel)
			const route = routeSchema.parse(
				await client.request({
					operation: "activateProject",
					projectId,
					title: t("common:telegram.project.topicTitle", { project }),
					help: [
						telegramProjectHelp(project, recent),
						...(this.projectSession
							? [t("common:telegram.project.reconnectCount", { count: this.projectSession.reconnects })]
							: []),
					].join("\n\n"),
					...(this.projectSession ? { sessionId: this.projectSession.id } : {}),
					commands: telegramProjectCommands(),
				}),
			)
			if (!current()) return
			if (interrupted) throw new TelegramStartupError("local-runtime", "reconnect", "unavailable")
			if (route.ownerId !== credentials.ownerId || route.chatId !== credentials.ownerId)
				throw new TelegramStartupError("local-runtime", "route", "invalid-response")
			entry.control = new TelegramProjectControl(this.provider, client, route, {
				activateTask: async (taskId) => {
					if (current()) await this.activate(taskId)
				},
				transcribe: this.transcribe,
				fault: (error) => {
					if (current()) void this.failProject(this.runtimeFailure(error))
				},
			})
			this.state = { ...this.state, projectStatus: "active" }
			await this.publishState()
		} catch (error) {
			if (current()) await this.failProject(error)
		} finally {
			client?.off("fault", captureFault)
			client?.off("disconnected", captureFault)
		}
	}

	private resetProject(): void {
		this.projectGeneration++
		this.project?.control?.dispose()
		this.project?.client?.close()
		this.project = undefined
		this.state = { ...this.state, projectStatus: "inactive" }
	}

	private async failProject(error?: unknown): Promise<void> {
		const reason = error instanceof TelegramStartupError ? error.reason : "startup-failed"
		this.provider.log(`Telegram project activation failed (${reason})${telegramFailureDetails(error)}`)
		// Count interrupted established connections, not every failed recovery attempt.
		if (this.project?.control && this.projectSession) this.projectSession.reconnects++
		this.resetProject()
		const message = t(`common:telegram.failure.${reason}`) + telegramFailureDetails(error)
		this.state = { ...this.state, error: message }
		await this.publishState()
		if (!this.enabled) void vscode.window.showErrorMessage(message)
		this.scheduleRecovery(this.retryDelay)
	}

	/** Button press: project topic always, plus the task topic when pressed inside a task. */
	async activateAll(_taskId?: string): Promise<void> {
		if (this.disposed || this.saving) return
		if (!this.enabled) this.projectSession = { id: randomUUID(), reconnects: 0 }
		this.enabled = true
		await this.publishState()
		await this.recover()
	}

	private scheduleRecovery(delay: number): void {
		if (!this.enabled || this.disposed || this.recoveryTimer || this.recoveryRunning) return
		this.recoveryTimer = setTimeout(() => {
			this.recoveryTimer = undefined
			void this.recover()
		}, delay)
		this.recoveryTimer.unref()
	}

	/** One recovery pass per intent epoch; late completions cannot revive a manually stopped connection. */
	private async recover(): Promise<void> {
		if (!this.enabled || this.disposed || this.recoveryRunning) return
		if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
		this.recoveryTimer = undefined
		this.recoveryRunning = true
		const epoch = this.recoveryEpoch
		try {
			if (this.saving || this.transfer) return
			const task = this.provider.getCurrentTask()
			const operations: Promise<void>[] = []
			if (!this.project) operations.push(this.activateProject())
			if (task && !task.abort && (this.state.status !== "active" || this.state.taskId !== task.taskId)) {
				operations.push(this.activate(task.taskId))
			}
			await Promise.all(operations)
		} catch (error) {
			if (epoch === this.recoveryEpoch && this.enabled) await this.fail(telegramFailure(error, "reconnect"))
		} finally {
			if (epoch === this.recoveryEpoch) {
				this.recoveryRunning = false
				const task = this.provider.getCurrentTask()
				const healthy =
					!!this.project?.control &&
					(!task || task.abort || (this.state.status === "active" && this.state.taskId === task.taskId))
				this.retryDelay = healthy ? 1000 : Math.min(this.retryDelay * 2, 30_000)
				this.scheduleRecovery(this.retryDelay)
			}
		}
	}

	private stopRecovery(): void {
		this.enabled = false
		this.recoveryEpoch++
		this.recoveryRunning = false
		this.retryDelay = 1000
		if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
		this.recoveryTimer = undefined
	}

	private runtimeFailure(value: unknown): TelegramStartupError {
		if (typeof value === "string") {
			try {
				const failure = decodeTelegramFailure(JSON.parse(value))
				if (failure) return failure
			} catch {
				// Legacy coordinators send plain text; never expose arbitrary IPC text.
			}
		}
		return decodeTelegramFailure(value) ?? new TelegramStartupError("local-runtime", "reconnect", "unavailable")
	}

	async deactivateAll(): Promise<void> {
		this.stopRecovery()
		this.resetProject()
		await this.deactivate()
	}

	async save(token: string | undefined, ownerId: string): Promise<void> {
		if (this.saving || this.disposed) throw new Error("Telegram settings unavailable")
		this.saving = true
		this.settingsRevision++
		this.resetConnection()
		this.resetProject()
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
			if (!credentials) throw new TelegramStartupError("startup-failed", "configuration", "unavailable")
			this.state = {
				configured: true,
				ownerId: credentials.ownerId,
				groqConfigured: this.state.groqConfigured,
				projectStatus: this.state.projectStatus,
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
			const fallbackTitle = t("common:telegram.taskTitle")
			const requestTitle = telegramTopicTitle(taskText, fallbackTitle)
			let title = requestTitle
			const projectId = readProjectTaskStorage(task.cwd)?.projectId ?? task.cwd
			const custom = this.customTopicName(taskId, project)
			if (!(await client.request({ operation: "hasTopic", projectId, taskId }))) {
				// A new topic gets the user's task name, otherwise "<project> / <short AI name>".
				title =
					custom ?? (await generateTelegramTopicName(project, taskText, task.apiConfiguration, fallbackTitle))
				if (!current()) {
					client.close()
					return
				}
			} else if (custom) {
				// The task may have been renamed while it was not connected; "not modified" is ignored.
				await client
					.request({ operation: "renameTopic", projectId, taskId, title: custom })
					.catch(() => this.provider.log("Telegram topic rename failed"))
				if (!current()) {
					client.close()
					return
				}
			}
			const route = routeSchema.parse(
				await client.request({
					operation: "activate",
					projectId,
					taskId,
					title,
					taskText,
					notice: t("common:telegram.notice", { project, task: requestTitle }),
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
				throw new TelegramStartupError("local-runtime", "route", "invalid-response")
			if (overflow || connectionFault) throw new Error("Telegram activation interrupted")
			this.route = route
			this.lineage = [taskId]
			this.bridge = new TelegramTaskBridge(
				task,
				client,
				route,
				current,
				(error) => {
					if (current()) void this.fail(this.runtimeFailure(error))
				},
				this.bridgeLabels(),
				[...buffered.values()],
				this.transcribe,
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
			// A task can change/abort during an awaited launch without a matching unfocus event.
			if (this.generation === generation && !current()) {
				this.resetConnection()
				await this.publishState()
			}
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
							(error) => {
								if (current()) void this.fail(this.runtimeFailure(error))
							},
							this.bridgeLabels(),
							[...buffered.values()],
							this.transcribe,
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
		const message = t(`common:telegram.failure.${reason}`) + telegramFailureDetails(error)
		// A fixed reason is safe for the output channel; never log exceptions, IPC payloads or bot credentials.
		this.provider.log(`Telegram activation failed (${reason})${telegramFailureDetails(error)}`)
		this.resetConnection()
		this.state.status = "error"
		this.state.error = message
		await this.publishState()
		if (notify && !this.enabled) void vscode.window.showErrorMessage(message)
		this.scheduleRecovery(this.retryDelay)
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
		this.state = {
			configured: this.state.configured,
			ownerId: this.state.ownerId,
			groqConfigured: this.state.groqConfigured,
			projectStatus: this.state.projectStatus,
			status: "inactive",
		}
	}

	/** "<project> / <user task name>" when the task was renamed in the history, otherwise undefined. */
	private customTopicName(taskId: string, project: string): string | undefined {
		const custom = this.provider
			.getTaskHistory()
			.find((item) => item.id === taskId)
			?.title?.trim()
		return custom ? Array.from(`${project} / ${custom}`).slice(0, 128).join("") : undefined
	}

	/** Called after a task rename: the existing topic of that task follows the new name. */
	async renameTask(taskId: string): Promise<void> {
		const client = this.client ?? this.project?.client
		if (!client || this.disposed) return
		const cwd = this.provider.cwd
		const title = this.customTopicName(taskId, path.basename(cwd))
		if (!title) return
		const projectId = readProjectTaskStorage(cwd)?.projectId ?? cwd
		await client.request({ operation: "renameTopic", projectId, taskId, title })
	}

	async deactivate(taskId?: string): Promise<void> {
		if (taskId && taskId !== this.state.taskId && !this.lineage.includes(taskId)) return
		this.resetConnection()
		await this.publishState()
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.stopRecovery()
		this.provider.off(RooCodeEventName.TaskUnfocused, this.onUnfocused)
		this.provider.off(RooCodeEventName.TaskAborted, this.onUnfocused)
		this.provider.off(RooCodeEventName.TaskFocused, this.onFocused)
		this.resetProject()
		void this.deactivate()
	}
}
