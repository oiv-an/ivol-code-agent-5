// kilocode_change - new file: enforce lossless task-state guidance and first-create behavior
import { createUpdateTodoListTool } from "../../prompts/tools/native-tools/update_todo_list"
import {
	INTELLIGENT_TASK_INSTRUCTIONS,
	INTELLIGENT_TASK_PREPARATION_PROMPT,
	TASK_DOCUMENT_PARAMETER_DESCRIPTION,
} from "../prompts"

describe("persistent task document prompts", () => {
	it("requires maintenance on every new request and on resumed pre-existing conversations without user reminders", () => {
		expect(INTELLIGENT_TASK_INSTRUCTIONS).toContain("standing system instruction for EVERY task request")
		expect(INTELLIGENT_TASK_INSTRUCTIONS).toContain("extension update or IDE restart")
		expect(INTELLIGENT_TASK_INSTRUCTIONS).toContain("On EVERY new user request")
		expect(INTELLIGENT_TASK_INSTRUCTIONS).toContain("preserving still-unfinished obligations")
		expect(INTELLIGENT_TASK_INSTRUCTIONS).toContain("record unknown prior progress as unverified")
		expect(INTELLIGENT_TASK_INSTRUCTIONS).toContain("Do not require the user to repeat")
	})
	it("starts the global plan on the first response and keeps stage completion distinct from task completion", () => {
		expect(INTELLIGENT_TASK_INSTRUCTIONS).toContain("On the FIRST response")
		expect(INTELLIGENT_TASK_INSTRUCTIONS).toContain("stable identifier (A, B, C...)")
		expect(INTELLIGENT_TASK_INSTRUCTIONS).toContain("Before declaring the whole task complete")
		expect(INTELLIGENT_TASK_INSTRUCTIONS).toContain("stage boundary, not proof that the entire task is complete")
		expect(INTELLIGENT_TASK_PREPARATION_PROMPT).toContain("Update that plan in place")
		expect(INTELLIGENT_TASK_PREPARATION_PROMPT).toContain("retain its major blocks, stable block identifiers")
		expect(INTELLIGENT_TASK_PREPARATION_PROMPT).toContain("not a patch")
		for (const prompt of [INTELLIGENT_TASK_INSTRUCTIONS, INTELLIGENT_TASK_PREPARATION_PROMPT]) {
			expect(prompt).toContain("CURRENT_TASK.md")
			expect(prompt).not.toContain("CURRENT_WORK.md")
		}
	})

	it.each([INTELLIGENT_TASK_INSTRUCTIONS, INTELLIGENT_TASK_PREPARATION_PROMPT, TASK_DOCUMENT_PARAMETER_DESCRIPTION])(
		"states the byte budgets and preserves obligations in every document-writing prompt",
		(prompt) => {
			expect(prompt).toContain("48 KiB of UTF-8 Markdown")
			expect(prompt).toContain("256 KiB (262144 UTF-8 bytes)")
			expect(prompt).toContain("including IVOL's ownership markers and line endings")
			expect(prompt).toContain("never truncate blindly or drop obligations")
		},
	)

	it("explains known missing-file creation in runtime instructions and the native tool schema", () => {
		expect(INTELLIGENT_TASK_INSTRUCTIONS).toContain("A missing CURRENT_TASK.md is normal")
		expect(INTELLIGENT_TASK_INSTRUCTIONS).toContain("skip read_file for that missing file")
		const tool = createUpdateTodoListTool(true)
		if (tool.type !== "function") throw new Error("Expected the native function tool")
		const properties = tool.function.parameters?.properties as Record<string, { description: string }>
		expect(properties.task_document.description).toBe(TASK_DOCUMENT_PARAMETER_DESCRIPTION)
		expect(properties.task_document.description).toContain("IVOL creates it on a successful update")
		expect(properties.task_document.description).toContain("skip read_file when it is already known to be missing")
	})
})
