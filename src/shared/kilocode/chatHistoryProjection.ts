import type { ChatHistoryPage, ClineMessage } from "@roo-code/types"

// These limits apply only to transport copies. Persisted transcripts and API context stay intact.
export const CHAT_PAGE_SIZE = 40
export const CHAT_TEXT_LIMIT = 4000
export const CHAT_MESSAGE_LIMIT = 32_000

export function projectChatMessage(message: ClineMessage): ClineMessage {
	let truncated = false
	const clip = (value: string) => {
		if (value.length <= CHAT_TEXT_LIMIT) return value
		truncated = true
		return value.slice(0, CHAT_TEXT_LIMIT) + "\n…"
	}
	let budget = CHAT_MESSAGE_LIMIT
	const slim = (value: unknown, depth = 0): unknown => {
		if (depth > 12 || budget <= 0) {
			truncated = true
			return undefined
		}
		if (typeof value === "string") {
			const result = clip(value).slice(0, Math.max(0, budget))
			budget -= result.length
			if (result.length < value.length) truncated = true
			return result
		}
		if (Array.isArray(value)) {
			if (value.length > 40) truncated = true
			return value.slice(0, 40).map((entry) => slim(entry, depth + 1))
		}
		if (value && typeof value === "object") {
			const entries = Object.entries(value)
			if (entries.length > 40) truncated = true
			return Object.fromEntries(entries.slice(0, 40).map(([key, entry]) => [key, slim(entry, depth + 1)]))
		}
		return value
	}
	let text = message.text
	if (text && text.length > CHAT_TEXT_LIMIT) {
		try {
			text = JSON.stringify(slim(JSON.parse(text)))
		} catch {
			// Plain text (including incomplete streamed JSON) is an expected input.
			text = clip(text)
		}
	}
	// Extremely wide JSON must not defeat the per-message bound. Render it as a
	// read-only preview rather than passing damaged structured data to tool controls.
	const oversized = (text?.length ?? 0) > CHAT_MESSAGE_LIMIT
	if (oversized) {
		// Keep valid JSON for approval state readers, even for pathological tool payloads.
		try {
			const parsed = JSON.parse(message.text ?? "")
			text = JSON.stringify({
				tool: typeof parsed.tool === "string" ? parsed.tool.slice(0, 100) : undefined,
				content: clip(message.text ?? ""),
			})
		} catch {
			text = clip(message.text ?? "")
		}
		truncated = true
	}
	const result: ClineMessage = {
		ts: message.ts,
		type: message.type,
		ask: message.ask,
		say: message.say,
		text,
		partial: message.partial,
		isAnswered: message.isAnswered,
		isProtected: message.isProtected,
		apiProtocol: message.apiProtocol,
		conversationHistoryIndex: message.conversationHistoryIndex,
		pinned: message.pinned,
		pinnedBy: message.pinnedBy,
		pinnedAt: message.pinnedAt,
		pinRestored: message.pinRestored,
		pinnedNote: message.pinnedNote ? clip(message.pinnedNote) : undefined,
		progressStatus: message.progressStatus
			? {
					icon: message.progressStatus.icon?.slice(0, 100),
					text: message.progressStatus.text ? clip(message.progressStatus.text) : undefined,
				}
			: undefined,
		contextTruncation: message.contextTruncation,
		contextCondense: message.contextCondense
			? { ...message.contextCondense, summary: clip(message.contextCondense.summary) }
			: undefined,
		reasoning: message.reasoning ? clip(message.reasoning) : undefined,
		uiImageCount: message.images?.length || undefined,
	}
	const range = message.metadata?.kiloCode?.commitRange
	if (range) {
		result.metadata = {
			kiloCode: {
				commitRange: {
					from: range.from.slice(0, 200),
					to: range.to.slice(0, 200),
					fromTimeStamp: range.fromTimeStamp,
				},
			},
		}
	}
	// Checkpoint metadata is small in ordinary histories; never retain an oversized copy.
	if (message.checkpoint) {
		const checkpoint = JSON.stringify(message.checkpoint)
		if (checkpoint.length <= CHAT_TEXT_LIMIT) result.checkpoint = message.checkpoint
		else truncated = true
	}
	if (oversized && message.type === "say") result.say = "text"
	result.uiTruncated = truncated || Boolean(message.images?.length) || undefined
	return result
}

export function projectLiveChat(messages: ClineMessage[]): ClineMessage[] {
	if (!messages.length) return []
	const start = Math.max(1, messages.length - CHAT_PAGE_SIZE)
	return [projectChatMessage(messages[0]), ...messages.slice(start).map(projectChatMessage)]
}

export function projectHistoryPage(
	taskId: string,
	messages: ClineMessage[],
	request: { before?: number; after?: number; pinnedOnly?: boolean } = {},
): ChatHistoryPage {
	const rows = messages.slice(1).filter((message) => !request.pinnedOnly || message.pinned)
	let end = rows.length
	let start = Math.max(0, end - CHAT_PAGE_SIZE)
	if (request.before !== undefined) {
		const boundary = rows.findIndex((message) => message.ts >= request.before!)
		end = boundary === -1 ? rows.length : boundary
		start = Math.max(0, end - CHAT_PAGE_SIZE)
	} else if (request.after !== undefined) {
		const boundary = rows.findIndex((message) => message.ts > request.after!)
		start = boundary === -1 ? rows.length : boundary
		end = Math.min(rows.length, start + CHAT_PAGE_SIZE)
	}
	const page = rows.slice(start, end)
	return {
		taskId,
		messages: page.map(projectChatMessage),
		start,
		end,
		total: rows.length,
		before: start > 0 ? page[0]?.ts : undefined,
		after: end < rows.length ? page.at(-1)?.ts : undefined,
		pinnedOnly: request.pinnedOnly,
	}
}
