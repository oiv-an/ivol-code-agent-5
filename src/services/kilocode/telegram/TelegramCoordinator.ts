import { setTimeout as delay } from "node:timers/promises"
import { randomBytes } from "node:crypto"
import { TelegramApi, TelegramApiError, type TelegramUser } from "./TelegramApi"
import { TelegramRouter, type TelegramInput, type TelegramRoute, type TelegramAcceptedInput } from "./TelegramRouter"
import { TelegramTopicStore } from "./TelegramTopicStore"
import { TelegramOutbox } from "./TelegramOutbox"
import { TelegramMessageRenderer } from "./TelegramMessageRenderer"
import type { TelegramCoordinatorRequest } from "./protocol"
import { telegramFailure } from "./startupFailure"

type PublishRequest = Extract<TelegramCoordinatorRequest, { operation: "publish" }>

/** Topic-store task id of a project control topic; real task ids never contain "__". */
export const TELEGRAM_PROJECT_TOPIC_ID = "__project__"

interface Connection {
	route?: TelegramRoute
	project?: { route: TelegramRoute; controller: AbortController; tail: Promise<void>; pending: number }
	controller?: AbortController
	incomingController?: AbortController
	transferTimer?: NodeJS.Timeout
	lastSeen: number
	generation: number
	send: (input: TelegramInput) => void
	fault: (message: string) => void
	outbox?: TelegramOutbox
	images?: Set<string>
	imagePending?: boolean
	approvalRevision?: number
	answered?: Set<string>
	incoming?: { tail: Promise<void>; pending: number }
	approval?: {
		messageId: string
		text: string
		requestId: string
		token: string
		approveLabel: string
		denyLabel: string
	}
}

/** One instance per bot, hosted by the elected local process. Task creation is only owner input in a project topic. */
export class TelegramCoordinator {
	private readonly router = new TelegramRouter()
	private readonly clients = new Map<string, Connection>()
	private offset = 0
	private controller = new AbortController()
	private poll?: Promise<void>
	private bot?: TelegramUser
	private activating: Promise<void> = Promise.resolve()
	private healthy = false
	private maintenance?: NodeJS.Timeout
	private sequenceStartedAt = Date.now()

	private downloads = 0

	constructor(
		private readonly api: TelegramApi,
		private readonly ownerId: number,
		private readonly store: TelegramTopicStore,
		private readonly report: (message: string) => void,
	) {}

	async start(): Promise<TelegramUser> {
		this.bot = await this.api.verify(this.controller.signal)
		await this.store.load()
		// Drain with no routes before accepting clients; offline commands never execute.
		await this.drain()
		this.healthy = true
		this.maintenance = setInterval(() => {
			for (const [id, client] of this.clients) {
				if (Date.now() - client.lastSeen > 15_000) this.disconnect(id)
			}
		}, 5000)
		this.maintenance.unref()
		this.poll = this.pollLoop()
		return this.bot
	}

	connect(
		clientId: string,
		send: (input: TelegramInput) => void,
		fault: (message: string) => void = this.report,
	): void {
		if (this.clients.has(clientId)) throw new Error("Duplicate Telegram client")
		this.clients.set(clientId, { lastSeen: Date.now(), generation: 0, send, fault })
	}

	heartbeat(clientId: string): void {
		this.connection(clientId).lastSeen = Date.now()
	}

	private connection(clientId: string): Connection {
		const client = this.clients.get(clientId)
		if (!client) throw new Error("Telegram client disconnected")
		return client
	}

	disconnect(clientId: string): void {
		this.deactivate(clientId)
		this.deactivateProject(clientId)
		this.clients.delete(clientId)
	}

	deactivateProject(clientId: string): void {
		const client = this.clients.get(clientId)
		client?.project?.controller.abort()
		if (client) client.project = undefined
		this.router.deactivateProject(clientId)
	}

