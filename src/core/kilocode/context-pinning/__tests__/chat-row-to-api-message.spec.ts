// kilocode_change - new file
/**
 * A chat row and its API message never share a timestamp: the row is written as soon as the user
 * sends something, the API message only once the turn is assembled. Freezing addresses the API
 * history, so the row has to be resolved through the shared number first.
 *
 * Getting this wrong is invisible in the UI - the button simply does nothing - so the mapping is
 * covered directly.
 */

import type { ClineMessage } from "@roo-code/types"

import type { ApiMessage } from "../../../task-persistence/apiMessages"
import { assignNumbersToChatMessages } from "../numbering"
import { pinMessages } from "../index"

/** The lookup performed by Task.setMessagePinned. */
function resolveApiTs(chatMessages: ClineMessage[], apiMessages: ApiMessage[], messageTs: number): number {
	const chatMessage = chatMessages.find((message) => message.ts === messageTs)
	if (typeof chatMessage?.seq !== "number") return messageTs
	return apiMessages.find((message) => message.seq === chatMessage.seq)?.ts ?? messageTs
}

describe("resolving a chat row to its API message", () => {
	// Timestamps as they actually occur: the row is a few hundred ms ahead of the API message.
	const apiMessages: ApiMessage[] = [
		{ role: "user", content: [{ type: "text", text: "first" }], ts: 1_400, seq: 1 },
		{ role: "assistant", content: [{ type: "text", text: "answer" }], ts: 2_400, seq: 2 },
	]

	const chatMessages: ClineMessage[] = [
		{ type: "say", say: "user_feedback", text: "first", ts: 1_000 },
		{ type: "say", say: "text", text: "answer", ts: 2_000 },
	]

	it("finds the API message even though the timestamps differ", () => {
		const numbered = assignNumbersToChatMessages(chatMessages, apiMessages)

		expect(numbered[0].seq).toBe(1)
		expect(resolveApiTs(numbered, apiMessages, 1_000)).toBe(1_400)
		expect(resolveApiTs(numbered, apiMessages, 2_000)).toBe(2_400)
	})

	it("freezes the message the user clicked on", () => {
		const numbered = assignNumbersToChatMessages(chatMessages, apiMessages)
		const apiTs = resolveApiTs(numbered, apiMessages, 2_000)

		const result = pinMessages(apiMessages, [{ ts: apiTs }], "user")

		expect(result.changes).toHaveLength(1)
		expect(result.skipped).toHaveLength(0)
		expect(result.messages[1].pinned).toBe(true)
		expect(result.messages[0].pinned).toBeUndefined()
	})

	it("reports nothing frozen when the raw chat timestamp is used", () => {
		// This is the bug the mapping exists for: the click was silently doing nothing.
		const result = pinMessages(apiMessages, [{ ts: 2_000 }], "user")

		expect(result.changes).toHaveLength(0)
		expect(result.skipped[0].reason).toBe("not-found")
	})

	it("falls back to the timestamp when the row carries no number", () => {
		const withoutSeq: ClineMessage[] = [{ type: "say", say: "text", text: "local row", ts: 5_000 }]

		expect(resolveApiTs(withoutSeq, apiMessages, 5_000)).toBe(5_000)
	})
})
