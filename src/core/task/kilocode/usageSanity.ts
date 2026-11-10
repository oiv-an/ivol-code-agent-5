// kilocode_change - new file
import type { ClineMessage } from "@roo-code/types"

/**
 * Some OpenAI-compatible gateways (observed on Claude routes behind a key pool)
 * occasionally report `prompt_tokens` with the cache-read part counted on top of
 * the real prompt. The context counter (and the automatic condense trigger)
 * then jumps by ~100k+ tokens for one request and drops back on the next.
 *
 * Detect that shape relative to the previous request of the same task:
 *  - the request hit the cache (cacheRead > 0);
 *  - the prompt grew by much more than what was newly written to the cache
 *    (genuine growth is written to the cache behind the last breakpoint);
 *  - the unexplained growth is at least half of the cache read.
 * In that case the cached part is treated as already included in the prompt.
 */
export const INFLATED_USAGE_MIN_JUMP = 20_000

export function correctInflatedPromptTokens(params: {
	inputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	previousInputTokens?: number
}): number {
	const { inputTokens, cacheReadTokens, cacheWriteTokens, previousInputTokens } = params
	if (!previousInputTokens || previousInputTokens <= 0) return inputTokens
	if (cacheReadTokens <= 0 || inputTokens <= previousInputTokens) return inputTokens

	const jump = inputTokens - previousInputTokens
	if (jump < INFLATED_USAGE_MIN_JUMP) return inputTokens

	const unexplainedGrowth = jump - Math.max(0, cacheWriteTokens)
	if (unexplainedGrowth < cacheReadTokens * 0.5) return inputTokens

	return Math.max(previousInputTokens, inputTokens - cacheReadTokens)
}

/**
 * Prompt size of the request preceding `beforeIndex` (or the post-condense
 * context size when a condense happened in between).
 */
export function findPreviousPromptTokens(messages: ClineMessage[], beforeIndex: number): number | undefined {
	for (let i = Math.min(beforeIndex, messages.length) - 1; i >= 0; i--) {
		const message = messages[i]
		if (!message || message.type !== "say") continue
		if (message.say === "condense_context") {
			return message.contextCondense?.newContextTokens || undefined
		}
		if (message.say !== "api_req_started" || !message.text) continue
		try {
			const parsed = JSON.parse(message.text) as { tokensIn?: number; cancelReason?: string }
			if (typeof parsed.tokensIn === "number" && parsed.tokensIn > 0) return parsed.tokensIn
		} catch (error) {
			console.warn("[usageSanity] Unparseable api_req_started message", error)
		}
	}
	return undefined
}
