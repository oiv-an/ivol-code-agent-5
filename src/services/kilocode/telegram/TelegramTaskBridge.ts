import { createHash } from "node:crypto"
import { RooCodeEventName, type ClineMessage } from "@roo-code/types"
import type { Task } from "../../../core/task/Task"
import type { TelegramLocalClient } from "./TelegramLocalClient"
import type { TelegramInput, TelegramRoute } from "./TelegramRouter"

import { buttonAsks, telegramPresentation } from "./presentation"

/** A bridge can address only the exact task instance explicitly activated in the plugin. */
export class TelegramTaskBridge {
	private disposed = false
	private readonly timer: NodeJS.Timeout
	private lastPending?: number
	private approvalRevision = 0
	private readonly dirty = new Map<number, ClineMessage>()
	private flushing = false
	private flushPromise?: Promise<void>
	private readonly sentImages = new Set<string>()
	private readonly answered = new Set<string>()
	private thinking?: number
	private phase = 0
	private lastVisibleTs = -Infinity
	private readonly messageKeys = new Map<number, number>()
	private lastMessageUpdateId = -1

	constructor(
		private readonly task: Task,
		private readonly client: TelegramLocalClient,
		private readonly route: TelegramRoute,
		private readonly isCurrent: () => boolean,
		private readonly onFault: (message: string) => void,
		private readonly labels: { approve: string; deny: string; thinking: string; confirmation: string },
		initialMessages: ClineMessage[] = [],
	) {
		for (const message of initialMessages) this.onMessage({ message })
		task.on(RooCodeEventName.Message, this.onMessage)
		task.on(RooCodeEventName.TaskAskResponded, this.onAskResponded)
		task.on(RooCodeEventName.TaskUnfocused, this.onUnfocused)
		task.on(RooCodeEventName.TaskAborted, this.onUnfocused)
		client.on("input", this.onInput)
		client.on("fault", this.onClientFault)
		client.on("disconnected", this.onDisconnected)
		this.timer = setInterval(() => this.tick(), 300)
		this.timer.unref()
	}

	private active(): boolean {
		return !this.disposed && !this.task.abort && !this.task.abandoned && this.isCurrent()
	}

	private onMessage = ({ message }: { message: ClineMessage }): void => {
		if (!this.active()) return
		const presentation = telegramPresentation(message)
		if (presentation.kind === "ignore") return
		if (
			presentation.kind === "approval" &&
			!message.partial &&
			(this.task.getRemotePendingAsk()?.ts !== message.ts ||
				this.answered.has(`${this.task.instanceId}:${message.ts}`))
		)
			return
		if (presentation.kind === "activity" || (presentation.kind === "approval" && message.partial)) {
			if (message.ts > this.lastVisibleTs && !this.task.getRemotePendingAsk()) this.startThinking()
			return
		}
		if (presentation.kind === "text" && !presentation.text && !presentation.images?.length) return
		this.lastVisibleTs = Math.max(this.lastVisibleTs, message.ts)
		if (this.thinking !== undefined && !this.messageKeys.has(message.ts)) {
			this.messageKeys.set(message.ts, this.thinking)
			this.dirty.delete(this.thinking)
			this.thinking = undefined
		}
		this.dirty.set(message.ts, { ...message })
		if (this.dirty.size > 1000) this.fail("Telegram task queue is full")
	}

	private startThinking(): void {
		if (this.thinking !== undefined) return
		this.thinking = --this.phase
		this.dirty.set(this.thinking, { ts: this.thinking, type: "say", say: "text", text: this.labels.thinking })
	}

	private onAskResponded = (): void => {
		this.tick()
	}

	private onUnfocused = (): void => {
		this.dispose()
	}
	private onClientFault = (message: string): void => {
		this.fail(message)
	}
	private onDisconnected = (): void => {
		this.fail("Telegram coordinator disconnected")
	}

