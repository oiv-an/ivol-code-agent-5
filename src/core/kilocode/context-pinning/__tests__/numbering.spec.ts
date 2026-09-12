// kilocode_change - new file
import type { ClineMessage } from "@roo-code/types"

import {
	applyNumberPrefixToContent,
	assignNumbersToChatMessages,
	ensureSequenceNumbers,
	findMessageBySeq,
	getMessageNumber,
	resolveSeqNumbers,
	withNumberPrefix,
} from "../numbering"
import type { ApiMessage } from "../../../task-persistence/apiMessages"

const chatMessage = (ts: number, extra: Partial<ClineMessage> = {}): ClineMessage =>
	({ ts, type: "say", say: "text", text: `chat ${ts}`, ...extra }) as ClineMessage

const message = (ts: number, extra: Partial<ApiMessage> = {}): ApiMessage => ({
	role: ts % 2 === 0 ? "assistant" : "user",
	content: [{ type: "text", text: `message ${ts}` }],
	ts,
	...extra,
})

describe("message numbering", () => {
	describe("ensureSequenceNumbers", () => {
		it("numbers a fresh history from one", () => {
			const messages = [message(10), message(20), message(30)]

			expect(ensureSequenceNumbers(messages)).toBe(true)
			expect(messages.map((item) => item.seq)).toEqual([1, 2, 3])
		})

		it("continues from the highest number in use", () => {
			const messages = [message(10, { seq: 1 }), message(20, { seq: 2 }), message(30)]

			ensureSequenceNumbers(messages)

			expect(messages[2].seq).toBe(3)
		})

		it("never renumbers a message that already has a number", () => {
			const messages = [message(10, { seq: 7 }), message(20, { seq: 9 }), message(30)]

			ensureSequenceNumbers(messages)

			// The existing numbers are quoted by the user and the model, so they must not move.
			expect(messages.map((item) => item.seq)).toEqual([7, 9, 10])
		})

		it("keeps numbers stable when older messages are condensed away", () => {
			const messages = [message(10), message(20), message(30), message(40)]
			ensureSequenceNumbers(messages)

			// Condensing hides the first two; the summary takes their place in the array.
			const afterCondense = [
				{ ...message(15), isSummary: true, condenseId: "summary-1" },
				{ ...messages[2] },
				{ ...messages[3] },
			]
			ensureSequenceNumbers(afterCondense)

			// #3 is still #3 even though it is now the second element.
			expect(afterCondense[1].seq).toBe(3)
			expect(afterCondense[2].seq).toBe(4)
		})

		it("produces gaps rather than reusing numbers", () => {
			const messages = [message(10, { seq: 1 }), message(20, { seq: 5 })]
			ensureSequenceNumbers(messages)

			messages.push(message(30))
			ensureSequenceNumbers(messages)

			// Gaps are fine - they show the model that something was folded up in between.
			expect(messages.map((item) => item.seq)).toEqual([1, 5, 6])
		})

		it("survives a restart: numbering resumes from the saved history", () => {
			const saved = [message(10, { seq: 1 }), message(20, { seq: 2 })]

			// A reopened task appends to the very same history.
			const reopened = [...saved, message(30)]
			ensureSequenceNumbers(reopened)

			expect(reopened[2].seq).toBe(3)
		})

		it("reports that nothing changed when every message is numbered", () => {
			const messages = [message(10, { seq: 1 }), message(20, { seq: 2 })]

			expect(ensureSequenceNumbers(messages)).toBe(false)
		})
	})

	describe("prefix", () => {
		it("prepends the number", () => {
			expect(withNumberPrefix("hello", 42)).toBe("[#42]\nhello")
		})

		it("leaves text untouched without a number", () => {
			expect(withNumberPrefix("hello", undefined)).toBe("hello")
		})
	})

	describe("applyNumberPrefixToContent", () => {
		it("numbers plain string content", () => {
			expect(applyNumberPrefixToContent("hello", 7)).toBe("[#7]\nhello")
		})

		it("numbers the first text block only", () => {
			const content = [
				{ type: "text" as const, text: "first" },
				{ type: "text" as const, text: "second" },
			]

			const result = applyNumberPrefixToContent(content, 7) as typeof content

			expect(result[0].text).toBe("[#7]\nfirst")
			expect(result[1].text).toBe("second")
		})

		it("does not reorder or add blocks", () => {
			const content = [
				{ type: "tool_result" as const, tool_use_id: "tool-1", content: "output" },
				{ type: "text" as const, text: "after the tool result" },
			]

			const result = applyNumberPrefixToContent(content, 7) as typeof content

			// Providers reject a user turn whose tool_result blocks do not come first.
			expect(result).toHaveLength(2)
			expect(result[0].type).toBe("tool_result")
			expect((result[1] as { text: string }).text).toBe("[#7]\nafter the tool result")
		})

		it("leaves a message without text blocks alone", () => {
			const content = [{ type: "tool_use" as const, id: "tool-1", name: "read_file", input: {} }]

			expect(applyNumberPrefixToContent(content, 7)).toEqual(content)
		})

		it("never numbers the same message twice", () => {
			const once = applyNumberPrefixToContent([{ type: "text" as const, text: "hello" }], 7)
			const twice = applyNumberPrefixToContent(once, 7) as Array<{ text: string }>

			expect(twice[0].text).toBe("[#7]\nhello")
		})

		it("does not mutate the stored content", () => {
			const content = [{ type: "text" as const, text: "hello" }]

			applyNumberPrefixToContent(content, 7)

			// The history on disk has to stay clean.
			expect(content[0].text).toBe("hello")
		})

		it("leaves content untouched without a number", () => {
			const content = [{ type: "text" as const, text: "hello" }]

			expect(applyNumberPrefixToContent(content, undefined)).toBe(content)
		})
	})

	describe("lookup", () => {
		it("finds a message by its number", () => {
			const messages = [message(10, { seq: 1 }), message(20, { seq: 2 })]

			expect(findMessageBySeq(messages, 2)?.ts).toBe(20)
			expect(findMessageBySeq(messages, 99)).toBeUndefined()
		})

		it("resolves numbers to timestamps and reports the ones it could not match", () => {
			const messages = [message(10, { seq: 1 }), message(20, { seq: 2 })]

			const { found, missing } = resolveSeqNumbers(messages, [1, 2, 77])

			expect(found).toEqual([
				{ seq: 1, ts: 10 },
				{ seq: 2, ts: 20 },
			])
			// A number nobody can resolve is reported, not silently ignored.
			expect(missing).toEqual([77])
		})

		it("exposes the number of a message", () => {
			expect(getMessageNumber(message(10, { seq: 4 }))).toBe(4)
			expect(getMessageNumber(message(10))).toBeUndefined()
		})
	})

	describe("assignNumbersToChatMessages", () => {
		it("gives the chat row the number the model sees", () => {
			// The chat row is created a moment before the API message that carries it.
			const chat = [chatMessage(100), chatMessage(200)]
			const api = [message(105, { seq: 1 }), message(205, { seq: 2 })]

			const result = assignNumbersToChatMessages(chat, api)

			expect(result.map((item) => item.seq)).toEqual([1, 2])
		})

		it("numbers only the first chat row of an API message", () => {
			// A tool call and its result show up as several rows but one API message.
			const chat = [chatMessage(100), chatMessage(110), chatMessage(120)]
			const api = [message(105, { seq: 1 })]

			const result = assignNumbersToChatMessages(chat, api)

			expect(result[0].seq).toBe(1)
			expect(result[1].seq).toBeUndefined()
			expect(result[2].seq).toBeUndefined()
		})

		it("never hands the same number to two rows", () => {
			const chat = [chatMessage(100), chatMessage(200), chatMessage(300)]
			const api = [message(105, { seq: 1 }), message(205, { seq: 2 }), message(305, { seq: 3 })]

			const seqs = assignNumbersToChatMessages(chat, api).map((item) => item.seq)

			expect(new Set(seqs).size).toBe(seqs.length)
		})

		it("keeps numbers aligned after older messages were condensed", () => {
			const chat = [chatMessage(300), chatMessage(400)]
			// Numbers 1 and 2 belong to messages that are now hidden behind a summary.
			const api = [message(305, { seq: 3 }), message(405, { seq: 4 })]

			expect(assignNumbersToChatMessages(chat, api).map((item) => item.seq)).toEqual([3, 4])
		})

		it("returns the same array when nothing changed", () => {
			const chat = [chatMessage(100, { seq: 1 })]
			const api = [message(105, { seq: 1 })]

			expect(assignNumbersToChatMessages(chat, api)).toBe(chat)
		})

		it("numbers by position when the history carries no stored numbers", () => {
			// The model is sent positions in this case, so the chat has to show the same, or the
			// two sides would mean different messages by the same number.
			const chat = [chatMessage(100), chatMessage(200)]

			const result = assignNumbersToChatMessages(chat, [message(105), message(205)])

			expect(result.map((row) => row.seq)).toEqual([1, 2])
		})
	})
})
