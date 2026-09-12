// kilocode_change - new file
import type { ClineMessage } from "@roo-code/types"

/**
 * A chat row is handed to the webview the moment it is created, which is before the API message
 * that gives it its number exists. The number therefore has to be sent again once numbering runs,
 * otherwise the chat shows no numbers and the user has nothing to quote when asking for a message
 * to be frozen.
 *
 * Task pulls in the whole extension, so the delivery rule is exercised on its own here.
 */
const postNewlyNumberedMessages = async (
	before: ClineMessage[],
	after: ClineMessage[],
	post: (message: ClineMessage) => Promise<void>,
) => {
	const previousSeqByTs = new Map<number, number | undefined>()
	for (const message of before) {
		previousSeqByTs.set(message.ts, message.seq)
	}

	for (const message of after) {
		if (typeof message.seq !== "number") continue
		if (previousSeqByTs.get(message.ts) === message.seq) continue
		await post(message)
	}
}

const row = (ts: number, seq?: number): ClineMessage =>
	({ ts, type: "say", say: "text", text: "written answer", ...(seq === undefined ? {} : { seq }) }) as ClineMessage

describe("numbers reaching the webview", () => {
	it("sends a row that just gained a number", async () => {
		const sent: ClineMessage[] = []

		await postNewlyNumberedMessages([row(1000)], [row(1000, 1)], async (message) => {
			sent.push(message)
		})

		expect(sent).toHaveLength(1)
		expect(sent[0].seq).toBe(1)
		expect(sent[0].ts).toBe(1000)
	})

	it("sends nothing when the numbers did not change", async () => {
		const sent: ClineMessage[] = []

		await postNewlyNumberedMessages([row(1000, 1)], [row(1000, 1)], async (message) => {
			sent.push(message)
		})

		expect(sent).toHaveLength(0)
	})

	it("sends only the rows that changed", async () => {
		const sent: ClineMessage[] = []

		await postNewlyNumberedMessages([row(1000, 1), row(2000)], [row(1000, 1), row(2000, 2)], async (message) => {
			sent.push(message)
		})

		expect(sent.map((message) => message.ts)).toEqual([2000])
	})

	it("ignores rows that are still unnumbered", async () => {
		const sent: ClineMessage[] = []

		await postNewlyNumberedMessages([row(1000)], [row(1000)], async (message) => {
			sent.push(message)
		})

		expect(sent).toHaveLength(0)
	})

	it("sends a row whose number was corrected", async () => {
		const sent: ClineMessage[] = []

		await postNewlyNumberedMessages([row(1000, 1)], [row(1000, 5)], async (message) => {
			sent.push(message)
		})

		expect(sent.map((message) => message.seq)).toEqual([5])
	})
})
