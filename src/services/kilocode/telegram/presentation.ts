import type { ClineMessage } from "@roo-code/types"

export const buttonAsks = new Set([
	"tool",
	"command",
	"use_mcp_server",
	"browser_action_launch",
	"command_output",
	"api_req_failed",
	"mistake_limit_reached",
	"resume_task",
	"report_bug",
	"condense",
	"auto_approval_max_req_reached",
])

/** Explicit allowlist: never turn arbitrary event payloads into Telegram text. */
export function telegramPresentation(message: ClineMessage): {
	kind: "text" | "approval" | "activity" | "ignore"
	text?: string
	images?: string[]
} {
	if (message.type === "ask") {
		if (buttonAsks.has(message.ask ?? "")) return { kind: "approval" }
		if (message.ask === "followup") {
			const raw = message.text?.trim() ?? ""
			if (!raw) return { kind: "ignore" }
			if (raw.startsWith("{")) {
				try {
					const value = JSON.parse(raw) as { question?: unknown }
					return typeof value.question === "string" && value.question.trim()
						? { kind: "text", text: value.question.trim() }
						: { kind: "ignore" }
				} catch {
					return { kind: "ignore" } // Incomplete structured streaming question.
				}
			}
			return { kind: "text", text: raw }
		}
		if (message.ask === "completion_result") {
			const raw = message.text?.trim() ?? ""
			if (!raw || isCompletionSuggestions(raw, message.partial === true)) return { kind: "ignore" }
			return { kind: "text", text: raw }
		}
		return { kind: "ignore" }
	}
	if (["user_feedback", "user_feedback_diff", "user_edit_todos"].includes(message.say ?? ""))
		return { kind: "ignore" }
	if (["text", "completion_result", "subtask_result"].includes(message.say ?? "")) {
		return { kind: "text", text: message.text?.trim(), images: message.images }
	}
	// Only explicit inline assistant attachments; image-row JSON and browser screenshots stay private.
	if (message.say === "image") return { kind: "text", images: message.images }
	return { kind: "activity" }
}

/** AttemptCompletionTool sends {suggest:[{answer,mode}]} in the ask, separately from the say result. */
function isCompletionSuggestions(raw: string, partial: boolean): boolean {
	try {
		const value = JSON.parse(raw)
		return (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.keys(value).length === 1 &&
			Array.isArray(value.suggest) &&
			value.suggest.every((item: unknown) => {
				if (!item || typeof item !== "object" || Array.isArray(item)) return false
				const suggestion = item as Record<string, unknown>
				return (
					typeof suggestion.answer === "string" &&
					(suggestion.mode === undefined || typeof suggestion.mode === "string") &&
					Object.keys(suggestion).every((key) => key === "answer" || key === "mode")
				)
			})
		)
	} catch {
		// Hold only a streaming prefix of the known metadata envelope, not JSON in assistant says/code fences.
		return partial && (/^\{\s*"suggest"\s*:/.test(raw) || '{"suggest":'.startsWith(raw.replace(/\s/g, "")))
	}
}

function shorten(text: string, limit: number): string {
	const chars = Array.from(text)
	return chars.length <= limit
		? text
		: chars
				.slice(0, limit - 1)
				.join("")
				.trimEnd() + "…"
}

export function telegramTopicTitle(firstMessage: string | undefined, fallback: string): string {
	const text = (firstMessage ?? "")
		.replace(/<environment_details>[\s\S]*$/i, "")
		.replace(/<\/?task>/gi, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^(?:(?:так|ну|давай|пожалуйста|okay|ok|please)[,!:;.\s]+)+/i, "")
		.replace(/^(?:проверяй|посмотри|смотри)[,!:;.\s]+/i, "")
		.trim()
	return shorten(text || fallback, 56)
}
