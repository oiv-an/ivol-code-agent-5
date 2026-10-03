import { SearchChatHistoryTool } from "../SearchChatHistoryTool"
import type { Task } from "../../../task/Task"
import type { ToolCallbacks } from "../../BaseTool"
import { getNativeTools } from "../../../prompts/tools/native-tools"
import { isToolAllowedForMode } from "../../validateToolUse"

describe("SearchChatHistoryTool", () => {
	it("registers the native tool in the read group", () => {
		expect(
			getNativeTools().some((tool) => tool.type === "function" && tool.function.name === "search_chat_history"),
		).toBe(true)
		expect(isToolAllowedForMode("search_chat_history", "code", [])).toBe(true)
	})
	it("uses only the supplied executing task and returns bounded context", async () => {
		const tool = new SearchChatHistoryTool()
		const task = { clineMessages: [{ ts: 123, type: "say", text: "needle in this task" }] } as unknown as Task
		const pushToolResult = vi.fn()
		const callbacks = { pushToolResult } as unknown as ToolCallbacks
		await tool.execute(tool.parseLegacy({ query: "needle", message_ts: "123" }), task, callbacks)
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("needle in this task"))
		pushToolResult.mockClear()
		await tool.execute({ query: "needle", message_ts: 999 }, task, callbacks)
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining('"messages":[]'))
	})
	it("rejects invalid cursors before searching", async () => {
		const pushToolResult = vi.fn()
		await new SearchChatHistoryTool().execute(
			{ query: "needle", before: NaN },
			{} as Task,
			{ pushToolResult } as unknown as ToolCallbacks,
		)
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("finite"))
	})
})
