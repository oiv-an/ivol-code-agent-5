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
		expect(ORDINARY_TASK_INSTRUCTIONS.length).toBeLessThan(1000)
	})

	it("requires an ordinary permitted write before compaction while preserving unrelated content", () => {
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("ordinary file tools (create it if missing)")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("Preserve unrelated user content")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("Normal tool permissions apply")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("A read or a statement that you saved is not a write")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("do not copy code, logs, secrets, or private reasoning")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("Do not continue project work")
		expect(ORDINARY_CONTEXT_PREPARATION_PROMPT).toContain("compact the conversation normally")
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
