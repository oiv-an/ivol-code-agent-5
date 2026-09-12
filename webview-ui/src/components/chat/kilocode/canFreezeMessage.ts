// kilocode_change - new file
import type { ClineMessage } from "@roo-code/types"

/**
 * The minimum number of words a message must carry to be worth freezing.
 *
 * Short acknowledgements ("ok", "done", "yes please") cost almost nothing to re-send, so offering
 * to freeze them only adds clutter to the chat.
 */
export const FREEZE_MIN_WORDS = 5

/**
 * The message kinds a user may freeze.
 *
 * Only prose belongs here: what the model wrote and what the user typed. Tool activity, command
 * output, API request rows and the rest of the machinery are rendered from structured data that the
 * model receives in its own form, so freezing them would not hold on to what the user sees.
 */
const FREEZABLE_SAY_TYPES = new Set(["text", "user_feedback", "completion_result"])

const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length

/**
 * Decides whether the freeze control belongs on a chat row.
 *
 * A message qualifies when it has finished streaming, carries a timestamp (the handle the extension
 * uses to toggle the mark), is one of the prose kinds above, and is long enough to be worth keeping.
 *
 * Deliberately does not require a sequence number: numbering is assigned when the conversation is
 * persisted, so requiring it here would hide the control on every freshly rendered message.
 */
export const canFreezeMessage = (message: ClineMessage): boolean => {
	if (message.partial) {
		return false
	}

	if (typeof message.ts !== "number") {
		return false
	}

	if (message.type !== "say" || !message.say || !FREEZABLE_SAY_TYPES.has(message.say)) {
		return false
	}

	const text = message.text

	if (!text) {
		return false
	}

	return countWords(text) >= FREEZE_MIN_WORDS
}

/**
 * Collects the number to show on each chat row.
 *
 * The numbers come from the extension, which takes them from the history the model is actually
 * sent. Counting rows here instead would produce a second, private numbering: the chat only offers
 * freezing on written answers of a certain length, while the model sees every message, so the
 * user's "#6" and the model's "#6" would be different messages. That mismatch is exactly what made
 * freezing appear to target the wrong message.
 *
 * A row without a number is simply not numbered yet - its API message is written at the end of the
 * turn - and the number appears as soon as the extension sends it.
 */
export const numberFreezableMessages = (messages: ClineMessage[]): Map<number, number> => {
	const numbers = new Map<number, number>()

	for (const message of messages) {
		if (!canFreezeMessage(message)) continue
		if (typeof message.seq !== "number") continue
		if (numbers.has(message.ts)) continue
		numbers.set(message.ts, message.seq)
	}

	return numbers
}
