// kilocode_change - new file
/**
 * The model freezes a message by quoting its number, which resolves to a timestamp in the API
 * history. No chat row carries that timestamp - a row is written when the turn starts, the API
 * message only once it is complete.
 *
 * The reported bug lived exactly here: the mark was applied to the API history, the chat kept
 * showing nothing, and the tool still answered "Froze #6". The second attempt then said "Already
 * frozen" while the user could still see no mark at all.
 *
 * The lookup is reproduced here rather than driving `Task`, which needs the whole extension to
 * start. It mirrors `Task.resolveChatRowTs`.
 */

import type { ClineMessage } from "@roo-code/types"

import type { ApiMessage } from "../../../task-persistence/apiMessages"
import { pinMessages } from "../index"
import { findMessageByNumber } from "../numbering"

function resolveChatRowTs(chatMessages: ClineMessage[], messageTs: number, apiTs: number, seq?: number): number {
	if (chatMessages.some((message) => message.ts === messageTs)) return messageTs

	if (typeof seq === "number") {
		const bySeq = chatMessages.find((message) => message.seq === seq)
		if (bySeq) return bySeq.ts
	}

	const preceding = chatMessages
		.filter((message) => typeof message.ts === "number" && message.ts <= apiTs)
		.sort((a, b) => b.ts - a.ts)[0]

	return preceding?.ts ?? messageTs
}

/** Applies the mark to both histories, the way `setMessagePinned` does. */
function freezeByNumber(
	chatMessages: ClineMessage[],
	apiMessages: ApiMessage[],
	quoted: number,
): { chatMessages: ClineMessage[]; apiMessages: ApiMessage[]; frozen: boolean } {
	const target = findMessageByNumber(apiMessages, quoted)
	if (!target || typeof target.ts !== "number") return { chatMessages, apiMessages, frozen: false }

	const result = pinMessages(apiMessages, [{ ts: target.ts }], "model")
	const chatTs = resolveChatRowTs(chatMessages, target.ts, target.ts, target.seq)

	return {
		apiMessages: result.messages,
		chatMessages: chatMessages.map((message) =>
			message.ts === chatTs ? { ...message, pinned: true, pinnedBy: "model" as const } : message,
		),
		frozen: result.changes.length > 0,
	}
}

describe("a message frozen by the model", () => {
	// Timestamps as they really occur: every row is a few hundred ms ahead of its API message.
	const apiMessages: ApiMessage[] = [
		{ role: "user", content: [{ type: "text", text: "task" }], ts: 1_400 },
		{ role: "assistant", content: [{ type: "text", text: "plan" }], ts: 2_400 },
		{ role: "user", content: [{ type: "text", text: "go on" }], ts: 3_400 },
	]

	const chatMessages: ClineMessage[] = [
		{ type: "say", say: "user_feedback", text: "task", ts: 1_000 },
		{ type: "say", say: "text", text: "plan", ts: 2_000 },
		{ type: "say", say: "user_feedback", text: "go on", ts: 3_000 },
	]

	it("is marked in the chat, not only in the context sent to the model", () => {
		const result = freezeByNumber(chatMessages, apiMessages, 2)

		expect(result.frozen).toBe(true)
		expect(result.apiMessages[1].pinned).toBe(true)
		// This is what the user looks at, and what stayed empty before.
		expect(result.chatMessages[1].pinned).toBe(true)
		expect(result.chatMessages[1].pinnedBy).toBe("model")
	})

	it("marks the row the number refers to and no other", () => {
		const result = freezeByNumber(chatMessages, apiMessages, 3)

		expect(result.chatMessages.filter((message) => message.pinned)).toHaveLength(1)
		expect(result.chatMessages[2].pinned).toBe(true)
	})

	it("never reports a freeze the chat cannot show", () => {
		// The two states have to agree, otherwise a second attempt answers "Already frozen" while
		// the user still sees nothing.
		for (const quoted of [1, 2, 3]) {
			const result = freezeByNumber(chatMessages, apiMessages, quoted)

			const frozenInContext = result.apiMessages.filter((message) => message.pinned).length
			const frozenInChat = result.chatMessages.filter((message) => message.pinned).length

			expect(frozenInChat).toBe(frozenInContext)
		}
	})

	it("still finds the row when the histories carry stored numbers", () => {
		const numberedApi: ApiMessage[] = apiMessages.map((message, index) => ({ ...message, seq: index + 41 }))
		const numberedChat: ClineMessage[] = chatMessages.map((message, index) => ({ ...message, seq: index + 41 }))

		const result = freezeByNumber(numberedChat, numberedApi, 42)

		expect(result.chatMessages[1].pinned).toBe(true)
	})
})
