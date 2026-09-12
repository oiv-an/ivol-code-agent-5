// kilocode_change - new file: a frozen message must reach the model in every request.
//
// The rule these tests protect: condensing and truncation run over the COMPLETE conversation,
// frozen messages included. Pulling the most important messages out of the summary input would
// leave the summarizing model with holes exactly where the key decisions were made. Frozen
// messages are therefore tagged like everything else and re-added afterwards, by
// getEffectiveApiHistory() - the single place that decides what the API actually sees.
import { truncateConversation } from "../../../context-management"
import { getEffectiveApiHistory } from "../../../condense"
import type { ApiMessage } from "../../../task-persistence/apiMessages"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureSlidingWindowTruncation: vi.fn(),
			captureContextCondensed: vi.fn(),
		},
	},
}))

const message = (ts: number, extra: Partial<ApiMessage> = {}): ApiMessage => ({
	role: ts % 2 === 0 ? "assistant" : "user",
	content: [{ type: "text", text: `message ${ts}` }],
	ts,
	...extra,
})

const summary = (ts: number, condenseId: string): ApiMessage => ({
	role: "assistant",
	content: [{ type: "text", text: "summary" }],
	ts,
	isSummary: true,
	condenseId,
})

describe("frozen messages stay in context", () => {
	describe("condensing", () => {
		it("sends a frozen message even though its summary exists", () => {
			const messages: ApiMessage[] = [
				message(1),
				summary(2, "summary-1"),
				message(3, { condenseParent: "summary-1" }),
				message(4, { condenseParent: "summary-1", pinned: true, pinnedBy: "user" }),
				message(5),
			]

			const effective = getEffectiveApiHistory(messages)

			// 3 was condensed away, 4 carries the very same tag but is frozen and comes back.
			expect(effective.map((item) => item.ts)).toEqual([1, 2, 4, 5])
		})

		it("keeps the frozen message in every following request", () => {
			const messages: ApiMessage[] = [
				summary(1, "summary-1"),
				message(2, { condenseParent: "summary-1", pinned: true }),
				summary(3, "summary-2"),
				message(4, { condenseParent: "summary-2" }),
			]

			// A second condense pass does not dislodge it.
			expect(getEffectiveApiHistory(messages).map((item) => item.ts)).toEqual([1, 2, 3])
		})

		it("stops sending the message once the mark is gone", () => {
			const frozen: ApiMessage[] = [
				summary(1, "summary-1"),
				message(2, { condenseParent: "summary-1", pinned: true }),
			]
			expect(getEffectiveApiHistory(frozen).map((item) => item.ts)).toEqual([1, 2])

			const thawed = frozen.map((item) => {
				const { pinned: _pinned, ...rest } = item
				return rest as ApiMessage
			})
			expect(getEffectiveApiHistory(thawed).map((item) => item.ts)).toEqual([1])
		})
	})

	describe("tool pairs", () => {
		it("brings the tool_use back together with a frozen tool_result", () => {
			const messages: ApiMessage[] = [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: {} }],
					ts: 1,
					condenseParent: "summary-1",
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file body" }],
					ts: 2,
					condenseParent: "summary-1",
					pinned: true,
				},
				summary(3, "summary-1"),
			]

			const effective = getEffectiveApiHistory(messages)

			// A tool_result without its tool_use is rejected by the API.
			expect(effective.map((item) => item.ts)).toEqual([1, 2, 3])
		})

		it("brings the tool_result back together with a frozen tool_use", () => {
			const messages: ApiMessage[] = [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: {} }],
					ts: 1,
					truncationParent: "trunc-1",
					pinned: true,
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file body" }],
					ts: 2,
					truncationParent: "trunc-1",
				},
				{
					role: "user",
					content: "[Sliding window truncation]",
					ts: 3,
					isTruncationMarker: true,
					truncationId: "trunc-1",
				},
			]

			expect(getEffectiveApiHistory(messages).map((item) => item.ts)).toEqual([1, 2, 3])
		})
	})

	describe("sliding window truncation", () => {
		// Timestamps are spaced out: the truncation marker is inserted at `firstKeptTs - 1`, so
		// consecutive values would make the marker collide with a real message.
		it("tags frozen messages like any other, but still sends them", () => {
			const messages = [
				message(10),
				message(20),
				message(30, { pinned: true, pinnedBy: "user" }),
				message(40),
				message(50),
				message(60),
				message(70),
			]

			const { messages: result, messagesRemoved } = truncateConversation(messages, 0.5, "task-1")

			expect(messagesRemoved).toBeGreaterThan(0)
			// The frozen message takes part in truncation bookkeeping...
			const frozen = result.find((item) => item.ts === 30)
			expect(frozen?.truncationParent).toBeDefined()
			// ...and is still delivered to the model.
			expect(getEffectiveApiHistory(result).some((item) => item.ts === 30)).toBe(true)
		})

		it("still hides unfrozen neighbours", () => {
			const messages = [
				message(10),
				message(20, { pinned: true, pinnedBy: "model" }),
				message(30),
				message(40),
				message(50),
				message(60),
				message(70),
			]

			const { messages: result, messagesRemoved } = truncateConversation(messages, 0.5, "task-1")
			const effectiveTs = getEffectiveApiHistory(result).map((item) => item.ts)

			expect(messagesRemoved).toBeGreaterThan(0)
			expect(effectiveTs).toContain(20)
			expect(effectiveTs).not.toContain(30)
		})
	})
})
