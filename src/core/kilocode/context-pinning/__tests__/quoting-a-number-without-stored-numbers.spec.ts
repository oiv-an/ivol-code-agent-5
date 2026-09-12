// kilocode_change - new file
import type { ApiMessage } from "../../../task-persistence/apiMessages"
import { findMessageByNumber, numberByPosition, resolveSeqNumbers } from "../numbering"

/**
 * Quoting a message number on a conversation that carries none.
 *
 * Numbers used to be read from the stored `seq` field, which every task started before numbering
 * existed lacks entirely. The model was shown no numbers, invented one, and freezing reported
 * success while matching nothing. Positions are used as the fallback so both sides agree.
 */
const message = (ts: number, seq?: number): ApiMessage => ({
	ts,
	role: "assistant",
	content: "written answer",
	...(seq === undefined ? {} : { seq }),
})

describe("numbering a history that has no stored numbers", () => {
	it("numbers every message by its position, counting from one", () => {
		const messages = [message(1000), message(2000), message(3000)]
		const numbers = numberByPosition(messages)

		expect(numbers.get(messages[0])).toBe(1)
		expect(numbers.get(messages[1])).toBe(2)
		expect(numbers.get(messages[2])).toBe(3)
	})

	it("keeps a stored number wherever one exists", () => {
		const messages = [message(1000, 41), message(2000)]
		const numbers = numberByPosition(messages)

		expect(numbers.get(messages[0])).toBe(41)
		expect(numbers.get(messages[1])).toBe(2)
	})
})

describe("finding the message a quoted number refers to", () => {
	it("finds it by position when nothing carries a stored number", () => {
		const messages = [message(1000), message(2000), message(3000)]

		expect(findMessageByNumber(messages, 2)?.ts).toBe(2000)
	})

	it("prefers a stored number over the position", () => {
		const messages = [message(1000), message(2000, 1)]

		expect(findMessageByNumber(messages, 1)?.ts).toBe(2000)
	})

	it("reports nothing for a number past the end", () => {
		expect(findMessageByNumber([message(1000)], 7)).toBeUndefined()
	})

	it("reports nothing for zero, since numbers start at one", () => {
		expect(findMessageByNumber([message(1000)], 0)).toBeUndefined()
	})
})

describe("resolving the numbers the model quoted", () => {
	it("resolves a freeze request on a conversation with no stored numbers", () => {
		// This is the case the user hit: the model said "freeze #6" and nothing happened.
		const messages = Array.from({ length: 8 }, (_, index) => message((index + 1) * 1000))

		const { found, missing } = resolveSeqNumbers(messages, [6])

		expect(missing).toEqual([])
		expect(found).toEqual([{ seq: 6, ts: 6000 }])
	})

	it("resolves several quoted numbers at once", () => {
		const messages = Array.from({ length: 5 }, (_, index) => message((index + 1) * 1000))

		const { found } = resolveSeqNumbers(messages, [1, 3])

		expect(found.map((item) => item.ts)).toEqual([1000, 3000])
	})

	it("still reports a number that matches nothing", () => {
		const messages = [message(1000), message(2000)]

		const { found, missing } = resolveSeqNumbers(messages, [2, 9])

		expect(found.map((item) => item.ts)).toEqual([2000])
		expect(missing).toEqual([9])
	})
})
