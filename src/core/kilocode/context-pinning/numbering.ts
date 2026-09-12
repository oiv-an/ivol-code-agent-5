// kilocode_change - new file
/**
 * Stable message numbers.
 *
 * Freezing a message has to be addressable: the user says "unfreeze #20" and the model answers
 * "freezing #42". A position in the array cannot serve as that address, because condensing,
 * truncation and rewinds all shift positions around. So every message carries its own number,
 * assigned once when it enters the history and never recomputed.
 *
 * Gaps are expected. Once messages are condensed away the remaining numbers read 41, 42, 47 - and
 * that gap is useful in itself: it shows the model that something was folded up in between.
 */

import type Anthropic from "@anthropic-ai/sdk"

import type { ClineMessage } from "@roo-code/types"

import type { ApiMessage } from "../../task-persistence/apiMessages"

/** Marker that carries the number to the model. Kept short: it costs tokens on every message. */
export const MESSAGE_NUMBER_PREFIX_PATTERN = /^\[#\d+\]\n/

/**
 * Assigns a number to every message that does not have one yet, continuing from the highest number
 * already in use.
 *
 * This single function covers all three cases:
 * - a new message appended to the history,
 * - a task reopened after a restart (numbering continues instead of colliding),
 * - an old task saved before numbering existed (every message is numbered once, in order).
 *
 * Existing numbers are never touched, which is what makes them safe to quote.
 *
 * @returns true when at least one number was assigned, so the caller knows the history changed.
 */
export function ensureSequenceNumbers(messages: ApiMessage[]): boolean {
	let highest = 0

	for (const message of messages) {
		if (typeof message.seq === "number" && message.seq > highest) {
			highest = message.seq
		}
	}

	let assigned = false

	for (const message of messages) {
		if (typeof message.seq === "number") continue
		highest += 1
		message.seq = highest
		assigned = true
	}

	return assigned
}

/** The number to show or send for a message, or undefined when it has none yet. */
export function getMessageNumber(message: ApiMessage): number | undefined {
	return typeof message.seq === "number" ? message.seq : undefined
}

/**
 * Numbers the messages by their position in the history, counting from one.
 *
 * Stored numbers are preferred wherever they exist, but a conversation started before numbering
 * existed has none at all, and writing them into an old history after the fact would renumber
 * messages the user may already have quoted. Counting positions instead gives every message a
 * number straight away, and it is the same count the chat performs, so both sides agree.
 *
 * Hidden messages are counted too: condensing and truncation are reversible, and a number that
 * shifted whenever something was folded away could not be quoted.
 */
export function numberByPosition(messages: ApiMessage[]): Map<ApiMessage, number> {
	const numbers = new Map<ApiMessage, number>()

	messages.forEach((message, index) => {
		numbers.set(message, typeof message.seq === "number" ? message.seq : index + 1)
	})

	return numbers
}

/**
 * Finds the message a quoted number refers to, whether or not the history carries stored numbers.
 *
 * A stored number wins when one exists; otherwise the number is read as a position. Returns
 * undefined when nothing matches, so the caller can tell the model rather than fail silently.
 */
export function findMessageByNumber(messages: ApiMessage[], number: number): ApiMessage | undefined {
	const stored = messages.find((message) => message.seq === number)
	if (stored) return stored

	// Positions are one-based: "#1" is the opening message.
	return number >= 1 && number <= messages.length ? messages[number - 1] : undefined
}

/**
 * Prepends `[#N]` to the text the model receives.
 *
 * Applied while building the outgoing request only - the stored history keeps clean text, so the
 * prefix never ends up duplicated or persisted.
 */
export function withNumberPrefix(text: string, seq: number | undefined): string {
	if (typeof seq !== "number") return text
	return `[#${seq}]\n${text}`
}

/**
 * Returns the outgoing content with the number applied to its first text block.
 *
 * Only an existing text block is rewritten - no block is added, reordered or removed. Providers are
 * strict about block order (a thinking block has to come first for Anthropic, tool_result blocks
 * have to lead a user turn), and a number is never worth breaking a request over. A message made
 * up entirely of tool blocks therefore travels without a visible number; it can still be frozen
 * from the chat, and its tool partner carries the number nearby.
 */
export function applyNumberPrefixToContent(
	content: string | Anthropic.Messages.ContentBlockParam[],
	seq: number | undefined,
): string | Anthropic.Messages.ContentBlockParam[] {
	if (typeof seq !== "number") return content

	if (typeof content === "string") {
		return withNumberPrefix(content, seq)
	}

	if (!Array.isArray(content)) return content

	const target = content.findIndex((block) => block.type === "text")
	if (target === -1) return content

	const block = content[target] as Anthropic.Messages.TextBlockParam
	if (typeof block.text !== "string" || MESSAGE_NUMBER_PREFIX_PATTERN.test(block.text)) {
		return content
	}

	const next = [...content]
	next[target] = { ...block, text: withNumberPrefix(block.text, seq) }
	return next
}

/** Finds a message by the number the user or the model quoted. */
export function findMessageBySeq(messages: ApiMessage[], seq: number): ApiMessage | undefined {
	return messages.find((message) => message.seq === seq)
}

/**
 * Copies the numbers onto the chat messages so the user sees the very same number as the model.
 *
 * The two histories are separate arrays and their timestamps do not match exactly: a chat row is
 * created first and the API message that carries it is appended a moment later. So each chat row
 * claims the earliest unclaimed API message at or after its own timestamp - the same rule the
 * rewind code already uses to line the two histories up.
 *
 * One API message often covers several chat rows (a tool call and its result, say). Only the first
 * row gets the number, so a number is never shown twice and the freeze button has one home.
 */
export function assignNumbersToChatMessages(clineMessages: ClineMessage[], apiMessages: ApiMessage[]): ClineMessage[] {
	const numbered = apiMessages
		.filter((message) => typeof message.seq === "number" && typeof message.ts === "number")
		.sort((a, b) => (a.ts as number) - (b.ts as number))

	if (numbered.length === 0) return clineMessages

	let cursor = 0
	let changed = false

	const result = clineMessages.map((chatMessage) => {
		if (typeof chatMessage.ts !== "number") return chatMessage

		while (cursor < numbered.length && (numbered[cursor].ts as number) < chatMessage.ts) {
			cursor += 1
		}
		if (cursor >= numbered.length) return chatMessage

		const seq = numbered[cursor].seq as number
		cursor += 1

		if (chatMessage.seq === seq) return chatMessage
		changed = true
		return { ...chatMessage, seq }
	})

	return changed ? result : clineMessages
}

/**
 * Resolves quoted numbers to timestamps, which is what the freeze operations address.
 * Numbers that match nothing are reported separately instead of being silently dropped.
 */
export function resolveSeqNumbers(
	messages: ApiMessage[],
	seqNumbers: number[],
): { found: Array<{ seq: number; ts: number }>; missing: number[] } {
	const found: Array<{ seq: number; ts: number }> = []
	const missing: number[] = []

	for (const seq of seqNumbers) {
		// kilocode_change: falls back to the position, so quoting a number works on conversations
		// that were started before numbering existed and therefore carry no stored numbers.
		const message = findMessageByNumber(messages, seq)
		if (message && typeof message.ts === "number") {
			found.push({ seq, ts: message.ts })
		} else {
			missing.push(seq)
		}
	}

	return { found, missing }
}
