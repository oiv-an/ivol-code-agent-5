import type { ProviderSettings } from "@roo-code/types"
import { applyAgentModelChoice } from "../../../core/config/kilocode/taskModelSelection"
import { singleCompletionHandler } from "../../../utils/single-completion-handler"
import { telegramTopicTitle } from "./presentation"

export const TELEGRAM_TASK_TITLE_LIMIT = 20

/** Prefer the profile's MIN preset model; otherwise use the task's current model. */
export function titleModelSettings(settings: ProviderSettings): ProviderSettings {
	const min = settings.modelPresets?.min
	return min?.modelId ? applyAgentModelChoice(settings, min.modelId, min.reasoningEffort) : settings
}

export function cleanTaskTitle(raw: string): string {
	const line =
		raw
			.replace(/<think>[\s\S]*?<\/think>/gi, "")
			.split("\n")
			.map((part) => part.trim())
			.find(Boolean) ?? ""
	const text = line
		.replace(/^(?:title|название)\s*[:：-]\s*/i, "")
		.replace(/^["'«“`*]+|["'»”`*.]+$/g, "")
		.trim()
	return Array.from(text).slice(0, TELEGRAM_TASK_TITLE_LIMIT).join("").trim()
}

/** "<project> / <short task name>"; the AI name falls back to the truncated request text. */
export async function generateTelegramTopicName(
	project: string,
	taskText: string,
	settings: ProviderSettings | undefined,
	fallback: string,
	complete: (settings: ProviderSettings, prompt: string) => Promise<string> = singleCompletionHandler,
	timeoutMs = 15_000,
): Promise<string> {
	const request = telegramTopicTitle(taskText, "")
	let short = ""
	if (request && settings?.apiProvider) {
		const prompt =
			`Write a very short title for this task, at most ${TELEGRAM_TASK_TITLE_LIMIT} characters, ` +
			"in the same language as the task. Reply with the title only, no quotes or punctuation at the end.\n\n" +
			`Task:\n${Array.from(request).slice(0, 2000).join("")}`
		let timer: NodeJS.Timeout | undefined
		try {
			const result = await Promise.race([
				complete(titleModelSettings(settings), prompt),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error("Title generation timed out")), timeoutMs)
				}),
			])
			short = cleanTaskTitle(result)
		} catch (error) {
			console.warn("[Telegram] Topic title generation failed:", error instanceof Error ? error.message : error)
		} finally {
			if (timer) clearTimeout(timer)
		}
	}
	if (!short) short = cleanTaskTitle(request || fallback) || fallback
	return Array.from(`${project} / ${short}`).slice(0, 128).join("")
}
