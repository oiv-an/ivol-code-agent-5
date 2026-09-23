// kilocode_change - new file: compaction of unfinished work must not end the task.
import { formatResponse } from "../../responses"

describe("condense responses", () => {
	describe("a summary the user explicitly asked for", () => {
		it("still hands control back to the user", () => {
			const response = formatResponse.condense()

			expect(response).toContain("ONLY asking the user what you should work on next")
			expect(response).toContain("accepted the condensed conversation summary")
		})

		it("defaults to the user-facing wording when no state is passed", () => {
			expect(formatResponse.condense()).toBe(formatResponse.condense(false))
		})
	})

	describe("a compaction that interrupts unfinished work", () => {
		const response = formatResponse.condense(true)

		it("tells the model to continue from the recorded next step", () => {
			expect(response).toContain("routine maintenance in the middle of an unfinished task")
			expect(response).toContain("Continue the task from the next step recorded in the summary")
		})

		it("removes the instruction that caused the task to stop", () => {
			expect(response).not.toContain("ONLY asking the user what you should work on next")
			expect(response).not.toContain("You should NOT take any initiative")
		})

		it("forbids a completion report triggered by compaction alone", () => {
			expect(response).toContain("Do NOT report the task as complete")
			expect(response).toContain("do NOT ask the user what to work on next merely because the context")
		})

		it("keeps a genuine decision point available", () => {
			expect(response).toContain("Stop and ask the user only if the task genuinely requires a decision")
		})
	})

	describe("the note appended after an automatic compaction", () => {
		const note = formatResponse.condenseContinuation()

		it("frames compaction as maintenance rather than an ending", () => {
			expect(note).toContain("routine maintenance, not the end of the task")
			expect(note).toContain("Continue the unfinished task from its next step")
		})

		it("blocks the completion and hand-back reflexes", () => {
			expect(note).toContain("Do NOT call attempt_completion just because compaction finished")
			expect(note).toContain("do NOT restate what you already did")
		})

		it("marks itself as automated so the model does not reply conversationally", () => {
			expect(note).toContain("This is an automated message")
		})
	})
})
