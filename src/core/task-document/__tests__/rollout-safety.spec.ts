// kilocode_change - new file: independently approved tasks must keep their own stage checklist and document.
import type { Task } from "../../task/Task"
import { setPendingTodoList, UpdateTodoListTool } from "../../tools/UpdateTodoListTool"
import type { ToolCallbacks } from "../../tools/BaseTool"

function deferredApproval() {
	let settle!: (approved: boolean) => void
	const promise = new Promise<boolean>((resolve) => {
		settle = resolve
	})
	return { promise, settle }
}

function taskFixture(id: string, approval = deferredApproval()) {
	const task = {
		taskId: id,
		todoList: [{ id: `${id}-old`, content: `${id} previous stage`, status: "pending" }],
		updatePersistentTaskDocument: vi.fn().mockResolvedValue(undefined),
		say: vi.fn(),
	} as unknown as Task & { updatePersistentTaskDocument: ReturnType<typeof vi.fn> }
	const callbacks: ToolCallbacks = {
		askApproval: vi.fn(() => approval.promise),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
		removeClosingTag: (_name, value) => value ?? "",
		toolProtocol: "native",
	}
	return { task, callbacks, approval, tool: new UpdateTodoListTool() }
}

describe("Intelligent Task rollout approval isolation", () => {
	it.each(["a-first", "b-first"] as const)(
		"keeps independent task checklists and documents when approvals overlap: %s",
		async (order) => {
			const a = taskFixture("task-a")
			const b = taskFixture("task-b")
			const aRun = a.tool.execute({ todos: "[-] A current stage" }, a.task, a.callbacks)
			const bRun = b.tool.execute({ todos: "[-] B current stage" }, b.task, b.callbacks)
			if (order === "a-first") {
				a.approval.settle(true)
				await aRun
				b.approval.settle(true)
			} else {
				b.approval.settle(true)
				await bRun
				a.approval.settle(true)
			}
			await Promise.all([aRun, bRun])
			expect(a.task.todoList).toEqual([
				expect.objectContaining({ content: "A current stage", status: "in_progress" }),
			])
			expect(b.task.todoList).toEqual([
				expect.objectContaining({ content: "B current stage", status: "in_progress" }),
			])
			expect(a.task.updatePersistentTaskDocument).not.toHaveBeenCalled()
			expect(b.task.updatePersistentTaskDocument).not.toHaveBeenCalled()
			expect(a.task.say).not.toHaveBeenCalled()
			expect(b.task.say).not.toHaveBeenCalled()
			expect(a.callbacks.handleError).not.toHaveBeenCalled()
			expect(b.callbacks.handleError).not.toHaveBeenCalled()
		},
	)

	it("a declined task cannot replace a separately approved task's checklist", async () => {
		const a = taskFixture("task-a")
		const b = taskFixture("task-b")
		const aRun = a.tool.execute({ todos: "[-] Approved A stage" }, a.task, a.callbacks)
		const bRun = b.tool.execute({ todos: "[-] Declined B stage" }, b.task, b.callbacks)
		b.approval.settle(false)
		await bRun
		a.approval.settle(true)
		await aRun
		expect(a.task.todoList).toEqual([expect.objectContaining({ content: "Approved A stage" })])
		expect(b.task.todoList).toEqual([expect.objectContaining({ content: "task-b previous stage" })])
		expect(b.task.updatePersistentTaskDocument).not.toHaveBeenCalled()
	})

	it("applies manual edits only to the matching pending task and copies the user payload", async () => {
		const a = taskFixture("task-a")
		const b = taskFixture("task-b")
		const aRun = a.tool.execute({ todos: "[-] A initial" }, a.task, a.callbacks)
		const bRun = b.tool.execute({ todos: "[-] B initial" }, b.task, b.callbacks)
		const edits = [{ id: "a-manual", content: "A manually edited", status: "pending" as const }]
		expect(setPendingTodoList(a.task, edits)).toBe(true)
		edits[0].content = "Changed after submission"
		a.approval.settle(true)
		b.approval.settle(true)
		await Promise.all([aRun, bRun])
		expect(a.task.todoList).toEqual([{ id: "a-manual", content: "A manually edited", status: "pending" }])
		expect(b.task.todoList).toEqual([expect.objectContaining({ content: "B initial" })])
		expect(a.task.say).toHaveBeenCalledWith("user_edit_todos", expect.stringContaining("A manually edited"))
		expect(b.task.say).not.toHaveBeenCalled()
		expect(setPendingTodoList(a.task, edits)).toBe(false)
	})

	it("rejects an edit when no approval is pending, including a resumed instance with the same task ID", async () => {
		const a = taskFixture("same-task-id")
		const resumed = taskFixture("same-task-id")
		const edits = [{ id: "manual", content: "Wrong instance", status: "pending" as const }]
		expect(setPendingTodoList(undefined, edits)).toBe(false)
		expect(setPendingTodoList(a.task, edits)).toBe(false)
		const running = a.tool.execute({ todos: "[-] Correct original task" }, a.task, a.callbacks)
		expect(setPendingTodoList(resumed.task, edits)).toBe(false)
		a.approval.settle(true)
		await running
		expect(a.task.todoList).toEqual([expect.objectContaining({ content: "Correct original task" })])
	})

	it("releases pending edits after a rejected approval promise and accepts a later approval", async () => {
		const a = taskFixture("task-a")
		vi.mocked(a.callbacks.askApproval).mockRejectedValueOnce(new Error("cancelled approval"))
		await a.tool.execute({ todos: "[-] Cancelled stage" }, a.task, a.callbacks)
		expect(setPendingTodoList(a.task, [])).toBe(false)
		vi.mocked(a.callbacks.askApproval).mockResolvedValueOnce(true)
		await a.tool.execute({ todos: "[-] Fresh stage" }, a.task, a.callbacks)
		expect(a.task.todoList).toEqual([expect.objectContaining({ content: "Fresh stage" })])
	})

	it("does not allow a second overlapping approval to replace a pending approval in the same task", async () => {
		const a = taskFixture("task-a")
		const running = a.tool.execute({ todos: "[-] First stage" }, a.task, a.callbacks)
		await a.tool.execute({ todos: "[-] Overlapping stage" }, a.task, a.callbacks)
		expect(a.callbacks.askApproval).toHaveBeenCalledTimes(1)
		expect(a.callbacks.handleError).toHaveBeenCalledWith(
			"update todo list",
			expect.objectContaining({ message: expect.stringContaining("already pending") }),
		)
		a.approval.settle(true)
		await running
		expect(a.task.todoList).toEqual([expect.objectContaining({ content: "First stage" })])
	})
})
