// npx vitest core/tools/__tests__/useMcpToolTool.spec.ts

import { useMcpToolTool } from "../UseMcpToolTool"
import { Task } from "../../task/Task"
import { ToolUse } from "../../../shared/tools"
import { formatResponse } from "../../prompts/responses" // kilocode_change

// Mock dependencies
vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolResult: vi.fn((result: string) => `Tool result: ${result}`),
		toolError: vi.fn((error: string) => `Tool error: ${error}`),
		invalidMcpToolArgumentError: vi.fn((server: string, tool: string) => `Invalid args for ${server}:${tool}`),
		unknownMcpToolError: vi.fn((server: string, tool: string, availableTools: string[]) => {
			const toolsList = availableTools.length > 0 ? availableTools.join(", ") : "No tools available"
			return `Tool '${tool}' does not exist on server '${server}'. Available tools: ${toolsList}`
		}),
		unknownMcpServerError: vi.fn((server: string, availableServers: string[]) => {
			const list = availableServers.length > 0 ? availableServers.join(", ") : "No servers available"
			return `Server '${server}' is not configured. Available servers: ${list}`
		}),
	},
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string, params?: any) => {
		if (key === "mcp:errors.invalidJsonArgument" && params?.toolName) {
			return `Roo tried to use ${params.toolName} with an invalid JSON argument. Retrying...`
		}
		if (key === "mcp:errors.toolNotFound" && params) {
			return `Tool '${params.toolName}' does not exist on server '${params.serverName}'. Available tools: ${params.availableTools}`
		}
		if (key === "mcp:errors.serverNotFound" && params) {
			return `MCP server '${params.serverName}' is not configured. Available servers: ${params.availableServers}`
		}
		return key
	}),
}))