	/** Creates the topic once; reconnects edit the introduction saved for this manual session. */
	async activateProject(
		clientId: string,
		projectId: string,
		title: string,
		help: string,
		commands: { command: string; description: string }[],
		sessionId?: string,
	): Promise<TelegramRoute> {
		const client = this.connection(clientId)
		this.deactivateProject(clientId)
		let result: TelegramRoute | undefined
		const operation = this.activating.then(async () => {
			if (this.clients.get(clientId) !== client) throw new Error("Telegram activation cancelled")
			if (!this.bot || !this.healthy) throw new Error("Telegram is not connected")
			const key = TelegramTopicStore.key(this.bot.id, this.ownerId, projectId, TELEGRAM_PROJECT_TOPIC_ID)
			const controller = new AbortController()
			const signal = AbortSignal.any([controller.signal, this.controller.signal])
			let threadId = this.store.get(key)
			if (!threadId) {
				await this.store.set(key, null)
				threadId = await this.api.createTopic(this.ownerId, title, signal)
				await this.store.set(key, threadId)
			}
			if (commands.length) {
				// The "/" menu is cosmetic; a failure must not block the control topic.
				await this.api.setCommands(this.ownerId, commands, signal).catch(() => undefined)
			}
			let messageId = sessionId ? this.store.getProjectMessage(key, sessionId) : undefined
			if (messageId) {
				try {
					await this.api.editText(this.ownerId, messageId, help, signal)
				} catch (error) {
					if (!(error instanceof TelegramApiError)) throw error
					if (error.reason === "message-not-found") messageId = undefined
					else if (error.reason !== "message-not-modified") throw error
				}
			}
			if (!messageId) {
				const ids = await this.api.sendText(this.ownerId, threadId, help, signal)
				messageId = ids[0]
				// Persist before pinning/route acknowledgement so a lost local response can reuse the message.
				if (messageId && sessionId) await this.store.setProjectMessage(key, sessionId, messageId)
				if (messageId) await this.api.pinMessage(this.ownerId, messageId, signal).catch(() => undefined)
			}
			signal.throwIfAborted()
			if (this.clients.get(clientId) !== client) throw new Error("Telegram activation cancelled")
			result = this.router.activateProject({
				key,
				clientId,
				taskId: TELEGRAM_PROJECT_TOPIC_ID,
				chatId: this.ownerId,
				ownerId: this.ownerId,
				threadId,
				activatedAt: Math.ceil(Date.now() / 1000) * 1000,
				minimumUpdateId: this.offset,
			})
			client.project = { route: result, controller, tail: Promise.resolve(), pending: 0 }
		})
		this.activating = operation.then(
			() => undefined,
			() => undefined,
		)
		await operation
		return result!
	}

	async projectSend(
		clientId: string,
		epoch: string,
		text: string,
		keyboard?: { text: string; callback_data: string }[][],
	): Promise<void> {
		const client = this.connection(clientId)
		const project = client.project
		if (!project || project.route.epoch !== epoch) throw new Error("Telegram project topic is no longer active")
		const signal = AbortSignal.any([project.controller.signal, this.controller.signal])
		await this.api.sendText(project.route.chatId, project.route.threadId, text, signal, keyboard)
	}

	private dispatchProject(accepted: TelegramAcceptedInput, client: Connection): void {
		const project = client.project
		const { input, voice, callbackId } = accepted
		if (!project || input.epoch !== project.route.epoch) return
		const signal = AbortSignal.any([project.controller.signal, this.controller.signal])
		if (callbackId) void this.api.answerCallbackQuery(callbackId, signal).catch(() => undefined)
		if (project.pending >= 16) return
		project.pending++
		project.tail = project.tail
			.then(async () => {
				if (signal.aborted || client.project !== project) return
				let audio: string | undefined
				if (voice) {
					if (this.downloads >= 4) throw new Error("download limit")
					this.downloads++
					try {
						audio = await this.api.downloadVoice(voice, signal)
					} finally {
						this.downloads--
					}
				}
				if (!signal.aborted && client.project === project) client.send({ ...input, audio } as TelegramInput)
			})
			.catch(() => {
				if (!signal.aborted) client.fault("Telegram project message failed (voice size, format or timeout)")
			})
			.finally(() => {
				project.pending--
			})
	}

	deactivate(clientId: string): void {
		const client = this.clients.get(clientId)
		client?.controller?.abort()
		client?.incomingController?.abort()
		if (client?.transferTimer) clearTimeout(client.transferTimer)
		if (client) client.transferTimer = undefined
		if (client) {
			client.outbox?.clear()
			client.outbox = undefined
			client.images = undefined
			client.imagePending = false
			client.incoming = undefined
			client.approval = undefined
			client.approvalRevision = 0
			client.generation++
			client.route = undefined
			client.controller = undefined
		}
		this.router.deactivate(clientId)
	}

