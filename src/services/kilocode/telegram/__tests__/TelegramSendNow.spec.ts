import { EventEmitter } from "node:events"
import { TelegramTaskBridge } from "../TelegramTaskBridge"
import { MessageQueueService } from "../../../../core/message-queue/MessageQueueService"
import type { Task } from "../../../../core/task/Task"
import type { TelegramLocalClient } from "../TelegramLocalClient"
import type { TelegramRoute } from "../TelegramRouter"

const route: TelegramRoute = {
	key: "key",
	clientId: "client",
	taskId: "task",
	chatId: 123,
	ownerId: 123,
	threadId: 5,
	activatedAt: 0,
	minimumUpdateId: 0,
	epoch: "epoch",
}

function fixture(respond: boolean) {
	const queue = new MessageQueueService()
	const task = Object.assign(new EventEmitter(), {
		taskId: "task",
		instanceId: "instance",
		getRemotePendingAsk: () => undefined,
		respondToRemoteText: vi.fn(() => respond),
		messageQueueService: queue,
	})
	const client = Object.assign(new EventEmitter(), { request: vi.fn(async () => null), close: vi.fn() })
	const bridge = new TelegramTaskBridge(
		task as unknown as Task,
		client as unknown as TelegramLocalClient,
		route,
		() => true,
		vi.fn(),
		{ approve: "yes", deny: "no", thinking: "Thinking…", confirmation: "Review" },
	)
	const send = (updateId: number, text: string) =>
		client.emit("input", { kind: "message", taskId: "task", epoch: "epoch", updateId, text })
	return { task, queue, bridge, client, send }
}

describe("Telegram messages while the agent is working", () => {
	it("are queued as Send now and handed to the next model request", () => {
		const f = fixture(false)
		try {
			f.send(1, "also check the tests")
			expect(f.queue.messages).toHaveLength(1)
			expect(f.queue.messages[0]).toMatchObject({
				text: "also check the tests",
				source: "telegram",
				sendNow: true,
			})
			const taken = f.queue.takeSendNowMessages()
			expect(taken.map((message) => message.text)).toEqual(["also check the tests"])
			expect(f.queue.isEmpty()).toBe(true)
		} finally {
			f.bridge.dispose()
		}
	})

	it("answer a waiting question directly without queueing", () => {
		const f = fixture(true)
		try {
			f.send(1, "yes")
			expect(f.task.respondToRemoteText).toHaveBeenCalledWith("yes", undefined)
			expect(f.queue.isEmpty()).toBe(true)
		} finally {
			f.bridge.dispose()
		}
	})

	it("are not echoed back to the topic when the task records them", () => {
		const f = fixture(false)
		try {
			f.send(1, "from phone")
			f.task.emit("message", {
				action: "created",
				message: { ts: 10, type: "say", say: "user_feedback", text: "from phone" },
			})
			f.task.emit("message", {
				action: "created",
				message: { ts: 11, type: "say", say: "user_feedback", text: "typed in IDE" },
			})
			const dirty = (f.bridge as unknown as { dirty: Map<number, { text?: string }> }).dirty
			expect([...dirty.values()].map((message) => message.text)).toEqual(["👤 typed in IDE"])
		} finally {
			f.bridge.dispose()
		}
	})
})