describe("useMcpToolTool", () => {
	let mockTask: Partial<Task>
	let mockAskApproval: ReturnType<typeof vi.fn>
	let mockHandleError: ReturnType<typeof vi.fn>
	let mockPushToolResult: ReturnType<typeof vi.fn>
	let mockRemoveClosingTag: ReturnType<typeof vi.fn>
	let mockProviderRef: any

	beforeEach(() => {
		mockAskApproval = vi.fn()
		mockHandleError = vi.fn()
		mockPushToolResult = vi.fn()
		mockRemoveClosingTag = vi.fn((tag: string, value?: string) => value || "")

		mockProviderRef = {
			deref: vi.fn().mockReturnValue({
				getMcpHub: vi.fn().mockReturnValue({
					callTool: vi.fn(),
					getAllServers: vi.fn().mockReturnValue([]),
				}),
				postMessageToWebview: vi.fn(),
				getState: vi.fn().mockResolvedValue({
					allowVeryLargeReads: false,
					maxReadFileLine: 1000,
				}),
			}),
		}

		mockTask = {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			sayAndCreateMissingParamError: vi.fn(),
			say: vi.fn(),
			ask: vi.fn(),
			lastMessageTs: 123456789,
			providerRef: mockProviderRef,
			api: {
				getModel: vi.fn().mockReturnValue({
					id: "claude-3",
					info: {
						contextWindow: 200000,
					},
				}),
				countTokens: vi.fn().mockResolvedValue(100),
				createMessage: vi.fn().mockResolvedValue({ text: "mock response" }),
			},
		}
	})

	describe("parameter validation", () => {
		it("should handle missing server_name", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					tool_name: "test_tool",
					arguments: "{}",
				},
				partial: false,
			}

			mockTask.sayAndCreateMissingParamError = vi.fn().mockResolvedValue("Missing server_name error")

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				removeClosingTag: mockRemoveClosingTag,
				toolProtocol: "xml",
			})

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("use_mcp_tool", "server_name")
			expect(mockPushToolResult).toHaveBeenCalledWith("Missing server_name error")
		})

		it("should handle missing tool_name", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					arguments: "{}",
				},
				partial: false,
			}

			mockTask.sayAndCreateMissingParamError = vi.fn().mockResolvedValue("Missing tool_name error")

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				removeClosingTag: mockRemoveClosingTag,
				toolProtocol: "xml",
			})

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("use_mcp_tool", "tool_name")
			expect(mockPushToolResult).toHaveBeenCalledWith("Missing tool_name error")
		})

		it("should handle invalid JSON arguments", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: "invalid json",
				},
				partial: false,
			}

			// Mock server exists so we get to the JSON validation step
			const mockServers = [
				{
					name: "test_server",
					tools: [{ name: "test_tool", description: "Test Tool" }],
				},
			]

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue(mockServers),
					callTool: vi.fn(),
				}),
				postMessageToWebview: vi.fn(),
			})

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				removeClosingTag: mockRemoveClosingTag,
				toolProtocol: "xml",
			})

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("invalid JSON argument"))
			expect(mockPushToolResult).toHaveBeenCalledWith("Tool error: Invalid args for test_server:test_tool")
		})
	})

	describe("partial requests", () => {
		// kilocode_change: the host asks once after a complete browser request, including custom server names.
		it.each(["browseros-neo", "custom-browser"])("defers partial browser consent for %s", async (serverName) => {
			const hub = mockProviderRef.deref().getMcpHub()
			hub.isBrowserOSServer = vi.fn().mockReturnValue(true)
			await useMcpToolTool.handlePartial(mockTask as Task, {
				type: "tool_use",
				name: "use_mcp_tool",
				params: { server_name: serverName, tool_name: "snapshot", arguments: "{}" },
				partial: true,
			})
			expect(hub.isBrowserOSServer).toHaveBeenCalledWith(serverName)
			expect(mockTask.ask).not.toHaveBeenCalled()
			expect(hub.callTool).not.toHaveBeenCalled()
		})

		it("should handle partial requests", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: "{}",
				},
				partial: true,
			}

			mockTask.ask = vi.fn().mockResolvedValue(true)

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				removeClosingTag: mockRemoveClosingTag,
				toolProtocol: "xml",
			})

			expect(mockTask.ask).toHaveBeenCalledWith("use_mcp_server", expect.stringContaining("use_mcp_tool"), true)
		})
	})

	describe("successful execution", () => {
		// kilocode_change: task-scoped browser consent does not bypass the actual MCP execution guard.
		it.each([true, false])("uses explicit browser task consent only when present (%s)", async (consent) => {
			const hub = mockProviderRef.deref().getMcpHub()
			hub.getAllServers.mockReturnValue([{ name: "browser", tools: [{ name: "snapshot" }] }])
			hub.canAutoApproveBrowserOSTool = vi.fn().mockReturnValue(consent)
			hub.callTool.mockResolvedValue({ content: [{ type: "text", text: "Page" }] })
			mockAskApproval.mockResolvedValue(true)
			await useMcpToolTool.execute(
				{ server_name: "browser", tool_name: "snapshot", arguments: { page: 2 } },
				mockTask as Task,
				{
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					removeClosingTag: mockRemoveClosingTag,
					toolProtocol: "native",
				},
			)
			expect(mockHandleError).not.toHaveBeenCalled()
			expect(mockAskApproval).toHaveBeenCalledTimes(consent ? 0 : 1)
			expect(hub.callTool).toHaveBeenCalledWith("browser", "snapshot", { page: 2 }, undefined, mockTask)
			if (consent)
				expect(mockTask.say).toHaveBeenCalledWith("text", expect.stringContaining("browser control enabled"))
		})

		// kilocode_change: preparation must finish before approval and dispatch of the original action.
		it.each([true, false])("prepares browser access before dispatch (allowed=%s)", async (allowed) => {
			const hub = mockProviderRef.deref().getMcpHub()
			let prepared = false
			hub.prepareBrowserOSInvocation = vi.fn(async () => {
				prepared = true
				return allowed
			})
			hub.getAllServers.mockReturnValue([{ name: "browseros-neo", tools: [{ name: "tabs" }] }])
			hub.canAutoApproveBrowserOSTool = vi.fn(() => prepared && allowed)
			hub.callTool.mockResolvedValue({ content: [{ type: "text", text: "Created" }] })
			const args = { action: "new", url: "https://example.com" }
			await useMcpToolTool.execute(
				{ server_name: "browseros-neo", tool_name: "tabs", arguments: args },
				mockTask as Task,
				{
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					removeClosingTag: mockRemoveClosingTag,
					toolProtocol: "native",
				},
			)
			expect(hub.prepareBrowserOSInvocation).toHaveBeenCalledWith("browseros-neo", mockTask)
			expect(mockAskApproval).not.toHaveBeenCalled()
			expect(mockHandleError).not.toHaveBeenCalled()
			expect(hub.callTool).toHaveBeenCalledTimes(allowed ? 1 : 0)
			if (allowed) expect(hub.callTool).toHaveBeenCalledWith("browseros-neo", "tabs", args, undefined, mockTask)
			else expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("No browser action was sent"))
		})

		// kilocode_change: MCP browser screenshots must reach both history and the model.
		it("preserves supported image results and omits unsupported image formats", async () => {
			const hub = mockProviderRef.deref().getMcpHub()
			hub.getAllServers.mockReturnValue([{ name: "browser", tools: [{ name: "screenshot" }] }])
			hub.callTool.mockResolvedValue({
				content: [
					{ type: "text", text: "Page screenshot" },
					{ type: "image", mimeType: "image/png", data: "YQ==" },
					{ type: "image", mimeType: "image/svg+xml", data: "YQ==" },
				],
			})
			mockAskApproval.mockResolvedValue(true)
			await useMcpToolTool.execute({ server_name: "browser", tool_name: "screenshot" }, mockTask as Task, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				removeClosingTag: mockRemoveClosingTag,
				toolProtocol: "native",
			})
			expect(mockHandleError).not.toHaveBeenCalled()
			// kilocode_change: grant ownership must use the calling instance, including native tool execution.
			expect(hub.callTool).toHaveBeenCalledWith("browser", "screenshot", undefined, undefined, mockTask)
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_response", expect.stringContaining("omitted"), [
				"data:image/png;base64,YQ==",
			])
			expect(formatResponse.toolResult).toHaveBeenCalledWith(expect.stringContaining("Page screenshot"), [
				"data:image/png;base64,YQ==",
			])
		})

		it("should execute tool successfully with valid parameters", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: '{"param": "value"}',
				},
				partial: false,
			}

			mockAskApproval.mockResolvedValue(true)

			const mockToolResult = {
				content: [{ type: "text", text: "Tool executed successfully" }],
				isError: false,
			}

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					callTool: vi.fn().mockResolvedValue(mockToolResult),
				}),
				postMessageToWebview: vi.fn(),
				getState: vi.fn().mockResolvedValue({
					allowVeryLargeReads: false,
					maxReadFileLine: 1000,
				}),
			})

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				removeClosingTag: mockRemoveClosingTag,
				toolProtocol: "xml",
			})

			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockAskApproval).toHaveBeenCalled()
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_request_started")
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_response", "Tool executed successfully")
			expect(mockPushToolResult).toHaveBeenCalledWith("Tool result: Tool executed successfully")
		})

		it("should handle user rejection", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: "{}",
				},
				partial: false,
			}

			// Use a real advertised tool so rejection is independent of provider lookup count.
			mockProviderRef
				.deref()
				.getMcpHub()
				.getAllServers.mockReturnValue([{ name: "test_server", tools: [{ name: "test_tool" }] }])

			mockAskApproval.mockResolvedValue(false)

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				removeClosingTag: mockRemoveClosingTag,
				toolProtocol: "xml",
			})

			expect(mockTask.say).not.toHaveBeenCalledWith("mcp_server_request_started")
			expect(mockPushToolResult).not.toHaveBeenCalled()
		})
	})

	describe("error handling", () => {
		it("should handle unexpected errors", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					tool_name: "test_tool",
				},
				partial: false,
			}

			// Ensure validation passes so askApproval is reached and throws
			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi
						.fn()
						.mockReturnValue([
							{ name: "test_server", tools: [{ name: "test_tool", description: "desc" }] },
						]),
					callTool: vi.fn(),
				}),
				postMessageToWebview: vi.fn(),
			})

			const error = new Error("Unexpected error")
			mockAskApproval.mockRejectedValue(error)

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				removeClosingTag: mockRemoveClosingTag,
				toolProtocol: "xml",
			})

			expect(mockHandleError).toHaveBeenCalledWith("executing MCP tool", error)
		})

		it("should reject unknown tool names", async () => {
			// Reset consecutiveMistakeCount for this test
			mockTask.consecutiveMistakeCount = 0

			const mockServers = [
				{
					name: "test-server",
					tools: [
						{ name: "existing-tool-1", description: "Tool 1" },
						{ name: "existing-tool-2", description: "Tool 2" },
					],
				},
			]

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue(mockServers),
					callTool: vi.fn(),
				}),
				postMessageToWebview: vi.fn(),
			})

			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test-server",
					tool_name: "non-existing-tool",
					arguments: JSON.stringify({ test: "data" }),
				},
				partial: false,
			}

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				removeClosingTag: mockRemoveClosingTag,
				toolProtocol: "xml",
			})

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("does not exist"))
			// Check that the error message contains available tools
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("existing-tool-1"))
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("existing-tool-2"))
		})

		it("should handle server with no tools", async () => {
			// Reset consecutiveMistakeCount for this test
			mockTask.consecutiveMistakeCount = 0

			const mockServers = [
				{
					name: "test-server",
					tools: [],
				},
			]

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue(mockServers),
					callTool: vi.fn(),
				}),
				postMessageToWebview: vi.fn(),
			})

			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test-server",
					tool_name: "any-tool",
					arguments: JSON.stringify({ test: "data" }),
				},
				partial: false,
			}

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				removeClosingTag: mockRemoveClosingTag,
				toolProtocol: "xml",
			})

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("does not exist"))
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("No tools available"))
		})

		it("should allow valid tool names", async () => {
			// Reset consecutiveMistakeCount for this test
			mockTask.consecutiveMistakeCount = 0

			const mockServers = [
				{
					name: "test-server",
					tools: [{ name: "valid-tool", description: "Valid Tool" }],
				},
			]

			const mockToolResult = {
				content: [{ type: "text", text: "Tool executed successfully" }],
			}

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue(mockServers),
					callTool: vi.fn().mockResolvedValue(mockToolResult),
				}),
				postMessageToWebview: vi.fn(),
			})

			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test-server",
					tool_name: "valid-tool",
					arguments: JSON.stringify({ test: "data" }),
				},
				partial: false,
			}

			mockAskApproval.mockResolvedValue(true)

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				removeClosingTag: mockRemoveClosingTag,
				toolProtocol: "xml",
			})

			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
		})

		it("should reject unknown server names with available servers listed", async () => {
			// Arrange
			mockTask.consecutiveMistakeCount = 0

			const mockServers = [{ name: "s1", tools: [] }]
			const callToolMock = vi.fn()

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue(mockServers),
					callTool: callToolMock,
				}),
				postMessageToWebview: vi.fn(),
			})

			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "unknown",
					tool_name: "any-tool",
					arguments: "{}",
				},
				partial: false,
			}

			// Act
			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				removeClosingTag: mockRemoveClosingTag,
				toolProtocol: "xml",
			})

			// Assert
			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("not configured"))
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("s1"))
			expect(callToolMock).not.toHaveBeenCalled()
			expect(mockAskApproval).not.toHaveBeenCalled()
		})

		it("should reject unknown server names when no servers are available", async () => {
			// Arrange
			mockTask.consecutiveMistakeCount = 0

			const callToolMock = vi.fn()
			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue([]),
					callTool: callToolMock,
				}),
				postMessageToWebview: vi.fn(),
			})

			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "unknown",
					tool_name: "any-tool",
					arguments: "{}",
				},
				partial: false,
			}

			// Act
			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				removeClosingTag: mockRemoveClosingTag,
				toolProtocol: "xml",
			})

			// Assert
			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("not configured"))
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("No servers available"))
			expect(callToolMock).not.toHaveBeenCalled()
			expect(mockAskApproval).not.toHaveBeenCalled()
		})
	})
})
