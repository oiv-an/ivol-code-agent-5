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
		expect(ORDINARY_TASK_INSTRUCTIONS.length).toBeLessThan(3200)
	})

	it("requires an ordinary permitted write before compaction while preserving unrelated content", () => {
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("ordinary file tools (create it if missing)")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("Preserve other task blocks and unrelated user content")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("Normal tool permissions apply")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("A read or a statement that you saved is not a write")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("do not copy code, logs, secrets, or private reasoning")
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

	it.each([false, true])("keeps the native TODO schema independent (enabled=%s)", (enabled) => {
		const tool = createUpdateTodoListTool(enabled)
		if (tool.type !== "function") throw new Error("Expected a native function tool")
		expect(tool.function.parameters?.required).toEqual(["todos"])
		expect(tool.function.parameters?.properties).not.toHaveProperty("task_document")
	})
})
