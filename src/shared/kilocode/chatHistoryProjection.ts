import type { ChatHistoryPage, ClineMessage } from "@roo-code/types"

// These limits apply only to transport copies. Persisted transcripts and API context stay intact.
export const CHAT_PAGE_SIZE = 80
export const CHAT_TEXT_LIMIT = 4000
export const CHAT_MESSAGE_LIMIT = 32_000

export function projectChatMessage(message: ClineMessage): ClineMessage {
	// Bound the number of retained rows, not the data required by their native controls.
	return { ...message, uiTruncated: undefined, uiImageCount: undefined }
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
