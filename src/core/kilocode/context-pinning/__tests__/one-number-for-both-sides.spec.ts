// kilocode_change - new file
/**
 * The user and the model have to mean the same message by "#6".
 *
 * The chat used to number the rows it draws, and it only draws written answers past a few words.
 * The model is sent every message, including the tool calls and results the chat renders
 * differently. Two counts over two different sets: the sixth row on screen was not the sixth
 * message in the model's history, so freezing "#6" marked a message the user was not looking at
 * while the tool reported success.
 *
 * Both sides now take the number from the API history, which is what the model is actually sent.
 */

import type { ClineMessage } from "@roo-code/types"

import type { ApiMessage } from "../../../task-persistence/apiMessages"
import { assignNumbersToChatMessages, numberByPosition } from "../numbering"

/** The number the model reads in front of a message, as applied when the request is built. */
function numberSentToModel(apiMessages: ApiMessage[], target: ApiMessage): number | undefined {
	return numberByPosition(apiMessages).get(target)
}

/** Mirrors the chat: only written answers of a certain length carry a freeze control. */
const FREEZABLE = new Set(["text", "user_feedback", "completion_result"])
function isFreezable(message: ClineMessage): boolean {
	return (
		message.type === "say" &&
		Boolean(message.say && FREEZABLE.has(message.say)) &&
		(message.text?.trim().split(/\s+/).length ?? 0) >= 5
	)
}

describe("the number the user quotes and the number the model reads", () => {
	// A realistic turn: the user asks, the model answers, calls a tool, reads the result, answers
	// again. The chat shows a freeze control on the written answers only.
	const apiMessages: ApiMessage[] = [
		{ role: "user", content: [{ type: "text", text: "please look at the failing test" }], ts: 1_400 },
		{ role: "assistant", content: [{ type: "text", text: "I will read the file first" }], ts: 2_400 },
		{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }], ts: 3_400 },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }], ts: 4_400 },
		{ role: "assistant", content: [{ type: "text", text: "the assertion compares the wrong field" }], ts: 5_400 },
	]

	const chatMessages: ClineMessage[] = [
		{ type: "say", say: "user_feedback", text: "please look at the failing test", ts: 1_000 },
		{ type: "say", say: "text", text: "I will read the file first", ts: 2_000 },
		{ type: "say", say: "api_req_started", text: "{}", ts: 3_000 },
		{ type: "say", say: "command_output", text: "file body", ts: 4_000 },
		{ type: "say", say: "text", text: "the assertion compares the wrong field", ts: 5_000 },
	]

	it("agree on the last answer, which the old counting got wrong", () => {
		const numbered: ClineMessage[] = assignNumbersToChatMessages(chatMessages, apiMessages)

		const lastRow = numbered[4]
		const lastApiMessage = apiMessages[4]

		expect(lastRow.seq).toBe(numberSentToModel(apiMessages, lastApiMessage))
		// Counting only the freezable rows would have called this one #3.
		expect(lastRow.seq).toBe(5)
	})

	it("agree on every row the user can freeze", () => {
		const numbered: ClineMessage[] = assignNumbersToChatMessages(chatMessages, apiMessages)

		for (const [index, row] of numbered.entries()) {
			if (!isFreezable(row)) continue

			expect(row.seq).toBe(numberSentToModel(apiMessages, apiMessages[index]))
		}
	})

	it("agree on a conversation that carries no stored numbers", () => {
		// Tasks started before numbering existed: both sides fall back to the position, and they
		// have to fall back the same way.
		const numbered: ClineMessage[] = assignNumbersToChatMessages(chatMessages, apiMessages)

		expect(numbered.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5])
	})

	it("prefers the stored number over the position on both sides", () => {
		const stored: ApiMessage[] = apiMessages.map((message, index) => ({ ...message, seq: index + 41 }))
		const numbered: ClineMessage[] = assignNumbersToChatMessages(chatMessages, stored)

		expect(numbered.map((row) => row.seq)).toEqual([41, 42, 43, 44, 45])
		expect(numberSentToModel(stored, stored[1])).toBe(42)
	})
})
