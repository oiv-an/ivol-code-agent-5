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
	): Promise<void> {
		this.signal.throwIfAborted()
		const chunks = markdown ? telegramMarkdown(text || "…") : splitTelegramEntities(text || "…")
		const parts = this.messages.get(key) ?? []
		if (!this.messages.has(key) && this.messages.size >= 5000) {
			throw new Error("Telegram session message limit reached; reconnect from the plugin")
		}
		this.messages.set(key, parts)
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
				const ids = await this.api.sendText(this.chatId, this.threadId, value, this.signal, buttons, entities)
				if (ids.length !== 1) throw new Error("Unexpected Telegram message result")
				parts.push({ id: ids[0], text: value, keyboard: serialized, entities: serializedEntities })
			}
		}
	}
}
