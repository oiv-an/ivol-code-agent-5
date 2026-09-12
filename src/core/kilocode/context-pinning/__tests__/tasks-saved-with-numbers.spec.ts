// kilocode_change - new file
/**
 * Messages were briefly numbered, so conversations saved in that period carry a `seq` field that
 * the code no longer knows about. Freezing is now the user's own decision, made with the button in
 * the chat, and a number nobody quotes is only noise.
 *
 * Opening one of those tasks must not lose the freeze marks, which are stored separately.
 */

import { getPinnedMessages, pinMessages, unpinMessages } from "../index"
import type { ApiMessage } from "../../../task-persistence/apiMessages"

/** A history as it was written to disk while numbering existed. */
const savedWithNumbers = [
	{ role: "user", content: [{ type: "text", text: "the requirement" }], ts: 1_000, seq: 1, pinned: true },
	{ role: "assistant", content: [{ type: "text", text: "understood" }], ts: 2_000, seq: 2 },
	{ role: "user", content: [{ type: "text", text: "carry on" }], ts: 3_000, seq: 3, pinned: true },
]

describe("a task saved while messages were numbered", () => {
	// Histories are read with a plain JSON.parse, so an unknown field simply travels along.
	const history = JSON.parse(JSON.stringify(savedWithNumbers)) as ApiMessage[]

	it("keeps the freeze marks that were set before", () => {
		expect(getPinnedMessages(history)).toHaveLength(2)
		expect(history[0].pinned).toBe(true)
		expect(history[2].pinned).toBe(true)
	})

	it("can still be unfrozen from the chat", () => {
		const { messages, changes } = unpinMessages(history, [1_000])

		expect(changes).toHaveLength(1)
		expect(messages[0].pinned).toBeUndefined()
		expect(getPinnedMessages(messages)).toHaveLength(1)
	})

	it("can still be frozen from the chat", () => {
		const { messages, changes } = pinMessages(history, [{ ts: 2_000 }], "user")

		expect(changes).toHaveLength(1)
		expect(messages[1].pinned).toBe(true)
		expect(messages[1].pinnedBy).toBe("user")
	})

	it("leaves the leftover field alone rather than failing on it", () => {
		// Rewriting old files to drop the field would be a migration, and it buys nothing: the
		// field is never read.
		const { messages } = pinMessages(history, [{ ts: 2_000 }], "user")

		expect((messages[0] as { seq?: number }).seq).toBe(1)
	})
})
