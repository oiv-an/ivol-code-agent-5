import type { TelegramUpdate } from "../TelegramApi"
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