	async activate(
		clientId: string,
		projectId: string,
		taskId: string,
		title: string,
		notice: string,
		taskText?: string,
	): Promise<TelegramRoute> {
		const client = this.connection(clientId)
		this.deactivate(clientId)
		const generation = client.generation
		let result: TelegramRoute | undefined
		const operation = this.activating.then(async () => {
			if (this.clients.get(clientId) !== client || client.generation !== generation) {
				throw new Error("Telegram activation cancelled")
			}
			if (!this.bot || !this.healthy) throw new Error("Telegram is not connected")
			const key = TelegramTopicStore.key(this.bot.id, this.ownerId, projectId, taskId)
			if ([...this.clients.values()].some((other) => other.route?.key === key)) {
				throw new Error("Task is connected in another window")
			}
			const controller = new AbortController()
			client.controller = controller
			const signal = AbortSignal.any([controller.signal, this.controller.signal])
			let threadId = this.store.get(key)
			if (!threadId) {
				// Persist uncertainty before the non-idempotent API call. A crash or lost
				// response must never silently create a duplicate topic on retry.
				await this.store.set(key, null)
				threadId = await this.api.createTopic(this.ownerId, title, signal)
				await this.store.set(key, threadId)
				if (taskText?.trim()) {
					const ids = await this.api.sendText(this.ownerId, threadId, taskText, signal)
					if (ids[0]) await this.api.pinMessage(this.ownerId, ids[0], signal)
				}
			}
			// Topic stays inactive throughout setup. A notice does not invoke the model.
			await this.api.sendText(this.ownerId, threadId, notice, signal)
			signal.throwIfAborted()
			if (this.clients.get(clientId) !== client || client.generation !== generation) {
				throw new Error("Telegram activation cancelled")
			}
			result = this.router.activate({
				key,
				clientId,
				taskId,
				chatId: this.ownerId,
				ownerId: this.ownerId,
				threadId,
				// Reject the ambiguous current second rather than replay offline input.
				activatedAt: Math.ceil(Date.now() / 1000) * 1000,
				minimumUpdateId: this.offset,
			})
			client.route = result
			client.images = new Set()
			client.answered = new Set()
			client.incomingController = new AbortController()
			client.incoming = { tail: Promise.resolve(), pending: 0 }
			const route = result
			const renderer = new TelegramMessageRenderer(this.api, route.chatId, route.threadId, signal)
			client.outbox = new TelegramOutbox(
				async (item) => {
					if (signal.aborted) return
					if (item.image) {
						await this.api.sendImage(route.chatId, route.threadId, item.text, signal)
						return
					}
					const keyboard = () => {
						const approval =
							client.approval?.messageId === item.key && !item.partial ? client.approval : undefined
						return approval
							? [
									[
										{ text: approval.approveLabel, callback_data: `ivol:${approval.token}:yes` },
										{ text: approval.denyLabel, callback_data: `ivol:${approval.token}:no` },
									],
								]
							: undefined
					}
					await renderer.render(item.key, item.text, keyboard, item.markdown)
				},
				() => {
					if (!signal.aborted) {
						this.deactivate(clientId)
						client.fault("Telegram message delivery failed; reconnect from the plugin")
					}
				},
			)
		})
		// The caller receives activation failures; do not disconnect other windows.
		this.activating = operation.then(
			() => undefined,
			() => undefined,
		)
		await operation
		return result!
	}

	/** Applies a user rename to an existing task topic; "not modified" and missing topics are ignored. */
	async renameTopic(clientId: string, projectId: string, taskId: string, title: string): Promise<boolean> {
		this.connection(clientId)
		if (!this.bot || !this.healthy) throw new Error("Telegram is not connected")
		const threadId = this.store.get(TelegramTopicStore.key(this.bot.id, this.ownerId, projectId, taskId))
		if (!threadId) return false
		try {
			await this.api.renameTopic(this.ownerId, threadId, title, this.controller.signal)
		} catch (error) {
			if (!(error instanceof TelegramApiError) || error.code !== 400) throw error
		}
		return true
	}

	hasTopic(clientId: string, projectId: string, taskId: string): boolean {
		this.connection(clientId)
		if (!this.bot) throw new Error("Telegram is not connected")
		try {
			return this.store.get(TelegramTopicStore.key(this.bot.id, this.ownerId, projectId, taskId)) !== undefined
		} catch {
			return true // An unresolved creation is never named again; activation reports the recovery error.
		}
	}

