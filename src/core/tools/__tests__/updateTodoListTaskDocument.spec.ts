// kilocode_change - new file: the stage checklist and persistent global plan stay distinct.
import { UpdateTodoListTool } from "../UpdateTodoListTool"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { createUpdateTodoListTool } from "../../prompts/tools/native-tools/update_todo_list"

describe("intelligent task tool integration", () => {
	const body =
		"# Общая задача\n\n## Ветки\n- Авторизация: в работе\n- Оплата: ожидание\n\n## Resume here\nПроверить вход"
	function fixture() {
		const task = {
			todoList: [{ id: "previous", content: "Старый этап", status: "pending" }],
			updatePersistentTaskDocument: vi.fn().mockResolvedValue(undefined),
			say: vi.fn(),
		} as unknown as Task & { updatePersistentTaskDocument: ReturnType<typeof vi.fn> }
		const callbacks: ToolCallbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			removeClosingTag: (_name, value) => value ?? "",
			toolProtocol: "native",
		}
		return { task, callbacks, tool: new UpdateTodoListTool() }
	}

	it("keeps the original native schema when the mode is off", () => {
		const definition = createUpdateTodoListTool(false)
		expect(definition.type).toBe("function")
		if (definition.type !== "function") throw new Error("Expected a function tool")
		expect(definition.function.parameters?.required).toEqual(["todos"])
		expect(definition.function.parameters?.properties).not.toHaveProperty("task_document")
	})

	it("keeps TODO independent in intelligent task mode", () => {
		const definition = createUpdateTodoListTool(true)
		if (definition.type !== "function") throw new Error("Expected a function tool")
		expect(definition.function.strict).toBe(true)
		expect(definition.function.parameters?.required).toEqual(["todos"])
		expect(definition.function.parameters?.properties).not.toHaveProperty("task_document")
	})

	it("ignores obsolete document bodies in native and legacy parsing", () => {
		const parsed = NativeToolCallParser.parseToolCall({
			id: "work-plan",
			name: "update_todo_list",
			arguments: JSON.stringify({ todos: "[-] Проверить вход", task_document: body }),
		})
		if (parsed?.type !== "tool_use") throw new Error("Expected a regular tool call")
		expect(parsed.nativeArgs).toEqual({ todos: "[-] Проверить вход" })
		expect(new UpdateTodoListTool().parseLegacy({ todos: "[-] Проверить вход", task_document: body })).toEqual({
			todos: "[-] Проверить вход",
		})
	})

	it("updates only the checklist without invoking a managed document writer", async () => {
		const { task, callbacks, tool } = fixture()
		await tool.execute(tool.parseLegacy({ todos: "[-] Проверить вход", task_document: body }), task, callbacks)
		expect(task.updatePersistentTaskDocument).not.toHaveBeenCalled()
		expect(task.todoList).toEqual([expect.objectContaining({ content: "Проверить вход", status: "in_progress" })])
		expect(task.todoList).not.toContainEqual(expect.objectContaining({ content: "Оплата" }))
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("successfully"))
	})

	it("does not depend on the obsolete document writer to update the checklist", async () => {
		const { task, callbacks, tool } = fixture()
		vi.mocked(task.updatePersistentTaskDocument).mockRejectedValue(new Error("file changed"))
		await tool.execute(tool.parseLegacy({ todos: "[-] Проверить вход", task_document: body }), task, callbacks)
		expect(task.todoList).toEqual([expect.objectContaining({ content: "Проверить вход" })])
		expect(task.updatePersistentTaskDocument).not.toHaveBeenCalled()
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("successfully"))
	})

	it("does not write the document when the user declines", async () => {
		const { task, callbacks, tool } = fixture()
		vi.mocked(callbacks.askApproval).mockResolvedValue(false)
		await tool.execute(tool.parseLegacy({ todos: "[-] Проверить вход", task_document: body }), task, callbacks)
		expect(task.updatePersistentTaskDocument).not.toHaveBeenCalled()
	})
})
