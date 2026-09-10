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
		} as unknown as Task
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

	it("advertises nullable Markdown metadata only for intelligent task", () => {
		const definition = createUpdateTodoListTool(true)
		if (definition.type !== "function") throw new Error("Expected a function tool")
		expect(definition.function.strict).toBe(true)
		expect(definition.function.parameters?.required).toEqual(["todos", "task_document"])
		expect(definition.function.parameters?.properties).toMatchObject({
			task_document: { type: ["string", "null"] },
		})
	})

	it("preserves Markdown through native and legacy parsing", () => {
		const parsed = NativeToolCallParser.parseToolCall({
			id: "work-plan",
			name: "update_todo_list",
			arguments: JSON.stringify({ todos: "[-] Проверить вход", task_document: body }),
		})
		if (parsed?.type !== "tool_use") throw new Error("Expected a regular tool call")
		expect(parsed.nativeArgs).toEqual({ todos: "[-] Проверить вход", task_document: body })
		expect(new UpdateTodoListTool().parseLegacy({ todos: "[-] Проверить вход", task_document: body })).toEqual({
			todos: "[-] Проверить вход",
			task_document: body,
		})
	})

	it("saves the global plan and retains only current-stage steps in the UI", async () => {
		const { task, callbacks, tool } = fixture()
		await tool.execute({ todos: "[-] Проверить вход", task_document: body }, task, callbacks)
		expect(task.updatePersistentTaskDocument).toHaveBeenCalledWith(body)
		expect(task.todoList).toEqual([expect.objectContaining({ content: "Проверить вход", status: "in_progress" })])
		expect(task.todoList).not.toContainEqual(expect.objectContaining({ content: "Оплата" }))
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("successfully"))
	})

	it("never changes the visible checklist or reports success after a document save failure", async () => {
		const { task, callbacks, tool } = fixture()
		const previous = task.todoList
		vi.mocked(task.updatePersistentTaskDocument).mockRejectedValue(new Error("file changed"))
		await tool.execute({ todos: "[-] Проверить вход", task_document: body }, task, callbacks)
		expect(task.todoList).toBe(previous)
		expect(callbacks.handleError).toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("does not write the document when the user declines", async () => {
		const { task, callbacks, tool } = fixture()
		vi.mocked(callbacks.askApproval).mockResolvedValue(false)
		await tool.execute({ todos: "[-] Проверить вход", task_document: body }, task, callbacks)
		expect(task.updatePersistentTaskDocument).not.toHaveBeenCalled()
	})
})