	/** Suspend input before the old Task is removed; retain the root topic and output queue. */
	beginTransfer(clientId: string, taskId: string, epoch: string): TelegramRoute {
		const client = this.connection(clientId)
		if (!client.route || client.route.taskId !== taskId || client.route.epoch !== epoch || client.transferTimer)
			throw new Error("Telegram transfer is no longer current")
		this.invalidateApproval(clientId, epoch)
		this.router.deactivate(clientId)
		client.incomingController?.abort()
		client.incoming = undefined
		client.route = { ...client.route, epoch: randomBytes(12).toString("hex") }
		client.transferTimer = setTimeout(() => {
			this.deactivate(clientId)
			client.fault("Telegram task transfer timed out; reconnect from the plugin")
		}, 15_000)
		client.transferTimer.unref()
		return client.route
	}

	finishTransfer(clientId: string, taskId: string, epoch: string): TelegramRoute {
		const client = this.connection(clientId)
		if (!client.route || client.route.epoch !== epoch || !client.transferTimer || !this.healthy)
			throw new Error("Telegram transfer is no longer current")
		clearTimeout(client.transferTimer)
		client.transferTimer = undefined
		client.route = this.router.activate({
			...client.route,
			taskId,
			activatedAt: Math.ceil(Date.now() / 1000) * 1000,
			minimumUpdateId: this.offset,
		})
		client.approvalRevision = 0
		client.answered = new Set()
		client.incomingController = new AbortController()
		client.incoming = { tail: Promise.resolve(), pending: 0 }
		return client.route
	}

	private async drain(): Promise<void> {
		while (!this.controller.signal.aborted) {
			const updates = await this.api.updates(this.offset, this.controller.signal, 0)
			if (!updates.length) return
			for (const update of updates) this.offset = Math.max(this.offset, update.update_id + 1)
		}
	}

	private async pollLoop(): Promise<void> {
		let retryDelay = 1000
		let recovering = false
		while (!this.controller.signal.aborted) {
			try {
				// Telegram may choose a new random update sequence after a week without
				// updates. Rotate the cursor before that boundary, with no active routes.
				if (Date.now() - this.sequenceStartedAt > 6 * 24 * 60 * 60 * 1000) {
					this.healthy = false
					for (const clientId of this.clients.keys()) {
						this.deactivate(clientId)
						this.deactivateProject(clientId)
					}
					this.router.resetUpdateSequence()
					this.offset = 0
					this.report("Telegram long-running connection expired; reconnect from the plugin")
					await this.drain()
					this.sequenceStartedAt = Date.now()
				}
				const updates = await this.api.updates(this.offset, this.controller.signal)
				if (recovering) {
					// Empty the entire offline backlog before permitting fresh routes, including menu callbacks.
					for (const update of updates) this.offset = Math.max(this.offset, update.update_id + 1)
					await this.drain()
					recovering = false
					this.healthy = true
					retryDelay = 1000
					continue
				}
				this.healthy = true
				retryDelay = 1000
				for (const update of updates) {
					this.offset = Math.max(this.offset, update.update_id + 1)
					const accepted = this.router.accept(update)
					if (!accepted) continue
					const client = this.clients.get(accepted.clientId)
					if (!client || Date.now() - client.lastSeen > 15_000) {
						this.disconnect(accepted.clientId)
						continue
					}
					this.dispatch(accepted, client)
				}
			} catch (error) {
				if (this.controller.signal.aborted) return
				this.healthy = false
				recovering = true
				// Invalidate old commands/approvals; enabled IDE clients automatically obtain fresh routes.
				for (const clientId of this.clients.keys()) {
					this.deactivate(clientId)
					this.deactivateProject(clientId)
				}
				this.report(JSON.stringify(telegramFailure(error, "getUpdates")))
				try {
					await delay(retryDelay, undefined, { signal: this.controller.signal })
					retryDelay = Math.min(retryDelay * 2, 30_000)
				} catch {
					return // Shutdown interrupted the reconnect delay.
				}
			}
		}
	}

