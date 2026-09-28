import { setTimeout as delay } from "node:timers/promises"
import { TelegramStartupError } from "./startupFailure"
import { splitTelegramEntities, type TelegramEntity } from "./markdown"

export interface TelegramUser {
	id: number
	is_bot?: boolean
	username?: string
	has_topics_enabled?: boolean
}

export const TELEGRAM_IMAGE_MAX_BYTES = 10 * 1024 * 1024

export interface TelegramImageFile {
	file_id: string
	file_size?: number
}

export interface TelegramMessage {
	message_id: number
	message_thread_id?: number
	date: number
	from?: TelegramUser
	chat: { id: number; type: string }
	text?: string
	caption?: string
	photo?: (TelegramImageFile & { width: number; height: number })[]
	document?: TelegramImageFile & { mime_type?: string }
}

export interface TelegramUpdate {
	update_id: number
	message?: TelegramMessage
	callback_query?: {
		id: string
		from: TelegramUser
		message?: TelegramMessage
		data?: string
	}
}

interface TelegramEnvelope<T> {
	ok: boolean
	result?: T
	error_code?: number
	parameters?: { retry_after?: number }
}

/** Never include request URLs, response descriptions or underlying fetch errors: they may contain the token. */
export class TelegramApiError extends Error {
	constructor(
		readonly code: number,
		readonly retryAfter?: number,
	) {
		super(`Telegram request failed (${code})`)
		this.name = "TelegramApiError"
	}
}

export class TelegramApi {
	private outgoing: Promise<void> = Promise.resolve()
	private nextSendAt = 0

	constructor(
		private readonly token: string,
		private readonly fetcher: typeof fetch = fetch,
	) {
		if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid Telegram bot token")
	}

	private write<T>(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<T> {
		const operation = this.outgoing.then(async () => {
			signal?.throwIfAborted()
			await delay(Math.max(0, this.nextSendAt - Date.now()), undefined, { signal })
			try {
				return await this.call<T>(method, body, signal)
			} catch (error) {
				if (!(error instanceof TelegramApiError) || error.code !== 429) throw error
				await delay(Math.min(Math.max(error.retryAfter ?? 1, 1), 300) * 1000, undefined, { signal })
				return await this.call<T>(method, body, signal)
			} finally {
				this.nextSendAt = Date.now() + 1100
			}
		})
		this.outgoing = operation.then(
			() => undefined,
			() => undefined,
		) // Failure is delivered to the caller; keep the scheduler usable.
		return operation
	}

	async sendImage(chatId: number, threadId: number, data: string, signal?: AbortSignal): Promise<void> {
		const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(data)
		if (!match || data.length > 20_000_000) throw new Error("Unsupported Telegram image")
		const bytes = Buffer.from(match[2], "base64")
		const form = new FormData()
		form.set("chat_id", String(chatId))
		form.set("message_thread_id", String(threadId))
		form.set("document", new Blob([new Uint8Array(bytes)], { type: match[1] }), `image.${match[1].split("/")[1]}`)
		await this.write("sendDocument", form, signal)
	}

	/** Only called after routing authorizes the owner and active connection epoch. */
	async downloadImage(file: TelegramImageFile, signal: AbortSignal): Promise<string> {
		const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
		const checkSize = (size?: number) => {
			if (size !== undefined && (!Number.isSafeInteger(size) || size < 1 || size > TELEGRAM_IMAGE_MAX_BYTES))
				throw new TelegramApiError(413)
		}
		try {
			bounded.throwIfAborted()
			if (!/^[A-Za-z0-9_-]{1,512}$/.test(file.file_id)) throw new TelegramApiError(400)
			checkSize(file.file_size)
			const metadata = await this.call<{ file_path?: string; file_size?: number }>(
				"getFile",
				{ file_id: file.file_id },
				bounded,
			)
			checkSize(metadata.file_size)
			const filePath = metadata.file_path
			// No URLs, traversal, percent escapes, credentials or query strings from API data.
			if (
				!filePath ||
				filePath.length > 1024 ||
				!filePath
					.split("/")
					.every((part) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) && part !== "." && part !== "..")
			)
				throw new TelegramApiError(400)
			const response = await this.fetcher(`https://api.telegram.org/file/bot${this.token}/${filePath}`, {
				signal: bounded,
				redirect: "error",
			})
			if (!response.ok || !response.body) throw new TelegramApiError(502)
			const reader = response.body.getReader()
			try {
				const length = response.headers.get("content-length")
				if (length !== null) checkSize(Number(length))
				const chunks: Buffer[] = []
				let size = 0
				while (true) {
					bounded.throwIfAborted()
					const chunk = await reader.read()
					if (chunk.done) break
					size += chunk.value.byteLength
					checkSize(size)
					chunks.push(Buffer.from(chunk.value))
				}
				bounded.throwIfAborted()
				const bytes = Buffer.concat(chunks, size)
				const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
					? "image/png"
					: bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
						? "image/jpeg"
						: undefined
				if (!mime) throw new TelegramApiError(415)
				return `data:${mime};base64,${bytes.toString("base64")}`
			} finally {
				await reader.cancel().catch(() => undefined) // Best-effort cleanup, never expose transport errors.
				reader.releaseLock()
			}
		} catch (error) {
			if (error instanceof TelegramApiError) throw error
			throw new TelegramApiError(signal.aborted ? 499 : 503)
		}
	}

