// kilocode_change - new file

import { presentAssistantMessage } from "../presentAssistantMessage"
import type { ToolCallbacks } from "../../tools/BaseTool"

const mocks = vi.hoisted(() => ({
	gatekeeper: vi.fn(),
	writeFile: vi.fn(),
	executeApprovedAction: vi.fn(),
}))

vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({ validateToolUse: vi.fn() }))
vi.mock("../../tools/WriteToFileTool", () => ({ writeToFileTool: { handle: mocks.writeFile } }))
vi.mock("../kilocode/gatekeeper", () => ({ evaluateGatekeeperApproval: mocks.gatekeeper }))
vi.mock("../kilocode/captureAskApprovalEvent", () => ({ captureAskApproval: vi.fn() }))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: { captureToolUsage: vi.fn(), captureConsecutiveMistakeError: vi.fn() },
	},
}))

describe("presentAssistantMessage - YOLO timer approval boundary", () => {
	let now: number
	let state: { yoloMode: boolean; yoloModeExpiresAt: number; mode: string; customModes: [] }
	let task: any

	beforeEach(() => {
		vi.clearAllMocks()
		now = 1_800_000_000_000
		vi.spyOn(Date, "now").mockImplementation(() => now)
		state = { yoloMode: true, yoloModeExpiresAt: now + 60_000, mode: "code", customModes: [] }
		mocks.gatekeeper.mockResolvedValue(true)
		mocks.writeFile.mockImplementation(async (_task: unknown, _block: unknown, callbacks: ToolCallbacks) => {
			if (await callbacks.askApproval("tool", "Write example.ts")) {
				mocks.executeApprovedAction()
				callbacks.pushToolResult("File written")
			}
		})
		task = {
			taskId: "timer-test-task",
			instanceId: "timer-test-instance",
			abort: false,
			presentAssistantMessageLocked: false,
			presentAssistantMessageHasPendingUpdates: false,
			currentStreamingContentIndex: 0,
			assistantMessageContent: [
				{
					type: "tool_use",
					id: "timer-test-tool",
					name: "write_to_file",
					params: { path: "example.ts", content: "new content" },
					partial: false,
				},
			],
			userMessageContent: [],
			userMessageContentReady: false,
			didCompleteReadingStream: true,
			didRejectTool: false,
			didAlreadyUseTool: false,
			diffEnabled: true,
			consecutiveMistakeCount: 0,
			clineMessages: [],
			api: { getModel: () => ({ id: "test-model", info: {} }) },
			browserSession: { closeBrowser: vi.fn().mockResolvedValue(undefined) },
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			checkpointSave: vi.fn().mockResolvedValue(undefined),
			toolRepetitionDetector: { check: vi.fn().mockReturnValue({ allowExecution: true }) },
			providerRef: { deref: () => ({ getState: async () => ({ ...state }) }) },
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "noButtonClicked" }),
		}
		task.pushToolResultToUserContent = vi.fn((result) => {
			task.userMessageContent.push(result)
			return true
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("continues an approved tool while the timer is still active", async () => {
		await presentAssistantMessage(task)
		expect(mocks.gatekeeper).toHaveBeenCalledTimes(1)
		expect(mocks.executeApprovedAction).toHaveBeenCalledTimes(1)
		expect(task.ask).not.toHaveBeenCalled()
	})

	it("asks the user without gatekeeper bypass after the deadline", async () => {
		now = state.yoloModeExpiresAt
		await presentAssistantMessage(task)
		expect(mocks.gatekeeper).not.toHaveBeenCalled()
		expect(task.ask).toHaveBeenCalledWith("tool", "Write example.ts", false, undefined, false)
		expect(mocks.executeApprovedAction).not.toHaveBeenCalled()
	})

	it.each(["expires", "disabled"] as const)(
		"rechecks permission after the gatekeeper waits and the timer is %s",
		async (change) => {
			let resolveGatekeeper!: (approved: boolean) => void
			mocks.gatekeeper.mockImplementation(() => new Promise<boolean>((resolve) => (resolveGatekeeper = resolve)))
			const running = presentAssistantMessage(task)
			await vi.waitFor(() => expect(mocks.gatekeeper).toHaveBeenCalledTimes(1))
			if (change === "expires") {
				now = state.yoloModeExpiresAt
			} else {
				state.yoloMode = false
			}
			resolveGatekeeper(true)
			await running
			expect(task.ask).toHaveBeenCalledWith("tool", "Write example.ts", false, undefined, false)
			expect(mocks.executeApprovedAction).not.toHaveBeenCalled()
			expect(task.didRejectTool).toBe(true)
		},
	)

	it("allows explicit user approval after the timer expires during the gatekeeper request", async () => {
		mocks.gatekeeper.mockImplementation(async () => {
			now = state.yoloModeExpiresAt
			return true
		})
		task.ask.mockResolvedValue({ response: "yesButtonClicked" })
		await presentAssistantMessage(task)
		expect(task.ask).toHaveBeenCalledTimes(1)
		expect(mocks.executeApprovedAction).toHaveBeenCalledTimes(1)
	})

	it("never authorizes a stopped task when a pending gatekeeper later approves", async () => {
		let resolveGatekeeper!: (approved: boolean) => void
		mocks.gatekeeper.mockImplementation(() => new Promise<boolean>((resolve) => (resolveGatekeeper = resolve)))
		const running = presentAssistantMessage(task)
		await vi.waitFor(() => expect(mocks.gatekeeper).toHaveBeenCalledTimes(1))
		task.abort = true
		resolveGatekeeper(true)
		await running
		expect(task.ask).not.toHaveBeenCalled()
		expect(mocks.executeApprovedAction).not.toHaveBeenCalled()
	})

	it("preserves the gatekeeper denial while a timer remains active", async () => {
		mocks.gatekeeper.mockResolvedValue(false)
		await presentAssistantMessage(task)
		expect(task.ask).not.toHaveBeenCalled()
		expect(mocks.executeApprovedAction).not.toHaveBeenCalled()
		expect(task.didRejectTool).toBe(true)
	})
})
