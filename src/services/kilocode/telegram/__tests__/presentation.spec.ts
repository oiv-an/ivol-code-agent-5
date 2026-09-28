import { EventEmitter } from "node:events"
import { RooCodeEventName, type ClineMessage } from "@roo-code/types"
import { telegramPresentation, telegramTopicTitle } from "../presentation"
import { TelegramTaskBridge } from "../TelegramTaskBridge"
import { TelegramCoordinator } from "../TelegramCoordinator"
import { splitTelegramText, TelegramApi } from "../TelegramApi"
import type { TelegramTopicStore } from "../TelegramTopicStore"
import type { TelegramLocalClient } from "../TelegramLocalClient"
import type { Task } from "../../../../core/task/Task"

it("formats concise titles and retains plain or structured questions without metadata", () => {
	expect(telegramTopicTitle("<task>Так, проверяй, исправь Telegram</task>", "Task")).toBe("исправь Telegram")
	expect(Array.from(telegramTopicTitle("😀".repeat(100), "Task"))).toHaveLength(56)
	expect(telegramTopicTitle(undefined, "Task")).toBe("Task")
	expect(
		telegramPresentation({
			ts: 1,
			type: "ask",
			ask: "followup",
			text: '{"question":"Which one?","follow_up":["a"]}',
		}),
	).toEqual({ kind: "text", text: "Which one?" })
	expect(telegramPresentation({ ts: 1, type: "ask", ask: "followup", text: "Which one?" }).text).toBe("Which one?")
	expect(telegramPresentation({ ts: 1, type: "ask", ask: "followup", text: '{"question":' }).kind).toBe("ignore")
})

it("coalesces activity, edits streaming replies, resumes thinking and never leaks stale approvals", async () => {
	vi.useFakeTimers()
	let pending: ClineMessage | undefined
	const task = Object.assign(new EventEmitter(), {
		taskId: "task",
		instanceId: "instance",
		getRemotePendingAsk: () => pending,
	})
	const client = Object.assign(new EventEmitter(), {
		request: vi.fn(async (_request: unknown) => null),
		close: vi.fn(),
	})
	const bridge = new TelegramTaskBridge(
		task as unknown as Task,
		client as unknown as TelegramLocalClient,
		{
			key: "key",
			clientId: "client",
			taskId: "task",
			chatId: 1,
			ownerId: 1,
			threadId: 1,
			activatedAt: 0,
			minimumUpdateId: 0,
			epoch: "epoch",
		},
		() => true,
		vi.fn(),
		{ approve: "yes", deny: "no", thinking: "Thinking…", confirmation: "Review in IDE" },
	)
	const emit = (message: ClineMessage) => task.emit(RooCodeEventName.Message, { message })
	const output = () =>
		client.request.mock.calls
			.map(
				([request]) =>
					request as unknown as { operation: string; text: string; messageId: string; approval?: unknown },
			)
			.filter((r) => r.operation === "publish")
	try {
		for (let ts = 1; ts < 5; ts++) emit({ ts, type: "say", say: "reasoning", text: "SECRET" })
		await vi.advanceTimersByTimeAsync(300)
		expect(output()).toHaveLength(1)
		emit({ ts: 5, type: "say", say: "text", text: "Hello", partial: true })
		await vi.advanceTimersByTimeAsync(300)
		emit({ ts: 5, type: "say", say: "text", text: "Hello world", partial: false })
		await vi.advanceTimersByTimeAsync(300)
		expect(new Set(output().map((r) => r.messageId)).size).toBe(1)
		emit({ ts: 1, type: "say", say: "api_req_finished", text: "SECRET" })
		emit({ ts: 6, type: "say", say: "user_feedback", text: "SECRET" })
		emit({ ts: 7, type: "ask", ask: "tool", text: "SECRET", partial: true })
		await vi.advanceTimersByTimeAsync(300)
		expect(output().at(-1)?.text).toBe("Thinking…")
		pending = { ts: 7, type: "ask", ask: "tool", text: "SECRET" }
		emit(pending)
		await vi.advanceTimersByTimeAsync(300)
		expect(output().at(-1)?.approval).toBeDefined()
		pending = undefined
		task.emit(RooCodeEventName.TaskAskResponded)
		emit({ ts: 7, type: "ask", ask: "tool", text: "SECRET" })
		await vi.advanceTimersByTimeAsync(300)
		emit({ ts: 8, type: "say", say: "completion_result", text: "Done" })
		await vi.advanceTimersByTimeAsync(300)
		expect(output().at(-1)?.text).toBe("Done")
		const count = output().length
		pending = {
			ts: 9,
			type: "ask",
			ask: "completion_result",
			text: '{"suggest":[{"answer":"Start code review","mode":"review"}]}',
		}
		emit({ ...pending, text: '{"suggest":', partial: true })
		await vi.advanceTimersByTimeAsync(300)
		emit(pending)
		await vi.advanceTimersByTimeAsync(900)
		expect(output()).toHaveLength(count)
		expect(JSON.stringify(output())).not.toContain("suggest")
		expect(JSON.stringify(client.request.mock.calls)).not.toContain("SECRET")
	} finally {
		bridge.dispose()
		vi.useRealTimers()
	}
})

it("sends and pins the original request only on new topic creation, before the notice", async () => {
	let topic: number | undefined
	const api = {
		verify: async () => ({ id: 1 }),
		updates: async (_offset: number, signal: AbortSignal, timeout?: number) =>
			timeout === 0 ? [] : new Promise((resolve) => signal.addEventListener("abort", () => resolve([]))),
		createTopic: vi.fn(async () => 5),
		sendText: vi.fn(async (..._args: unknown[]) => [10, 11]),
		pinMessage: vi.fn(async () => {}),
	}
	const store = {
		load: async () => {},
		get: () => topic,
		set: async (_key: string, value: number | null) => {
			topic = value ?? undefined
		},
	}
	const coordinator = new TelegramCoordinator(
		api as unknown as TelegramApi,
		1,
		store as unknown as TelegramTopicStore,
		vi.fn(),
	)
	await coordinator.start()
	coordinator.connect("c", vi.fn())
	try {
		const text = "😀long task ".repeat(600)
		expect(splitTelegramText(text).join("")).toBe(text)
		await coordinator.activate("c", "p", "t", "Short", "Notice", text)
		expect(api.sendText.mock.calls[0]).toEqual([1, 5, text, expect.any(AbortSignal)])
		expect(api.pinMessage).toHaveBeenCalledWith(1, 10, expect.any(AbortSignal))
		await coordinator.activate("c", "p", "t", "Changed", "Notice", text)
		expect(api.createTopic).toHaveBeenCalledTimes(1)
		expect(api.pinMessage).toHaveBeenCalledTimes(1)
		expect(api.sendText).toHaveBeenCalledTimes(3)
	} finally {
		await coordinator.stop()
	}
})

it("pins quietly through the API without exposing request errors", async () => {
	const fetcher = vi.fn(
		async (_url: string | URL | Request, _options?: RequestInit) =>
			new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
	)
	const api = new TelegramApi("123:fixture", fetcher)
	await api.pinMessage(1, 10)
	expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
		chat_id: 1,
		message_id: 10,
		disable_notification: true,
	})
})