	async answerCallbackQuery(id: string, signal: AbortSignal): Promise<void> {
		// Do not sit behind the outbound transcript or retry an ambiguous acknowledgement.
		await this.call("answerCallbackQuery", { callback_query_id: id }, signal)
	}

	async call<T>(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<T> {
		const timeout = AbortSignal.timeout(method === "getUpdates" ? 40_000 : 20_000)
		try {
			const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
				method: "POST",
				redirect: "error",
				headers: body instanceof FormData ? undefined : { "Content-Type": "application/json" },
				body: body instanceof FormData ? body : JSON.stringify(body),
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			})
			const envelope = (await response.json()) as TelegramEnvelope<T>
			if (!response.ok || !envelope.ok) {
				throw new TelegramApiError(envelope.error_code ?? response.status, envelope.parameters?.retry_after)
			}
			return envelope.result as T
		} catch (error) {
			if (error instanceof TelegramApiError) throw error
			throw new TelegramApiError(signal?.aborted ? 499 : 503)
		}
	}

	async verify(signal?: AbortSignal): Promise<TelegramUser> {
		const user = await this.call<TelegramUser>("getMe", {}, signal)
		if (!user.is_bot || !user.has_topics_enabled) {
			throw new TelegramStartupError("topics-disabled")
		}
		const webhook = await this.call<{ url: string }>("getWebhookInfo", {}, signal)
		if (webhook.url) throw new TelegramStartupError("webhook-active")
		return user
	}

	updates(offset: number, signal: AbortSignal, timeout = 30): Promise<TelegramUpdate[]> {
		return this.call("getUpdates", { offset, timeout, allowed_updates: ["message", "callback_query"] }, signal)
	}

	async createTopic(chatId: number, name: string, signal?: AbortSignal): Promise<number> {
		const topic = await this.call<{ message_thread_id: number }>(
			"createForumTopic",
			{ chat_id: chatId, name: Array.from(name).slice(0, 128).join("") },
			signal,
		)
		return topic.message_thread_id
	}

	async pinMessage(chatId: number, messageId: number, signal?: AbortSignal): Promise<void> {
		await this.write(
			"pinChatMessage",
			{ chat_id: chatId, message_id: messageId, disable_notification: true },
			signal,
		)
	}

	async editText(
		chatId: number,
		messageId: number,
		text: string,
		signal?: AbortSignal,
		keyboard?: { text: string; callback_data: string }[][],
		entities?: TelegramEntity[],
	): Promise<void> {
		await this.write(
			"editMessageText",
			{
				chat_id: chatId,
				message_id: messageId,
				text,
				entities: entities ?? [],
				reply_markup: { inline_keyboard: keyboard ?? [] },
			},
			signal,
		)
	}

	/** Explicit entities only; callers cannot inject Telegram markup or parse_mode. */
	async sendText(
		chatId: number,
		threadId: number,
		text: string,
		signal?: AbortSignal,
		keyboard?: { text: string; callback_data: string }[][],
		entities?: TelegramEntity[],
	): Promise<number[]> {
		const ids: number[] = []
		const chunks = splitTelegramEntities(text, entities)
		for (let index = 0; index < chunks.length; index++) {
			const body: Record<string, unknown> = {
				chat_id: chatId,
				message_thread_id: threadId,
				text: chunks[index].text,
				...(entities ? { entities: chunks[index].entities } : {}),
			}
			if (keyboard && index === chunks.length - 1) body.reply_markup = { inline_keyboard: keyboard }
			// All topics share a chat-wide scheduler; retry only explicit rate limits, never ambiguous timeouts.
			ids.push((await this.write<TelegramMessage>("sendMessage", body, signal)).message_id)
		}
		return ids
	}
}

/** Bound by UTF-16 length too, without splitting surrogate pairs. */
export function splitTelegramText(text: string, limit = 4000): string[] {
	if (!Number.isInteger(limit) || limit < 2 || limit > 4096) throw new Error("Invalid Telegram chunk limit")
	const chunks: string[] = []
	let chunk = ""
	for (const character of text) {
		if (chunk.length + character.length > limit) {
			chunks.push(chunk)
			chunk = ""
		}
		chunk += character
	}
	if (chunk) chunks.push(chunk)
	return chunks
}