	private onInput = (input: TelegramInput): void => {
		if (!this.active() || input.taskId !== this.task.taskId || input.epoch !== this.route.epoch) return
		if (input.kind === "message") {
			if (!Number.isSafeInteger(input.updateId) || input.updateId <= this.lastMessageUpdateId) return
			this.lastMessageUpdateId = input.updateId
			// Bound retained media while the task is busy. Text and images keep their arrival order.
			const queued = this.task.messageQueueService.messages.filter((message) => message.source === "telegram")
			const size = (text: string, images?: string[]) =>
				text.length + (images?.reduce((n, image) => n + image.length, 0) ?? 0)
			if (
				queued.length >= 32 ||
				queued.reduce((n, message) => n + size(message.text, message.images), size(input.text, input.images)) >
					32 * 1024 * 1024
			) {
				this.fail("Telegram task input queue is full")
				return
			}
			// Never start/open/resume an IDE task and never synthesize approval from media.
			if (!this.task.messageQueueService.isEmpty() || !this.task.respondToRemoteText(input.text, input.images))
				this.task.messageQueueService.addMessage(input.text, input.images, "telegram")
		} else if (input.kind === "stop") {
			const provider = this.task.providerRef.deref()
			if (provider?.getCurrentTask() === this.task) {
				void provider.cancelTask().catch(() => this.fail("Telegram stop failed"))
			}
		} else {
			const pending = this.task.getRemotePendingAsk()
			if (
				!pending ||
				!buttonAsks.has(pending.ask ?? "") ||
				`${this.task.instanceId}:${pending.ts}` !== input.requestId ||
				this.answered.has(input.requestId)
			)
				return
			this.answered.add(input.requestId)
			if (pending.ask === "command_output") {
				void this.task
					.handleTerminalOperation(input.approved ? "continue" : "abort")
					.catch(() => this.fail("Telegram terminal operation failed"))
			} else if (
				!input.approved &&
				[
					"api_req_failed",
					"mistake_limit_reached",
					"resume_task",
					"report_bug",
					"condense",
					"auto_approval_max_req_reached",
				].includes(pending.ask ?? "")
			) {
				// Unlike the desktop secondary button, never create a new task remotely.
				const provider = this.task.providerRef.deref()
				if (provider?.getCurrentTask() === this.task)
					void provider.cancelTask().catch(() => this.fail("Telegram stop failed"))
			} else {
				this.task.respondToRemoteAsk(pending.ts, input.approved)
			}
		}
	}

	private tick(): void {
		if (!this.active()) {
			this.dispose()
			return
		}
		const pending = this.task.getRemotePendingAsk()
		if (pending?.ts !== this.lastPending) {
			this.lastPending = pending?.ts
			this.approvalRevision++
			void this.client
				.request({
					operation: "invalidateApproval",
					approvalRevision: this.approvalRevision,
					taskId: this.task.taskId,
					epoch: this.route.epoch,
				})
				.catch(() => this.fail("Telegram approval synchronization failed"))
			if (pending) this.onMessage({ message: pending })
			else this.startThinking()
		}
		if (!this.flushing && this.dirty.size) this.flushPromise = this.flush()
	}

	private async flush(): Promise<void> {
		this.flushing = true
		try {
			while (this.active() && this.dirty.size) {
				const message = this.dirty.values().next().value as ClineMessage
				this.dirty.delete(message.ts)
				const presentation = telegramPresentation(message)
				const images = [...(presentation.images ?? [])]
				if (!this.active()) return
				const pending = this.task.getRemotePendingAsk()
				const buttonAsk =
					pending?.ts === message.ts &&
					!this.answered.has(`${this.task.instanceId}:${message.ts}`) &&
					buttonAsks.has(message.ask ?? "")
				// Recheck at flush time: an answered/obsolete ask must never reveal its raw payload.
				if (presentation.kind === "approval" && !buttonAsk) continue
				const text = presentation.kind === "approval" ? this.labels.confirmation : presentation.text
				if (text)
					await this.client.request({
						operation: "publish",
						taskId: this.task.taskId,
						epoch: this.route.epoch,
						messageId: `${this.route.epoch}:${this.messageKeys.get(message.ts) ?? message.ts}`,
						text,
						partial: message.partial === true,
						markdown: presentation.kind === "text" && message.ts >= 0,
						approvalRevision: this.approvalRevision,
						approval: buttonAsk
							? {
									requestId: `${this.task.instanceId}:${message.ts}`,
									approveLabel: this.labels.approve,
									denyLabel: this.labels.deny,
								}
							: undefined,
					})
				for (const image of images) {
					if (!this.active()) return
					const messageId = `${this.route.epoch}:${message.ts}:${createHash("sha256").update(image).digest("hex")}`
					if (this.sentImages.has(messageId)) continue
					await this.client.request({
						operation: "publishImage",
						taskId: this.task.taskId,
						epoch: this.route.epoch,
						messageId,
						image,
					})
					this.sentImages.add(messageId)
				}
			}
		} catch {
			this.fail("Telegram task delivery failed")
		} finally {
			this.flushing = false
		}
	}

	private fail(message: string): void {
		if (this.disposed) return
		this.dispose()
		this.onFault(message)
	}

	async prepareTransfer(): Promise<void> {
		await this.flushPromise
		if (this.active() && this.dirty.size) await this.flush()
		this.dispose(false)
	}

	dispose(closeConnection = true): void {
		if (this.disposed) return
		this.disposed = true
		clearInterval(this.timer)
		this.dirty.clear()
		this.task.off(RooCodeEventName.Message, this.onMessage)
		this.task.off(RooCodeEventName.TaskAskResponded, this.onAskResponded)
		this.task.off(RooCodeEventName.TaskUnfocused, this.onUnfocused)
		this.task.off(RooCodeEventName.TaskAborted, this.onUnfocused)
		this.client.off("input", this.onInput)
		this.client.off("fault", this.onClientFault)
		this.client.off("disconnected", this.onDisconnected)
		// Each bridge owns its connection. Closing it synchronously prevents task-switch races.
		if (closeConnection) this.client.close()
	}
}
