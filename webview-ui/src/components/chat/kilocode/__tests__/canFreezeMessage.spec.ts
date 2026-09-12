// kilocode_change - new file
import type { ClineMessage } from "@roo-code/types"

import { canFreezeMessage, FREEZE_MIN_WORDS } from "../canFreezeMessage"

const message = (overrides: Partial<ClineMessage>): ClineMessage =>
	({
		ts: 1_700_000_000_000,
		type: "say",
		say: "text",
		text: "a written answer that is long enough to matter",
		...overrides,
	}) as ClineMessage

describe("canFreezeMessage", () => {
	it("offers freezing on an answer the model wrote", () => {
		expect(canFreezeMessage(message({ say: "text" }))).toBe(true)
	})

	it("offers freezing on what the user typed", () => {
		expect(canFreezeMessage(message({ say: "user_feedback" }))).toBe(true)
	})

	it("offers freezing on a completion result", () => {
		expect(canFreezeMessage(message({ say: "completion_result" }))).toBe(true)
	})

	it("does not offer freezing while the message is still streaming", () => {
		expect(canFreezeMessage(message({ partial: true }))).toBe(false)
	})

	it.each([
		["a tool row", "tool"],
		["command output", "command_output"],
		["the API request row", "api_req_started"],
		["a browser action", "browser_action_result"],
		["a checkpoint marker", "checkpoint_saved"],
	])("does not offer freezing on %s", (_label, say) => {
		expect(canFreezeMessage(message({ say: say as ClineMessage["say"] }))).toBe(false)
	})

	it("does not offer freezing on a question the model asks", () => {
		expect(canFreezeMessage(message({ type: "ask", ask: "followup", say: undefined }))).toBe(false)
	})

	it("does not offer freezing on a short acknowledgement", () => {
		expect(canFreezeMessage(message({ text: "ok done" }))).toBe(false)
	})

	it("offers freezing once the text reaches the word threshold", () => {
		const atThreshold = Array.from({ length: FREEZE_MIN_WORDS }, (_, index) => `word${index}`).join(" ")
		const belowThreshold = Array.from({ length: FREEZE_MIN_WORDS - 1 }, (_, index) => `word${index}`).join(" ")

		expect(canFreezeMessage(message({ text: atThreshold }))).toBe(true)
		expect(canFreezeMessage(message({ text: belowThreshold }))).toBe(false)
	})

	it("ignores padding when counting words", () => {
		expect(canFreezeMessage(message({ text: "  one   two \n three \t four  " }))).toBe(false)
	})

	it("does not offer freezing on an empty message", () => {
		expect(canFreezeMessage(message({ text: "" }))).toBe(false)
		expect(canFreezeMessage(message({ text: undefined }))).toBe(false)
	})

	it("does not offer freezing without a timestamp to toggle", () => {
		expect(canFreezeMessage(message({ ts: undefined as unknown as number }))).toBe(false)
	})

	it("offers freezing on a message that has not been numbered yet", () => {
		expect(canFreezeMessage(message({ seq: undefined }))).toBe(true)
	})
})
