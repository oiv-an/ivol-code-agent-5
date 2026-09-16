import { Task } from "../Task"
import type { ClineAsk } from "@roo-code/types" // kilocode_change

// Keep this test focused: if a queued message arrives while Task.ask() is blocked,
// it should be consumed and used to fulfill the ask.

describe("Task.ask queued message drain", () => {
	// kilocode_change start - button-only prompts must preserve text queued before or during the question.
	it.each(
		(
			[
				"api_req_failed",
				"payment_required_prompt",
				"unauthorized_prompt",
				"promotion_model_sign_up_required_prompt",
				"invalid_model",
				"auto_approval_max_req_reached",
				"condense",
				"checkpoint_restore",
				"report_bug",
			] as ClineAsk[]
		).flatMap((ask) => [false, true].map((arrivesLater) => ({ ask, arrivesLater }))),
	)("keeps queued context for $ask (arrives later: $arrivesLater)", async ({ ask, arrivesLater }) => {
		const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
		const task = Object.create(Task.prototype) as Task
		Object.assign(task, {
			abort: false,
			clineMessages: [],
			messageQueueService: new MessageQueueService(),
			addToClineMessages: vi.fn(async () => {}),
			saveClineMessages: vi.fn(async () => {}),
			updateClineMessage: vi.fn(async () => {}),
			cancelAutoApprovalTimeout: vi.fn(),
			checkpointSave: vi.fn(async () => {}),
			emit: vi.fn(),
			providerRef: { deref: () => undefined },
		})
		if (!arrivesLater) task.messageQueueService.addMessage("Additional context", ["image.png"])
		let settled = false
		const pending = task.ask(ask, "Synthetic decision").then((result) => {
			settled = true
			return result
		})
		if (arrivesLater) {
			await new Promise((resolve) => setTimeout(resolve, 20))
			task.messageQueueService.addMessage("Additional context", ["image.png"])
		}
		await new Promise((resolve) => setTimeout(resolve, 150))
		const remaining = task.queuedMessages.length
		const settledWithoutDecision = settled
		// Always release the pending question before asserting, including on regression.
		task.handleWebviewAskResponse("yesButtonClicked")
		await pending
		expect(remaining).toBe(1)
		expect(settledWithoutDecision).toBe(false)
	})
	// kilocode_change end

	// kilocode_change start: preparation questions must remain stoppable without consuming queued work.
	it("rejects a pending preparation question when the task is stopped", async () => {
		const task = Object.create(Task.prototype) as Task
		Object.assign(task, {
			abort: false,
			clineMessages: [],
			ordinaryPreparationDecision: true,
			addToClineMessages: vi.fn(async () => {}),
			providerRef: { deref: () => undefined },
		})
		const pending = task.ask("followup", "Preparation decision", false)
		const rejected = expect(pending).rejects.toThrow("cancelled while waiting")
		Object.assign(task, { abort: true })
		await rejected
	})
	// kilocode_change end

	it("consumes queued message while blocked on followup ask", async () => {
		const task = Object.create(Task.prototype) as Task
		;(task as any).abort = false
		;(task as any).clineMessages = []
		;(task as any).askResponse = undefined
		;(task as any).askResponseText = undefined
		;(task as any).askResponseImages = undefined
		;(task as any).lastMessageTs = undefined

		// Message queue service exists in constructor; for unit test we can attach a real one.
		const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
		;(task as any).messageQueueService = new MessageQueueService()

		// Minimal stubs used by ask()
		;(task as any).addToClineMessages = vi.fn(async () => {})
		;(task as any).saveClineMessages = vi.fn(async () => {})
		;(task as any).updateClineMessage = vi.fn(async () => {})
		;(task as any).cancelAutoApprovalTimeout = vi.fn(() => {})
		;(task as any).checkpointSave = vi.fn(async () => {})
		;(task as any).emit = vi.fn()
		;(task as any).providerRef = { deref: () => undefined }

		const askPromise = task.ask("followup", "Q?", false)

		// Simulate webview queuing the user's selection text while the ask is pending.
		;(task as any).messageQueueService.addMessage("picked answer")

		const result = await askPromise
		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("picked answer")
	})
})
