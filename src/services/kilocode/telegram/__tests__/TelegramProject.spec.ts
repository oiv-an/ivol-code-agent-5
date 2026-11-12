import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { TelegramApi, TelegramApiError, type TelegramUpdate } from "../TelegramApi"
import { TelegramCoordinator } from "../TelegramCoordinator"
import { TelegramTopicStore } from "../TelegramTopicStore"
import { TelegramRouter } from "../TelegramRouter"
import { telegramInputSchema } from "../protocol"

function update(id: number, threadId: number, text?: string, data?: string): TelegramUpdate {
	const message = {
		message_id: id,
		message_thread_id: threadId,
		date: Math.ceil(Date.now() / 1000) + 1,
		chat: { id: 123, type: "private" },
		from: { id: 123 },
		text,
	}
	return data
		? { update_id: id, callback_query: { id: `cb${id}`, from: { id: 123 }, message, data } }
		: { update_id: id, message }
}

describe("Telegram project introductions", () => {
	it("reuses the saved message after coordinator restart, replaces only deleted messages and separates sessions", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "telegram-project-"))
		const file = path.join(directory, "topics.json")
		const key = TelegramTopicStore.key(1, 123, "project", "__project__")
		// Existing registries without projectMessages must still load.
		await writeFile(file, JSON.stringify({ version: 1, topics: { [key]: 7 } }))
		let nextId = 100
		const api = {
			verify: async () => ({ id: 1 }),
			updates: (_offset: number, signal: AbortSignal, timeout?: number) =>
				timeout === 0
					? Promise.resolve([])
					: new Promise<TelegramUpdate[]>((resolve) => {
							signal.addEventListener("abort", () => resolve([]), { once: true })
						}),
			sendText: vi.fn(async () => [++nextId]),
			editText: vi.fn(async () => {}),
			pinMessage: vi.fn(async () => {}),
		}
		let coordinator = new TelegramCoordinator(
			api as unknown as TelegramApi,
			123,
			new TelegramTopicStore(file),
			vi.fn(),
		)
		const activate = (session = "session-a", help = "Help\n\nReconnections: 1") =>
			coordinator.activateProject("client", "project", "title", help, [], session)
		try {
			await coordinator.start()
			coordinator.connect("client", vi.fn())
			await activate("session-a", "Help\n\nReconnections: 0")
			expect(api.sendText).toHaveBeenCalledTimes(1)
			await coordinator.stop()
			coordinator = new TelegramCoordinator(
				api as unknown as TelegramApi,
				123,
				new TelegramTopicStore(file),
				vi.fn(),
			)
			await coordinator.start()
			coordinator.connect("client", vi.fn())
			await activate()
			expect(api.editText).toHaveBeenLastCalledWith(123, 101, "Help\n\nReconnections: 1", expect.any(AbortSignal))
			expect(api.sendText).toHaveBeenCalledTimes(1)
			expect(api.pinMessage).toHaveBeenCalledTimes(1)

			api.editText.mockRejectedValueOnce(
				new TelegramApiError(400, undefined, "editMessageText", "message-not-modified"),
			)
			await activate()
			for (const code of [400, 403, 429, 503]) {
				api.editText.mockRejectedValueOnce(new TelegramApiError(code, undefined, "editMessageText"))
				await expect(activate()).rejects.toThrow()
			}
			expect(api.sendText).toHaveBeenCalledTimes(1)

			api.editText.mockRejectedValueOnce(
				new TelegramApiError(400, undefined, "editMessageText", "message-not-found"),
			)
			await activate()
			expect(api.sendText).toHaveBeenCalledTimes(2)
			await activate()
			expect(api.editText).toHaveBeenLastCalledWith(123, 102, expect.any(String), expect.any(AbortSignal))
			await activate("session-b", "Help\n\nReconnections: 0")
			expect(api.sendText).toHaveBeenCalledTimes(3)
			const saved = new TelegramTopicStore(file)
			await saved.load()
			expect(saved.getProjectMessage(key, "session-b")).toBe(103)
			expect(saved.getProjectMessage(key, "session-a")).toBeUndefined()
		} finally {
			await coordinator.stop()
			await rm(directory, { recursive: true, force: true })
		}
	})

	it.each([
		["Bad Request: message to edit not found", "message-not-found"],
		["Bad Request: message is not modified: specified new message content is the same", "message-not-modified"],
		["Bad Request: message can't be edited; secret", undefined],
	])("classifies edit failures without retaining the response description: %s", async (description, reason) => {
		const fetcher = vi.fn(
			async () => new Response(JSON.stringify({ ok: false, error_code: 400, description }), { status: 400 }),
		)
		const api = new TelegramApi("123:fixture", fetcher as unknown as typeof fetch)
		const error = await api.editText(123, 1, "help").catch((value: unknown) => value)
		expect(error).toMatchObject({ code: 400, stage: "editMessageText", reason })
		expect(JSON.stringify(error)).not.toContain(description)
	})
})

describe("Telegram project control topic", () => {
	const base = { chatId: 123, ownerId: 123, activatedAt: 0, minimumUpdateId: 0 }

	it("routes project topic text, commands and menu buttons to the project client only", () => {
		const router = new TelegramRouter()
		const project = router.activateProject({ ...base, key: "p", clientId: "a", taskId: "__project__", threadId: 7 })
		router.activate({ ...base, key: "t", clientId: "a", taskId: "task", threadId: 8 })

		const text = router.accept(update(1, 7, "/new fix login"))
		expect(text?.input).toMatchObject({ kind: "project", text: "/new fix login", epoch: project.epoch })
		expect(telegramInputSchema.safeParse(text?.input).success).toBe(true)

		const button = router.accept(update(2, 7, undefined, "o:01a2-task"))
		expect(button).toMatchObject({ callbackId: "cb2", input: { kind: "project", data: "o:01a2-task" } })

		expect(router.accept(update(3, 7, undefined, "ivol:bad"))).toBeUndefined()
		expect(router.accept(update(4, 8, "hello"))?.input).toMatchObject({ kind: "message", taskId: "task" })
	})

	it("keeps the project topic when the task topic is deactivated and rejects another window", () => {
		const router = new TelegramRouter()
		router.activateProject({ ...base, key: "p", clientId: "a", taskId: "__project__", threadId: 7 })
		router.deactivate("a")
		expect(router.accept(update(1, 7, "hi"))?.input.kind).toBe("project")
		expect(() =>
			router.activateProject({ ...base, key: "p", clientId: "b", taskId: "__project__", threadId: 7 }),
		).toThrow()
		router.deactivateProject("a")
		expect(router.accept(update(2, 7, "hi"))).toBeUndefined()
	})

	it("ignores other senders", () => {
		const router = new TelegramRouter()
		router.activateProject({ ...base, key: "p", clientId: "a", taskId: "__project__", threadId: 7 })
		const foreign = update(1, 7, "/stop")
		foreign.message!.from = { id: 999 }
		expect(router.accept(foreign)).toBeUndefined()
	})
})
