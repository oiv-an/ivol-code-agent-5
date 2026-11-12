import { render, screen, fireEvent } from "@/utils/test-utils"

import TaskItem, { defaultTitleDraft } from "../TaskItem" // kilocode_change
import { vscode } from "@/utils/vscode" // kilocode_change

vi.mock("@src/utils/vscode")
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@/utils/format", () => ({
	formatTimeAgo: vi.fn(() => "2 hours ago"),
	formatDate: vi.fn(() => "January 15 at 2:30 PM"),
	formatLargeNumber: vi.fn((num: number) => num.toString()),
}))

const mockTask = {
	id: "1",
	number: 1,
	task: "Test task",
	ts: Date.now(),
	tokensIn: 100,
	tokensOut: 50,
	totalCost: 0.002,
	workspace: "/test/workspace",
}

describe("TaskItem", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	// kilocode_change start
	it.each(["compact", "full"] as const)("renames a %s card without opening or editing its prompt", (variant) => {
		const { rerender } = render(<TaskItem item={{ ...mockTask, title: "Custom title" }} variant={variant} />)
		expect(screen.getByTestId("task-content")).toHaveTextContent("Custom title")
		fireEvent.click(screen.getByTestId("rename-task-button"))
		const input = screen.getByRole("textbox", { name: "history:renameTask" })
		expect(input).toHaveValue("Custom title")
		fireEvent.change(input, { target: { value: "  New title  " } })
		fireEvent.submit(input.closest("form")!)
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "renameTaskWithId",
			taskId: "1",
			text: "New title",
		})
		expect(mockTask.task).toBe("Test task")
		rerender(<TaskItem item={{ ...mockTask, title: "New title" }} variant={variant} />)
		expect(screen.getByTestId("task-content")).toHaveTextContent("New title")
	})

	it("cancels a title draft with Escape and clears a title without changing the prompt", () => {
		const { rerender } = render(<TaskItem item={{ ...mockTask, title: "Custom title" }} variant="compact" />)
		fireEvent.click(screen.getByTestId("rename-task-button"))
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Discard me" } })
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" })
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(screen.getByTestId("task-content")).toHaveTextContent("Custom title")
		fireEvent.click(screen.getByTestId("rename-task-button"))
		expect(screen.getByRole("textbox")).toHaveValue("Custom title")
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "  " } })
		fireEvent.click(screen.getByRole("button", { name: "settings:common.save" }))
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "renameTaskWithId", taskId: "1", text: "" })
		rerender(<TaskItem item={{ ...mockTask, title: "" }} variant="compact" />)
		expect(screen.getByTestId("task-content")).toHaveTextContent("Test task")
	})

	it("starts renaming an untitled task with a huge prompt from an editable short excerpt", () => {
		const hugeTask = `\n  First line of the prompt  \n${"x".repeat(50_000)}`
		render(<TaskItem item={{ ...mockTask, task: hugeTask }} variant="compact" />)
		fireEvent.click(screen.getByTestId("rename-task-button"))
		const input = screen.getByRole("textbox", { name: "history:renameTask" })
		expect(input).toHaveValue("First line of the prompt")
		fireEvent.change(input, { target: { value: "Short name" } })
		fireEvent.submit(input.closest("form")!)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "renameTaskWithId", taskId: "1", text: "Short name" })
	})

	it("bounds the default title draft for a single huge line", () => {
		expect(defaultTitleDraft("y".repeat(10_000))).toHaveLength(200)
		expect(defaultTitleDraft("")).toBe("")
	})

	it("renders a title as text, not HTML, and preserves compact delete behavior", () => {
		const onDelete = vi.fn()
		render(
			<TaskItem
				item={{ ...mockTask, title: "<img src=x onerror=alert(1)>" }}
				variant="compact"
				onDelete={onDelete}
			/>,
		)
		expect(screen.getByTestId("task-content").querySelector("img")).toBeNull()
		fireEvent.click(screen.getByTestId("delete-task-button"))
		expect(onDelete).toHaveBeenCalledWith("1")
		expect(vscode.postMessage).not.toHaveBeenCalled()
		fireEvent.click(screen.getByTestId("delete-task-button"), { shiftKey: true })
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "deleteTaskWithId", text: "1" })
	})
	// kilocode_change end

	it("does not render cost for zero cost", () => {
		const zeroCostTask = { ...mockTask, totalCost: 0.0 }
		render(
			<TaskItem
				item={zeroCostTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		expect(screen.getByText("Test task")).toBeInTheDocument()
		// The component does not render cost element when totalCost is 0 (falsy check)
		expect(screen.queryByTestId("cost-footer-compact")).not.toBeInTheDocument()
	})

	it("renders low cost information", () => {
		// Uses mockTask.totalCost (0.002)
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		expect(screen.getByText("Test task")).toBeInTheDocument()
		// The component shows 0.0020 for small amounts (4 decimal places via formatCost)
		const costElement = screen.getByTestId("cost-footer-compact")
		expect(costElement.textContent).toContain("0.0020")
	})

	it("renders high cost information", () => {
		const highCostTask = { ...mockTask, totalCost: 0.0523 }
		render(
			<TaskItem
				item={highCostTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		expect(screen.getByText("Test task")).toBeInTheDocument()
		// The component shows 0.05 for high amounts (2 decimal places via formatCost)
		const costElement = screen.getByTestId("cost-footer-compact")
		expect(costElement.textContent).toContain("0.05")
	})

	it("handles selection in selection mode", () => {
		const onToggleSelection = vi.fn()
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={onToggleSelection}
				isSelectionMode={true}
			/>,
		)

		const checkbox = screen.getByRole("checkbox")
		fireEvent.click(checkbox)

		expect(onToggleSelection).toHaveBeenCalledWith("1", true)
	})

	it("shows action buttons", () => {
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		// Should show copy and export buttons
		expect(screen.getByTestId("copy-prompt-button")).toBeInTheDocument()
		expect(screen.getByTestId("export")).toBeInTheDocument()
	})

	it("displays time ago information", () => {
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		// Should display time ago format
		expect(screen.getByText(/ago/)).toBeInTheDocument()
	})

	it("applies hover effect class", () => {
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		const taskItem = screen.getByTestId("task-item-1")
		expect(taskItem).toHaveClass("hover:bg-vscode-list-hoverBackground")
	})
})
