// kilocode_change - new file
import type { ClineMessage } from "@roo-code/types"
import type { ApiMessage } from "../../task-persistence/apiMessages"

function containsText(value: unknown, text: string): boolean {
	if (typeof value === "string") return value.includes(text)
	if (Array.isArray(value)) return value.some((item) => containsText(item, text))
	if (!value || typeof value !== "object") return false
	const block = value as Record<string, unknown>
	// Never match hidden reasoning, identifiers or arbitrary provider metadata.
	if (block.type === "text") return containsText(block.text, text)
	if (block.type === "tool_result") return containsText(block.content, text)
	if (block.type === "tool_use" && block.name === "attempt_completion") {
		return containsText((block.input as Record<string, unknown> | undefined)?.result, text)
	}
	return false
}

/** Resolve visible prose without assuming that UI and API persistence happen in timestamp order. */
export function findChatMessageTarget(
	row: ClineMessage,
	chat: ClineMessage[],
	history: ApiMessage[],
): ApiMessage | undefined {
	const text = row.text?.trim()
	if (!text || row.type !== "say" || row.partial) return undefined
	if (!["text", "user_feedback", "completion_result"].includes(row.say ?? "")) return undefined
	const rowIndex = chat.findIndex((message) => message.ts === row.ts)
	if (rowIndex < 0) return undefined
	// The initial task is stored as a text row, but it is user content.
	const role = row.say === "user_feedback" || (rowIndex === 0 && row.say === "text") ? "user" : "assistant"
	if (role === "user") {
		const nextFeedback = chat.slice(rowIndex + 1).find((message) => message.say === "user_feedback")
		return history.find(
			(message) =>
				message.role === "user" &&
				typeof message.ts === "number" &&
				message.ts >= row.ts &&
				(!nextFeedback || message.ts < nextFeedback.ts) &&
				containsText(message.content, text),
		)
	}
	const request =
		role === "assistant"
			? chat
					.slice(0, rowIndex + 1)
					.reverse()
					.find((message) => message.say === "api_req_started")
			: undefined
	const nextRequest =
		role === "assistant" ? chat.slice(rowIndex + 1).find((message) => message.say === "api_req_started") : undefined
	const candidates = history.filter(
		(message) =>
			message.role === role &&
			!message.isSummary &&
			typeof message.ts === "number" &&
			(!request || message.ts >= request.ts) &&
			(!nextRequest || message.ts < nextRequest.ts) &&
			containsText(message.content, text),
	)
	// An exact content/role match within the request is safe even when it precedes the UI row.
	if (candidates.length === 1) return candidates[0]
	return candidates.find((message) => message.ts === row.ts)
}
