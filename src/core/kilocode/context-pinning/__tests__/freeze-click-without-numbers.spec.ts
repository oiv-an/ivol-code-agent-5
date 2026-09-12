// kilocode_change - new file
import type { ClineMessage } from "@roo-code/types"

import type { ApiMessage } from "../../../task-persistence/apiMessages"

/**
 * Resolving the clicked chat row to its API message.
 *
 * The two histories never share a timestamp - the row is written when it is shown, the API message
 * once the turn is complete - and a conversation started before numbering existed carries no
 * numbers at all. Matching on an exact timestamp therefore found nothing and the button did
 * nothing when clicked.
 *
 * Task pulls in the whole extension, so the rule is exercised on its own here. It mirrors
 * `Task.setMessagePinned`.
 */
const resolveApiTs = (chatMessages: ClineMessage[], apiMessages: ApiMessage[], messageTs: number): number => {
	const chatMessage = chatMessages.find((message) => message.ts === messageTs)

	const bySeq =
		typeof chatMessage?.seq === "number"
			? apiMessages.find((message) => message.seq === chatMessage.seq)
			: undefined

	const byExactTs = bySeq ? undefined : apiMessages.find((message) => message.ts === messageTs)

	const byNearestTs =
		bySeq || byExactTs
			? undefined
			: apiMessages
					.filter((message) => typeof message.ts === "number" && message.ts >= messageTs)
					.sort((a, b) => (a.ts as number) - (b.ts as number))[0]

	return bySeq?.ts ?? byExactTs?.ts ?? byNearestTs?.ts ?? messageTs
}

const row = (ts: number, seq?: number): ClineMessage =>
	({ ts, type: "say", say: "text", text: "written answer", ...(seq === undefined ? {} : { seq }) }) as ClineMessage

const apiMessage = (ts: number, seq?: number): ApiMessage => ({
	ts,
	role: "assistant",
	content: "written answer",
	...(seq === undefined ? {} : { seq }),
})

describe("resolving a clicked chat row to its API message", () => {
	it("finds the API message on a conversation that carries no numbers", () => {
		// This is the shape of every task started before numbering existed.
		const chat = [row(1000), row(2000)]
		const api = [apiMessage(1100), apiMessage(2100)]

		expect(resolveApiTs(chat, api, 1000)).toBe(1100)
		expect(resolveApiTs(chat, api, 2000)).toBe(2100)
	})

	it("prefers the shared number when both sides have one", () => {
		const chat = [row(1000, 7)]
		const api = [apiMessage(1100, 7), apiMessage(1200, 8)]

		expect(resolveApiTs(chat, api, 1000)).toBe(1100)
	})

	it("still matches an exact timestamp for callers addressing the API history directly", () => {
		const chat = [row(1000)]
		const api = [apiMessage(1000)]

		expect(resolveApiTs(chat, api, 1000)).toBe(1000)
	})

	it("claims the earliest API message at or after the row, never an earlier one", () => {
		const chat = [row(2000)]
		const api = [apiMessage(1000), apiMessage(2500), apiMessage(3000)]

		expect(resolveApiTs(chat, api, 2000)).toBe(2500)
	})

	it("falls back to the row's own timestamp when nothing follows it", () => {
		const chat = [row(5000)]
		const api = [apiMessage(1000)]

		expect(resolveApiTs(chat, api, 5000)).toBe(5000)
	})

	it("falls through to the timestamp when the row's number matches nothing", () => {
		// Numbering ran on the chat but the API history was written without numbers. Giving up here
		// would leave the button dead, so the search continues by timestamp.
		const chat = [row(1000, 99)]
		const api = [apiMessage(1100)]

		expect(resolveApiTs(chat, api, 1000)).toBe(1100)
	})
})
