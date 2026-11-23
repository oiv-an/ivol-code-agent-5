import { TelegramApi } from "./TelegramApi"
import { splitTelegramEntities, telegramMarkdown } from "./markdown"

type Keyboard = { text: string; callback_data: string }[][]
interface RenderedPart {
	id: number
	text: string
	keyboard: string
	entities: string
}

/** A renderer belongs to one activation epoch; it never edits another task's messages. */
export class TelegramMessageRenderer {
	private readonly messages = new Map<string, RenderedPart[]>()
	/** Keys already delivered audibly; a later final version only edits them. */
	private readonly notified = new Set<string>()

	constructor(
		private readonly api: TelegramApi,
		private readonly chatId: number,
		private readonly threadId: number,
		private readonly signal: AbortSignal,
	) {}

	async render(
		key: string,
		text: string,
		keyboard?: Keyboard | (() => Keyboard | undefined),
		markdown = false,
		notify = false,
	): Promise<void> {
		this.signal.throwIfAborted()
		const chunks = markdown ? telegramMarkdown(text || "…") : splitTelegramEntities(text || "…")
		let parts = this.messages.get(key) ?? []
		if (!this.messages.has(key) && this.messages.size >= 5000) {
			throw new Error("Telegram session message limit reached; reconnect from the plugin")
		}
		const audible = notify && !this.notified.has(key)
		if (audible) {
			this.notified.add(key)
			// Edits never play a sound. Replace the silently streamed version (or "Thinking…") with a new message.
			if (parts.length) {
				const removed = await Promise.all(
					parts.map((part) =>
						this.api.deleteMessage(this.chatId, part.id, this.signal).then(
							() => true,
							() => false,
						),
					),
				)
				// If Telegram refuses to delete, keep editing the existing message rather than duplicating it.
				if (removed.every(Boolean)) parts = []
			}
		}
		this.messages.set(key, parts)
		let sound = audible && !parts.length
		for (let index = 0; index < Math.max(chunks.length, parts.length); index++) {
			// Telegram does not allow empty message text. Mark obsolete tail chunks explicitly.
			const { text: value, entities } = chunks[index] ?? { text: "—", entities: [] }
			const serializedEntities = JSON.stringify(entities)
			const buttons =
				index === chunks.length - 1 ? (typeof keyboard === "function" ? keyboard() : keyboard) : undefined
			const serialized = JSON.stringify(buttons ?? [])
			const previous = parts[index]
			if (
				previous?.text === value &&
				previous.keyboard === serialized &&
				previous.entities === serializedEntities
			)
				continue
			this.signal.throwIfAborted()
			if (previous) {
				await this.api.editText(this.chatId, previous.id, value, this.signal, buttons, entities)
				parts[index] = { id: previous.id, text: value, keyboard: serialized, entities: serializedEntities }
			} else {
				const ids = await this.api.sendText(
					this.chatId,
					this.threadId,
					value,
					this.signal,
					buttons,
					entities,
					sound,
				)
				sound = false
				if (ids.length !== 1) throw new Error("Unexpected Telegram message result")
				parts.push({ id: ids[0], text: value, keyboard: serialized, entities: serializedEntities })
			}
		}
	}
}
