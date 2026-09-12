// kilocode_change - new file
import type { ApiMessage } from "../../../task-persistence/apiMessages"
import {
	checkPinnedBudget,
	collectToolPairIndices,
	getPinnedMessages,
	isHidden,
	normalizePinnedBudgetPercent,
	pinMessages,
	unpinMessages,
} from "../index"

const text = (ts: number, content: string, extra: Partial<ApiMessage> = {}): ApiMessage => ({
	role: "assistant",
	content: [{ type: "text", text: content }],
	ts,
	...extra,
})

const toolUse = (ts: number, id: string, extra: Partial<ApiMessage> = {}): ApiMessage => ({
	role: "assistant",
	content: [{ type: "tool_use", id, name: "read_file", input: {} }],
	ts,
	...extra,
})

const toolResult = (ts: number, id: string, extra: Partial<ApiMessage> = {}): ApiMessage => ({
	role: "user",
	content: [{ type: "tool_result", tool_use_id: id, content: "file contents" }],
	ts,
	...extra,
})

describe("context pinning", () => {
	describe("pinMessages", () => {
		it("marks a visible message without touching anything else", () => {
			const messages = [text(1, "first"), text(2, "decision"), text(3, "later")]

			const { messages: result, changes } = pinMessages(messages, [{ ts: 2, note: "key decision" }], "model")

			expect(result[1].pinned).toBe(true)
			expect(result[1].pinnedBy).toBe("model")
			expect(result[1].pinnedNote).toBe("key decision")
			expect(typeof result[1].pinnedAt).toBe("number")
			expect(result[0].pinned).toBeUndefined()
			expect(result[2].pinned).toBeUndefined()
			expect(changes).toEqual([{ ts: 2, restored: false, restoredPartners: [] }])
		})

		it("records the user as the author when the user pins", () => {
			const { messages: result } = pinMessages([text(1, "a")], [{ ts: 1 }], "user")
			expect(result[0].pinnedBy).toBe("user")
		})

		it("reports targets that do not exist", () => {
			const { skipped } = pinMessages([text(1, "a")], [{ ts: 99 }], "user")
			expect(skipped).toEqual([{ ts: 99, reason: "not-found" }])
		})

		it("reports a message that is already pinned", () => {
			const { skipped } = pinMessages([text(1, "a", { pinned: true })], [{ ts: 1 }], "user")
			expect(skipped).toEqual([{ ts: 1, reason: "already-pinned" }])
		})
	})

	describe("restoring hidden messages", () => {
		it("brings a condensed message back into the effective history", () => {
			const messages = [text(1, "first"), text(2, "important", { condenseParent: "summary-1" }), text(3, "tail")]

			const { messages: result, changes } = pinMessages(messages, [{ ts: 2 }], "user")

			expect(result[1].condenseParent).toBeUndefined()
			expect(result[1].pinned).toBe(true)
			expect(result[1].pinRestored).toBe(true)
			expect(changes[0].restored).toBe(true)
		})

		it("brings a truncated message back as well", () => {
			const messages = [text(1, "first"), text(2, "hidden", { truncationParent: "trunc-1" })]

			const { messages: result } = pinMessages(messages, [{ ts: 2 }], "user")

			expect(result[1].truncationParent).toBeUndefined()
			expect(isHidden(result[1])).toBe(false)
		})

		it("restores the matching tool_result when a tool_use is pinned", () => {
			const messages = [
				text(1, "first"),
				toolUse(2, "toolu_1", { condenseParent: "summary-1" }),
				toolResult(3, "toolu_1", { condenseParent: "summary-1" }),
				text(4, "tail"),
			]

			const { messages: result, changes } = pinMessages(messages, [{ ts: 2 }], "model")

			expect(result[1].condenseParent).toBeUndefined()
			expect(result[2].condenseParent).toBeUndefined()
			expect(changes[0].restoredPartners).toEqual([3])
		})

		it("restores the matching tool_use when a tool_result is pinned", () => {
			const messages = [
				toolUse(1, "toolu_7", { condenseParent: "summary-1" }),
				toolResult(2, "toolu_7", { condenseParent: "summary-1" }),
			]

			const { messages: result, changes } = pinMessages(messages, [{ ts: 2 }], "user")

			expect(result[0].condenseParent).toBeUndefined()
			expect(result[1].condenseParent).toBeUndefined()
			expect(changes[0].restoredPartners).toEqual([1])
		})

		it("marks only the target, not the partner it dragged along", () => {
			const messages = [
				toolUse(1, "toolu_2", { condenseParent: "summary-1" }),
				toolResult(2, "toolu_2", { condenseParent: "summary-1" }),
			]

			const { messages: result } = pinMessages(messages, [{ ts: 1 }], "model")

			expect(result[0].pinned).toBe(true)
			expect(result[1].pinned).toBeUndefined()
		})

		it("leaves a visible partner alone", () => {
			const messages = [toolUse(1, "toolu_3", { condenseParent: "summary-1" }), toolResult(2, "toolu_3")]

			const { messages: result, changes } = pinMessages(messages, [{ ts: 1 }], "model")

			expect(result[1].pinRestored).toBeUndefined()
			expect(changes[0].restoredPartners).toEqual([])
		})
	})

	describe("collectToolPairIndices", () => {
		it("returns just the message when it carries no tool blocks", () => {
			const messages = [text(1, "a"), text(2, "b")]
			expect([...collectToolPairIndices(messages, 1)]).toEqual([1])
		})

		it("follows a chain of tool blocks in one assistant turn", () => {
			const messages: ApiMessage[] = [
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "a", name: "read_file", input: {} },
						{ type: "tool_use", id: "b", name: "read_file", input: {} },
					],
					ts: 1,
				},
				toolResult(2, "a"),
				toolResult(3, "b"),
			]

			expect([...collectToolPairIndices(messages, 0)].sort()).toEqual([0, 1, 2])
		})
	})

	describe("unpinMessages", () => {
		it("removes every pin field", () => {
			const messages = [text(1, "a", { pinned: true, pinnedBy: "model", pinnedNote: "n", pinnedAt: 123 })]

			const { messages: result, changes } = unpinMessages(messages, [1])

			expect(result[0].pinned).toBeUndefined()
			expect(result[0].pinnedBy).toBeUndefined()
			expect(result[0].pinnedNote).toBeUndefined()
			expect(result[0].pinnedAt).toBeUndefined()
			expect(changes).toEqual([{ ts: 1, restored: false, restoredPartners: [] }])
		})

		it("does not hide a message again when its mark is removed", () => {
			const pinned = pinMessages([text(1, "a", { condenseParent: "summary-1" })], [{ ts: 1 }], "user")
			const { messages: result } = unpinMessages(pinned.messages, [1])

			expect(result[0].condenseParent).toBeUndefined()
			expect(isHidden(result[0])).toBe(false)
		})

		it("reports targets that were not pinned", () => {
			const { skipped } = unpinMessages([text(1, "a")], [1])
			expect(skipped).toEqual([{ ts: 1, reason: "not-pinned" }])
		})

		it("clears several marks at once, as a bulk request does", () => {
			const messages = [
				text(1, "a", { pinned: true, pinnedBy: "user" }),
				text(2, "b", { pinned: true, pinnedBy: "model" }),
				text(3, "c"),
			]

			const { messages: result, changes } = unpinMessages(messages, [1, 2])

			expect(getPinnedMessages(result)).toHaveLength(0)
			expect(changes.map((change) => change.ts)).toEqual([1, 2])
		})
	})

	describe("checkPinnedBudget", () => {
		const countTokens = async () => 100

		it("passes when pinned content fits", async () => {
			const messages = [text(1, "a", { pinned: true }), text(2, "b")]

			const check = await checkPinnedBudget(messages, 1000, 50, countTokens)

			expect(check.withinBudget).toBe(true)
			expect(check.pinnedTokens).toBe(100)
			expect(check.allowedTokens).toBe(500)
		})

		it("fails when pinned content exceeds the share of the window", async () => {
			const messages = [
				text(1, "a", { pinned: true, pinnedAt: 1 }),
				text(2, "b", { pinned: true, pinnedAt: 2 }),
				text(3, "c", { pinned: true, pinnedAt: 3 }),
			]

			const check = await checkPinnedBudget(messages, 500, 50, countTokens)

			expect(check.withinBudget).toBe(false)
			expect(check.pinnedTokens).toBe(300)
			expect(check.allowedTokens).toBe(250)
		})

		it("lists the oldest marks first so they can be released", async () => {
			const messages = [
				text(1, "a", { pinned: true, pinnedAt: 300, pinnedNote: "newest" }),
				text(2, "b", { pinned: true, pinnedAt: 100, pinnedNote: "oldest" }),
				text(3, "c", { pinned: true, pinnedAt: 200 }),
			]

			const check = await checkPinnedBudget(messages, 1000, 50, countTokens)

			expect(check.oldestPinned.map((entry) => entry.ts)).toEqual([2, 3, 1])
			expect(check.oldestPinned[0].note).toBe("oldest")
		})
	})

	describe("normalizePinnedBudgetPercent", () => {
		it("defaults to 50 percent", () => {
			expect(normalizePinnedBudgetPercent(undefined)).toBe(50)
			expect(normalizePinnedBudgetPercent(null)).toBe(50)
			expect(normalizePinnedBudgetPercent(Number.NaN)).toBe(50)
		})

		it("clamps to a usable range", () => {
			expect(normalizePinnedBudgetPercent(1)).toBe(5)
			expect(normalizePinnedBudgetPercent(200)).toBe(90)
			expect(normalizePinnedBudgetPercent(35)).toBe(35)
		})
	})
})