	private dispatch(accepted: TelegramAcceptedInput, client: Connection): void {
		if (accepted.input.kind === "project") return this.dispatchProject(accepted, client)
		const { input, clientId, image, voice, callbackId } = accepted
		const signal =
			client.controller && client.incomingController
				? AbortSignal.any([client.controller.signal, client.incomingController.signal])
				: client.controller?.signal
		const current = () =>
			!signal?.aborted &&
			this.clients.get(clientId) === client &&
			client.route?.epoch === input.epoch &&
			Date.now() - client.lastSeen <= 15_000
		if (!signal || !current()) return
		if (input.kind === "stop") {
			// Stop bypasses downloads and discards their entire epoch, not just the current file.
			this.deactivate(clientId)
			client.send(input)
			return
		}
		if (input.kind === "approval") {
			client.answered?.add(input.requestId)
			this.invalidateApproval(clientId, input.epoch)
			// Consumption happened in the router. Ack failure must never cause replay or polling failure.
			if (callbackId)
				void this.api.answerCallbackQuery(callbackId, signal).catch(() => {
					if (current()) this.report("Telegram button acknowledgement failed")
				})
			client.send(input)
			return
		}
		const queue = client.incoming
		if (!queue) return
		if (queue.pending >= 32) {
			this.deactivate(clientId)
			client.fault("Telegram incoming queue is full; reconnect from the plugin")
			return
		}
		queue.pending++
		queue.tail = queue.tail
			.then(async () => {
				if (!current()) return
				let images: string[] | undefined
				let audio: string | undefined
				if (image || voice) {
					// Bound aggregate memory and connections across all IDE windows too.
					if (this.downloads >= 4) throw new Error("download limit")
					this.downloads++
					try {
						if (image) images = [await this.api.downloadImage(image, signal)]
						else if (voice) audio = await this.api.downloadVoice(voice, signal)
					} finally {
						this.downloads--
					}
				}
				if (current()) client.send({ ...input, images, audio })
			})
			.catch(() => {
				if (current()) {
					this.deactivate(clientId)
					client.fault(
						"Telegram incoming message failed (media format, size, timeout or download limit); reconnect from the plugin",
					)
				}
			})
			.finally(() => {
				queue.pending--
			})
	}

	async publishImage(
		clientId: string,
		request: Extract<TelegramCoordinatorRequest, { operation: "publishImage" }>,
	): Promise<void> {
		const client = this.connection(clientId)
		const route = client.route
		if (
			!route ||
			client.transferTimer ||
			route.epoch !== request.epoch ||
			route.taskId !== request.taskId ||
			!client.controller ||
			!client.images
		) {
			throw new Error("Telegram route is no longer active")
		}
		const key = `image:${request.messageId}`
		if (client.images.has(key)) return
		if (client.images.size >= 1000) throw new Error("Telegram image queue limit reached")
		try {
			client.outbox!.enqueue(key, request.image, false, true)
			client.images.add(key)
		} catch (error) {
			this.deactivate(clientId)
			client.fault("Telegram image queue is full; reconnect from the plugin")
			throw error
		}
	}

	invalidateApproval(clientId: string, epoch: string, revision?: number): void {
		const client = this.connection(clientId)
		if (client.route?.epoch === epoch) {
			if (revision !== undefined && revision <= (client.approvalRevision ?? 0)) return
			if (revision !== undefined) client.approvalRevision = revision
			this.router.invalidateApprovals(client.route.key)
			const previous = client.approval
			client.approval = undefined
			if (previous) client.outbox?.enqueue(previous.messageId, previous.text, false)
		}
	}

	publish(clientId: string, request: PublishRequest): void {
		const client = this.connection(clientId)
		const route = client.route
		if (
			!route ||
			client.transferTimer ||
			route.epoch !== request.epoch ||
			route.taskId !== request.taskId ||
			!client.outbox
		) {
			throw new Error("Telegram route is no longer active")
		}
		const revision = request.approvalRevision ?? 0
		if (revision > (client.approvalRevision ?? 0)) this.invalidateApproval(clientId, request.epoch, revision)
		if (
			revision === (client.approvalRevision ?? 0) &&
			request.approval &&
			!client.answered?.has(request.approval.requestId) &&
			!request.partial
		) {
			if (client.approval?.requestId !== request.approval.requestId) {
				this.invalidateApproval(clientId, request.epoch)
				client.approval = {
					...request.approval,
					messageId: request.messageId,
					text: request.text,
					token: this.router.createApproval(route, request.approval.requestId),
				}
			} else {
				client.approval.text = request.text
			}
		} else if (revision === (client.approvalRevision ?? 0) && client.approval?.messageId === request.messageId) {
			this.invalidateApproval(clientId, request.epoch)
		}
		try {
			client.outbox.enqueue(
				request.messageId,
				request.text,
				request.partial,
				false,
				request.markdown === true && !request.approval,
			)
		} catch (error) {
			this.deactivate(clientId)
			client.fault("Telegram delivery queue is full; reconnect from the plugin")
			throw error
		}
	}

	async stop(): Promise<void> {
		this.healthy = false
		if (this.maintenance) clearInterval(this.maintenance)
		this.controller.abort()
		for (const clientId of this.clients.keys()) this.disconnect(clientId)
		await this.poll
	}
}
