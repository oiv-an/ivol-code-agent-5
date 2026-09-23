// kilocode_change - new file: ordinary maintenance, without a managed document protocol.
import { createUpdateTodoListTool } from "../../prompts/tools/native-tools/update_todo_list"
import { ORDINARY_CONTEXT_PREPARATION_PROMPT, ORDINARY_TASK_INSTRUCTIONS } from "../prompts"

describe("ordinary task document prompts", () => {
	it("asks for first-response maintenance and rereading after losing context", () => {
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("CURRENT_TASK.md in the project root")
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("first response, before starting project work")
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("whenever something real changes")
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("If you lose track of what you are doing, read it again")
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("medium detail")
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("what is done and verified, what is left")
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("Before the context is compacted")
		// Raised deliberately: the block now also records intent, state and key data.
		expect(ORDINARY_TASK_INSTRUCTIONS.length).toBeLessThan(4600)
	})

	it("requires an ordinary permitted write before compaction while preserving unrelated content", () => {
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("ordinary file tools (create it if missing)")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("Preserve other task blocks and unrelated user content")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("Normal tool permissions apply")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("A read or a statement that you saved is not a write")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain(
			"do not copy large code fragments, logs, or private reasoning",
		)
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("Do not continue project work")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("compact the conversation normally")
	})

	it.each([ORDINARY_TASK_INSTRUCTIONS, ORDINARY_CONTEXT_PREPARATION_PROMPT])(
		"reorganizes an existing legacy document on the first new or resumed turn without discarding work",
		(prompt) => {
			expect(prompt).toContain("first turn in a new or resumed conversation")
			expect(prompt).toContain("read the existing file before editing it")
			expect(prompt).toContain("reorganize that content into the task blocks")
			expect(prompt).toContain("Preserve unfinished requirements")
			expect(prompt).toContain("Do not invent completion")
			expect(prompt).toContain("If already structured, refresh only the current task's block")
		},
	)

	it("replaces structured task blocks rather than accumulating a diary", () => {
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("one Markdown block per task")
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("not technical identifiers")
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("creation and update dates")
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("Use [x] for completed items and [ ] for unfinished items")
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("replacing your task's block")
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("Preserve other task blocks")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("replace the current task's block")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("Do not append progress logs or duplicate the block")
	})

	it("requires user confirmation for cleanup and preserves unfinished work during compaction", () => {
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("ask whether to keep them, resume one")
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("Age or closing a chat alone is not permission")
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("awaiting verification, not automatic deletion")
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("Once the user confirms completion")
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("without an archive")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("Do not delete unfinished work")
	})

	it.each([ORDINARY_TASK_INSTRUCTIONS, ORDINARY_CONTEXT_PREPARATION_PROMPT])(
		"does not advertise managed arguments, ownership markers, snapshots or byte budgets",
		(prompt) => {
			for (const obsolete of [
				"task_document",
				"IVOL_TASK_V1",
				"revision",
				"KiB",
				"saved section",
				"CONTEXT_RESTART.md",
			]) {
				expect(prompt).not.toContain(obsolete)
			}
		},
	)

	it("tells the model that compaction continues the task instead of ending it", () => {
		// The preparation turn used to read as the last turn of the task, so the model
		// reported completion after every automatic compaction.
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain(
			"you will continue the same unfinished task from its next step",
		)
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("not its end")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("do not report the task as finished")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain(
			"do not ask the user what to do next merely because compaction happened",
		)
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("Compaction is routine maintenance, not the end of the task")
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("continue the unfinished work from its next step")
	})

	it.each([ORDINARY_TASK_INSTRUCTIONS, ORDINARY_CONTEXT_PREPARATION_PROMPT])(
		"asks for intent, current state and key data so nothing is redone or forgotten after compaction",
		(prompt) => {
			expect(prompt).toContain("your only memory after compaction")
			expect(prompt).toContain("Intent: what you are working towards")
			expect(prompt).toContain("tried or rejected with the reason")
			expect(prompt).toContain("marked so it is not redone")
			expect(prompt).toContain("file and directory paths")
			expect(prompt).toContain("credentials the user provided in the conversation, exactly as given")
			expect(prompt).toContain("add it to .gitignore first")
			expect(prompt).toContain("Next steps: the exact next action")
			expect(prompt).not.toContain("secrets")
		},
	)

	it("tells the model to trust finished steps after compaction", () => {
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("do not redo steps it marks as done")
		expect(ORDINARY_TASK_INSTRUCTIONS).toContain("Record new key data as soon as the user provides it")
	})

	it.each([false, true])("keeps the native TODO schema independent (enabled=%s)", (enabled) => {
		const tool = createUpdateTodoListTool(enabled)
		if (tool.type !== "function") throw new Error("Expected a native function tool")
		expect(tool.function.parameters?.required).toEqual(["todos"])
		expect(tool.function.parameters?.properties).not.toHaveProperty("task_document")
	})
})
