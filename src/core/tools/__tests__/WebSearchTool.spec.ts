import { OpenAiCompatibleResponsesHandler } from "../../../api/providers/openai-responses"
import type { Task } from "../../task/Task"
import type { ToolUse } from "../../../shared/tools"

import { webSearchTool } from "../WebSearchTool"

describe("WebSearchTool", () => {
	const createCallbacks = () => ({
		askApproval: vi.fn(),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
		removeClosingTag: vi.fn((_tag: string, value?: string) => value ?? ""),
		toolProtocol: "native" as const,
	})

	const createTask = (overrides: Record<string, unknown> = {}) =>
		({
			taskId: "task-123",
			apiConfiguration: {
				apiProvider: "openai",
				openAiApiKey: "test-key",
				openAiBaseUrl: "https://example.com/v1",
				openAiModelId: "main-model",
				openAiWebSearchEnabled: true,
				openAiWebSearchModelId: "search-model",
			},
			currentRequestAbortController: new AbortController(),
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			recordToolError: vi.fn(),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing query"),
			...overrides,
		}) as unknown as Task

	const toolUse = (query: string): ToolUse<"web_search"> => ({
		type: "tool_use",
		name: "web_search",
		params: { query },
		nativeArgs: { query },
		partial: false,
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("runs the isolated Responses web-search worker and returns its sources", async () => {
		const searchWeb = vi.spyOn(OpenAiCompatibleResponsesHandler.prototype, "searchWeb").mockResolvedValue({
			text: "Current answer",
			sources: [{ title: "Example source", url: "https://example.com/source" }],
		})
		const callbacks = createCallbacks()
		const task = createTask()

		await webSearchTool.handle(task, toolUse("current information"), callbacks)

		expect(searchWeb).toHaveBeenCalledWith(
			"current information",
			"task-123",
			task.currentRequestAbortController?.signal,
		)
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		const result = JSON.parse(callbacks.pushToolResult.mock.calls[0][0] as string)
		expect(result).toMatchObject({
			status: "success",
			query: "current information",
			answer: "Current answer",
			sources: [{ title: "Example source", url: "https://example.com/source" }],
		})
	})

	it("refuses to run when web search is disabled", async () => {
		const searchWeb = vi.spyOn(OpenAiCompatibleResponsesHandler.prototype, "searchWeb")
		const callbacks = createCallbacks()
		const task = createTask({
			apiConfiguration: {
				apiProvider: "openai",
				openAiWebSearchEnabled: false,
			},
		})

		await webSearchTool.handle(task, toolUse("current information"), callbacks)

		expect(searchWeb).not.toHaveBeenCalled()
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(task.recordToolError).toHaveBeenCalledWith("web_search", expect.stringContaining("disabled"))
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
	})

	it("rejects an empty query before creating a Responses request", async () => {
		const searchWeb = vi.spyOn(OpenAiCompatibleResponsesHandler.prototype, "searchWeb")
		const callbacks = createCallbacks()
		const task = createTask()

		await webSearchTool.handle(task, toolUse("   "), callbacks)

		expect(searchWeb).not.toHaveBeenCalled()
		expect(task.sayAndCreateMissingParamError).toHaveBeenCalledWith("web_search", "query")
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("missing query")
	})

	it("supports the legacy parameter shape without nativeArgs", async () => {
		const searchWeb = vi.spyOn(OpenAiCompatibleResponsesHandler.prototype, "searchWeb").mockResolvedValue({
			text: "Legacy result",
			sources: [],
		})
		const callbacks = createCallbacks()
		const task = createTask()
		const block: ToolUse<"web_search"> = {
			type: "tool_use",
			name: "web_search",
			params: { query: " legacy query " },
			partial: false,
		}

		await webSearchTool.handle(task, block, callbacks)

		expect(searchWeb).toHaveBeenCalledWith("legacy query", "task-123", task.currentRequestAbortController?.signal)
	})

	it("caps a very large search result before adding it to conversation history", async () => {
		vi.spyOn(OpenAiCompatibleResponsesHandler.prototype, "searchWeb").mockResolvedValue({
			text: "x".repeat(60_000),
			sources: Array.from({ length: 20 }, (_, index) => ({
				title: `Source ${index}`,
				url: `https://example.com/${index}`,
			})),
		})
		const callbacks = createCallbacks()

		await webSearchTool.handle(createTask(), toolUse("large result"), callbacks)

		const result = JSON.parse(callbacks.pushToolResult.mock.calls[0][0] as string)
		expect(result.answer).toContain("[Search answer truncated by IVOL Code.]")
		expect(result.answer.length).toBeLessThan(49_000)
		expect(result.sources).toHaveLength(16)
		expect(result.truncated).toBe(true)
	})

	it("does not surface an error after the task cancels the search request", async () => {
		const cancelledError = new Error("cancelled")
		cancelledError.name = "AbortError"
		vi.spyOn(OpenAiCompatibleResponsesHandler.prototype, "searchWeb").mockRejectedValue(cancelledError)
		const callbacks = createCallbacks()
		const task = createTask({ abort: true })

		await webSearchTool.handle(task, toolUse("cancelled query"), callbacks)

		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})
})
