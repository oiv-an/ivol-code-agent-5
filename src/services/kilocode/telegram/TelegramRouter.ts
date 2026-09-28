import { randomBytes } from "node:crypto"
import type { TelegramUpdate, TelegramImageFile } from "./TelegramApi"
import type { TelegramInput } from "./protocol"
export type { TelegramInput } from "./protocol"

export interface TelegramRoute {
	key: string
	clientId: string
	taskId: string
	chatId: number
	threadId: number
	ownerId: number
	/** Messages from earlier connection epochs must never become commands after reconnecting. */
	activatedAt: number
	minimumUpdateId: number
	epoch: string
}

export interface TelegramAcceptedInput {
	clientId: string
	input: TelegramInput
	image?: TelegramImageFile
	callbackId?: string
}

interface Approval {
	routeKey: string
	epoch: string
	requestId: string
}

/** Independent of IDE state. The receiving host must revalidate the task and pending approval. */
export class TelegramRouter {
	private readonly routes = new Map<string, TelegramRoute>()
	private readonly approvals = new Map<string, Approval>()
	private lastUpdateId = -1

	private topicKey(chatId: number, threadId: number): string {
		return `${chatId}:${threadId}`
	}

	activate(route: Omit<TelegramRoute, "epoch">): TelegramRoute {
		const topicKey = this.topicKey(route.chatId, route.threadId)
		const existing = this.routes.get(topicKey)
		if (existing && existing.clientId !== route.clientId) throw new Error("Task is connected in another window")
		if (
			[...this.routes.values()].some((active) => active.key === route.key && active.clientId !== route.clientId)
		) {
			throw new Error("Task is connected in another window")
		}
		this.deactivate(route.clientId)
		const active = { ...route, epoch: randomBytes(12).toString("hex") }
		this.routes.set(topicKey, active)
		return active
	}

	deactivate(clientId: string, taskId?: string): void {
		for (const [topicKey, route] of this.routes) {
			if (route.clientId !== clientId || (taskId && route.taskId !== taskId)) continue
			this.routes.delete(topicKey)
			this.invalidateApprovals(route.key)
		}
	}

	invalidateApprovals(routeKey: string): void {
		for (const [id, approval] of this.approvals) {
			if (approval.routeKey === routeKey) this.approvals.delete(id)
		}
	}

	createApproval(route: TelegramRoute, requestId: string): string {
		if (this.routes.get(this.topicKey(route.chatId, route.threadId))?.epoch !== route.epoch) {
			throw new Error("Telegram route is no longer active")
		}
		this.invalidateApprovals(route.key)
		const id = randomBytes(16).toString("hex")
		this.approvals.set(id, { routeKey: route.key, epoch: route.epoch, requestId })
		return id
	}

	resetUpdateSequence(): void {
		this.routes.clear()
		this.approvals.clear()
		this.lastUpdateId = -1
	}

	accept(update: TelegramUpdate): TelegramAcceptedInput | undefined {
		if (!Number.isSafeInteger(update.update_id) || update.update_id <= this.lastUpdateId) return
		this.lastUpdateId = update.update_id
		const callback = update.callback_query
		const message = callback?.message ?? update.message
		if (!message || message.chat.type !== "private" || !message.message_thread_id) return
		const route = this.routes.get(this.topicKey(message.chat.id, message.message_thread_id))
		if (!route || update.update_id < route.minimumUpdateId) return
		const sender = callback?.from ?? message.from
		if (sender?.id !== route.ownerId || sender.is_bot) return
		const base = { taskId: route.taskId, epoch: route.epoch, updateId: update.update_id }
		if (callback) {
			const match = /^ivol:([a-f0-9]{32}):(yes|no)$/.exec(callback.data ?? "")
			if (!match) return
			const approval = this.approvals.get(match[1])
			if (!approval || approval.routeKey !== route.key || approval.epoch !== route.epoch) return
			// Consume before dispatch: duplicated clicks can never approve twice.
			this.approvals.delete(match[1])
			return {
				clientId: route.clientId,
				callbackId: callback.id,
				input: { ...base, kind: "approval", requestId: approval.requestId, approved: match[2] === "yes" },
			}
		}
		if (!Number.isFinite(message.date) || message.date * 1000 < route.activatedAt) return
		const image =
			(message.photo?.length
				? message.photo.reduce((largest, photo) =>
						photo.width * photo.height > largest.width * largest.height ? photo : largest,
					)
				: undefined) ??
			(["image/png", "image/jpeg"].includes(message.document?.mime_type ?? "") ? message.document : undefined)
		if (image)
			return {
				clientId: route.clientId,
				input: { ...base, kind: "message", text: message.caption ?? "" },
				image: { file_id: image.file_id, file_size: image.file_size },
			}
		if (!message.text?.trim()) return
		if (message.text.trim() === "/stop") return { clientId: route.clientId, input: { ...base, kind: "stop" } }
		return { clientId: route.clientId, input: { ...base, kind: "message", text: message.text } }
	}
}
