import { Task } from "../Task"
import type { ClineAsk } from "@roo-code/types" // kilocode_change
// kilocode_change start
import { EventEmitter } from "node:events"
import { TelegramTaskBridge } from "../../../services/kilocode/telegram/TelegramTaskBridge"
import type { TelegramLocalClient } from "../../../services/kilocode/telegram/TelegramLocalClient"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { askFollowupQuestionTool } from "../../tools/AskFollowupQuestionTool"
// kilocode_change end

// Keep this test focused: if a queued message arrives while Task.ask() is blocked,
// it should be consumed and used to fulfill the ask.

describe("Task.ask queued message drain", () => {
	// kilocode_change start - exercise the real Task response/queue and tool image formatting.
	it.each(["screenshot caption", ""].flatMap((text) => [false, true].map((queued) => ({ text, queued }))))(
		"passes Telegram images into chat feedback and model blocks (caption=$text, queued=$queued)",
		async ({ text, queued }) => {
			const task = Object.create(Task.prototype) as Task
			const events = new EventEmitter()
			const images = ["data:image/png;base64,iVBORw0KGgoA"]
			Object.assign(task, {
				taskId: "task",
				instanceId: "instance",
				abort: false,
				clineMessages: [],
				messageQueueService: new MessageQueueService(),
				on: events.on.bind(events),
				off: events.off.bind(events),
				emit: events.emit.bind(events),
				addToClineMessages: vi.fn(async (message) => {
					task.clineMessages.push(message)
				}),
				updateClineMessage: vi.fn(async () => {}),
				saveClineMessages: vi.fn(async () => {}),
				cancelAutoApprovalTimeout: vi.fn(),
				checkpointSave: vi.fn(async () => {}),
				say: vi.fn(async () => {}),
				providerRef: { deref: () => undefined },
			})
			const client = Object.assign(new EventEmitter(), { request: vi.fn(async () => {}), close: vi.fn() })
			const bridge = new TelegramTaskBridge(
				task,
				client as unknown as TelegramLocalClient,
				{
					key: "k",
					clientId: "c",
					taskId: "task",
					epoch: "epoch",
					chatId: 1,
					ownerId: 1,
					threadId: 1,
					activatedAt: 0,
					minimumUpdateId: 0,
				},
				() => true,
				vi.fn(),
				{ approve: "yes", deny: "no", thinking: "Thinking…", confirmation: "Review in IDE" },
			)
			const input = { kind: "message", taskId: "task", epoch: "epoch", updateId: 1, text, images }
			const pushToolResult = vi.fn(),
				handleError = vi.fn()
			try {
				if (queued) {
					client.emit("input", input)
					client.emit("input", input)
					expect(task.queuedMessages).toEqual([expect.objectContaining({ text, images, source: "telegram" })])
				}
				const execution = askFollowupQuestionTool.execute({ question: "Screenshot?", follow_up: [] }, task, {
					askApproval: vi.fn(),
					handleError,
					pushToolResult,
					removeClosingTag: vi.fn(),
					toolProtocol: "xml",
				})
				if (!queued) {
					await vi.waitFor(() => expect(task.getRemotePendingAsk()).toBeDefined())
					client.emit("input", input)
					client.emit("input", input)
				}
				await execution
				expect(handleError).not.toHaveBeenCalled()
				expect(task.say).toHaveBeenCalledExactlyOnceWith("user_feedback", text, images)
				expect(pushToolResult).toHaveBeenCalledWith(
					expect.arrayContaining([
						expect.objectContaining({
							type: "image",
							source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoA" },
						}),
					]),
				)
				expect(task.queuedMessages).toHaveLength(0)
			} finally {
				bridge.dispose()
			}
		},
	)
	// kilocode_change end
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

	// kilocode_change start: remote text is context, never implicit authorization.
	it.each(["tool", "command", "browser_action_launch", "use_mcp_server"] as ClineAsk[])(
		"does not approve %s from Telegram text and rejects stale remote buttons",
		async (ask) => {
			const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
			const task = Object.create(Task.prototype) as Task
			Object.assign(task, {
				abort: false,
				clineMessages: [],
				messageQueueService: new MessageQueueService(),
				addToClineMessages: vi.fn(async (message) => {
					task.clineMessages.push(message)
				}),
				saveClineMessages: vi.fn(async () => {}),
				updateClineMessage: vi.fn(async () => {}),
				cancelAutoApprovalTimeout: vi.fn(),
				checkpointSave: vi.fn(async () => {}),
				emit: vi.fn(),
				providerRef: { deref: () => undefined },
			})
			task.messageQueueService.addMessage(
				"Additional context",
				["data:image/png;base64,iVBORw0KGgoA"],
				"telegram",
			)
			let settled = false
			const pending = task.ask(ask, "Decision").then((result) => {
				settled = true
				return result
			})
			await new Promise((resolve) => setTimeout(resolve, 150))
			const wasSettled = settled
			const remaining = task.queuedMessages.length
			const question = task.getRemotePendingAsk()
			expect(task.respondToRemoteText("yes", ["data:image/png;base64,iVBORw0KGgoA"])).toBe(false)
			const accepted = question ? task.respondToRemoteAsk(question.ts, true) : false
			if (!accepted) task.handleWebviewAskResponse("yesButtonClicked")
			await pending
			expect(wasSettled).toBe(false)
			expect(remaining).toBe(1)
			expect(accepted).toBe(true)
			expect(task.getRemotePendingAsk()).toBeUndefined()
			expect(task.respondToRemoteAsk(question!.ts, true)).toBe(false)
		},
	)
	it.each(["followup", "condense"] as const)(
		"accepts explicit Telegram feedback for %s without draining old queued work",
		async (ask) => {
			const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
			const task = Object.create(Task.prototype) as Task
			Object.assign(task, {
				abort: false,
				ordinaryPreparationDecision: true,
				clineMessages: [],
				messageQueueService: new MessageQueueService(),
				addToClineMessages: vi.fn(async (message) => {
					task.clineMessages.push(message)
				}),
				cancelAutoApprovalTimeout: vi.fn(),
				emit: vi.fn(),
				providerRef: { deref: () => undefined },
			})
			task.messageQueueService.addMessage("older work")
			const pending = task.ask(ask, "Decision")
			await vi.waitFor(() => expect(task.getRemotePendingAsk()).toBeDefined())
			expect(task.respondToRemoteText("explicit answer")).toBe(true)
			expect(await pending).toMatchObject({ response: "messageResponse", text: "explicit answer" })
			expect(task.queuedMessages).toHaveLength(1)
			expect(task.respondToRemoteText("duplicate")).toBe(false)
		},
	)
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
