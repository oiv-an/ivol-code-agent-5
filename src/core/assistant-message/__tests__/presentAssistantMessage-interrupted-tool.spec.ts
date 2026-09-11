// kilocode_change - new file
import { presentAssistantMessage } from "../presentAssistantMessage"
import { validateToolUse } from "../../tools/validateToolUse"

vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({ validateToolUse: vi.fn() }))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureToolUsage: vi.fn(), captureConsecutiveMistakeError: vi.fn() } },
}))

describe("presentAssistantMessage - interrupted native tool", () => {
	it("does not execute or checkpoint a truncated write_to_file call", async () => {
		const task: any = {
			taskId: "interrupted-task",
			instanceId: "instance",
			abort: false,
			presentAssistantMessageLocked: false,
			presentAssistantMessageHasPendingUpdates: false,
			currentStreamingContentIndex: 0,
			assistantMessageContent: [
				{
					type: "tool_use",
					id: "toolu_interrupted_write",
					name: "write_to_file",
					params: { path: "CENTRAL_BACKUP_MASTER.md" },
					partial: false,
					nativeArgumentsIncomplete: true,
				},
			],
			userMessageContent: [],
			userMessageContentReady: false,
			didCompleteReadingStream: true,
			didRejectTool: false,
			didAlreadyUseTool: false,
			diffEnabled: false,
			consecutiveMistakeCount: 0,
			clineMessages: [],
			api: { getModel: () => ({ id: "test-model", info: {} }) },
			browserSession: { closeBrowser: vi.fn() },
			checkpointSave: vi.fn(),
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			toolRepetitionDetector: { check: vi.fn().mockReturnValue({ allowExecution: true }) },
			providerRef: {
				deref: () => ({ getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [] }) }),
			},
			say: vi.fn(),
			askState: {},
		}
		task.pushToolResultToUserContent = vi.fn((result: any) => {
			task.userMessageContent.push(result)
			return true
		})

		await presentAssistantMessage(task)

		expect(validateToolUse).not.toHaveBeenCalled()
		expect(task.checkpointSave).not.toHaveBeenCalled()
		expect(task.browserSession.closeBrowser).not.toHaveBeenCalled()
		expect(task.recordToolError).toHaveBeenCalledWith("write_to_file", "incomplete_native_arguments")
		expect(task.userMessageContent).toContainEqual(
			expect.objectContaining({
				type: "tool_result",
				tool_use_id: "toolu_interrupted_write",
				content: expect.stringContaining("incomplete_tool_call"),
			}),
		)
		expect(task.consecutiveMistakeCount).toBe(0)
		expect(task.userMessageContentReady).toBe(true)
	})
})
