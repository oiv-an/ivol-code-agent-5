// kilocode_change - new file
import type { ClineMessage } from "@roo-code/types"

import type { ApiMessage } from "../../../task-persistence/apiMessages"
import { assignNumbersToChatMessages, ensureSequenceNumbers } from "../numbering"

/**
 * Reproduces the order the real conversation runs in, rather than feeding the numbering a tidy
 * pair of arrays. A chat row is written the moment it is shown; the API message that carries it is
 * appended afterwards. Numbers have to survive that skew, otherwise the chat shows no numbers at
 * all and "freeze #20" has nothing to refer to.
 */
describe("numbering across a realistic exchange", () => {
	it("numbers a chat row written before its API message exists", () => {
		// The user's message is shown at 1000 and only reaches the API history at 1200.
		const chatMessages: ClineMessage[] = [{ ts: 1000, type: "say", say: "user_feedback", text: "do the thing" }]
		const apiMessages: ApiMessage[] = [{ ts: 1200, role: "user", content: "do the thing" }]

		ensureSequenceNumbers(apiMessages)
		const result = assignNumbersToChatMessages(chatMessages, apiMessages)

		expect(result[0].seq).toBe(1)
	})

	it("numbers the whole exchange in order", () => {
		const chatMessages: ClineMessage[] = [
			{ ts: 1000, type: "say", say: "user_feedback", text: "first" },
			{ ts: 2000, type: "say", say: "text", text: "answer" },
			{ ts: 3000, type: "say", say: "user_feedback", text: "second" },
		]
		const apiMessages: ApiMessage[] = [
			{ ts: 1100, role: "user", content: "first" },
			{ ts: 2100, role: "assistant", content: "answer" },
			{ ts: 3100, role: "user", content: "second" },
		]

		ensureSequenceNumbers(apiMessages)
		const result = assignNumbersToChatMessages(chatMessages, apiMessages)

		expect(result.map((message) => message.seq)).toEqual([1, 2, 3])
	})

	it("keeps numbering the rows that already arrived when the last answer is still being written", () => {
		const chatMessages: ClineMessage[] = [
			{ ts: 1000, type: "say", say: "user_feedback", text: "first" },
			{ ts: 2000, type: "say", say: "text", text: "still typing", partial: true },
		]
		const apiMessages: ApiMessage[] = [{ ts: 1100, role: "user", content: "first" }]

		ensureSequenceNumbers(apiMessages)
		const result = assignNumbersToChatMessages(chatMessages, apiMessages)

		expect(result[0].seq).toBe(1)
	})

	it("does not renumber rows that were numbered on an earlier save", () => {
		const chatMessages: ClineMessage[] = [
			{ ts: 1000, type: "say", say: "user_feedback", text: "first", seq: 1 },
			{ ts: 3000, type: "say", say: "user_feedback", text: "second" },
		]
		const apiMessages: ApiMessage[] = [
			{ ts: 1100, role: "user", content: "first", seq: 1 },
			{ ts: 3100, role: "user", content: "second" },
		]

		ensureSequenceNumbers(apiMessages)
		const result = assignNumbersToChatMessages(chatMessages, apiMessages)

		expect(result.map((message) => message.seq)).toEqual([1, 2])
	})
})
