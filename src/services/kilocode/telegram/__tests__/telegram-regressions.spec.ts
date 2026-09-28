import { EventEmitter } from "node:events"
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { RooCodeEventName, type ClineMessage } from "@roo-code/types"
import { TelegramCoordinator } from "../TelegramCoordinator"
import { TelegramTaskBridge } from "../TelegramTaskBridge"
import { readTelegramImageAttachment } from "../TelegramAttachments"
import type { TelegramUpdate } from "../TelegramApi"
import type { TelegramApi } from "../TelegramApi"
import type { TelegramTopicStore } from "../TelegramTopicStore"
import type { Task } from "../../../../core/task/Task"
import type { TelegramLocalClient } from "../TelegramLocalClient"
import type { TelegramRoute } from "../TelegramRouter"

function deferred<T = void>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
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

describe("Telegram approval and media regressions", () => {
	it("does not resurrect invalidated queued approvals and keeps text/image order without waiting for delivery ack", async () => {
		const gate = deferred()
		const calls: string[] = []
		const keyboards: unknown[] = []
		let id = 0
		const api = {
			verify: async () => ({ id: 1 }),
			updates: (_offset: number, signal: AbortSignal, timeout?: number) =>
				timeout === 0
					? Promise.resolve([])
					: new Promise((_resolve, reject) =>
							signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }),
						),
			sendText: vi.fn(async (_chat, _thread, text, _signal, keyboard) => {
				if (text === "block") await gate.promise
				calls.push(text)
				keyboards.push(keyboard)
				return [++id]
			}),
			editText: vi.fn(async (_chat, _id, text, _signal, keyboard) => {
				calls.push(text)
				keyboards.push(keyboard)
			}),
			sendImage: vi.fn(async () => {
				calls.push("image")
			}),
		}
		const coordinator = new TelegramCoordinator(
			api as unknown as TelegramApi,
			123,
			{ load: async () => {}, get: () => 5 } as unknown as TelegramTopicStore,
			vi.fn(),
		)
		await coordinator.start()
		coordinator.connect("client", vi.fn())
		const active = await coordinator.activate("client", "project", "task", "title", "notice")
		const publish = (
			messageId: string,
			text: string,
			approvalRevision: number,
			approval?: { requestId: string; approveLabel: string; denyLabel: string },
		) =>
			coordinator.publish("client", {
				operation: "publish",
				taskId: "task",
				epoch: active.epoch,
				messageId,
				text,
				partial: false,
				approvalRevision,
				approval,
			})
		try {
			publish("block", "block", 0)
			await Promise.resolve()
			publish("ask", "ask", 1, { requestId: "request", approveLabel: "yes", denyLabel: "no" })
			coordinator.invalidateApproval("client", active.epoch, 2)
			publish("ask", "ask", 1, { requestId: "request", approveLabel: "yes", denyLabel: "no" })
			await coordinator.publishImage("client", {
				operation: "publishImage",
				taskId: "task",
				epoch: active.epoch,
				messageId: "img",
				image: "data:image/png;base64,YQ==",
			})
			publish("tail", "tail", 2)
			gate.resolve()
			await vi.waitFor(() => expect(calls).toContain("tail"))
			expect(calls.indexOf("ask")).toBeLessThan(calls.indexOf("image"))
			expect(calls.indexOf("image")).toBeLessThan(calls.indexOf("tail"))
			expect(keyboards.every((keyboard) => keyboard === undefined)).toBe(true)
			publish("fresh", "fresh", 3, { requestId: "fresh", approveLabel: "yes", denyLabel: "no" })
			coordinator.invalidateApproval("client", active.epoch, 2)
			await vi.waitFor(() => expect(calls).toContain("fresh"))
			expect(keyboards.at(-1)).toBeDefined()
		} finally {
			gate.resolve()
			await coordinator.stop()
		}
	})

	it("never reauthorizes a consumed callback and rotates six-day sessions without replay", async () => {
		let next = deferred<TelegramUpdate[]>()
		const deliveries: Array<{ text: string; keyboard?: Array<Array<{ callback_data: string }>> }> = []
		const api = {
			answerCallbackQuery: vi.fn(async () => {}),
			verify: async () => ({ id: 1 }),
			updates: vi.fn((_offset: number, signal: AbortSignal, timeout?: number) => {
				if (timeout === 0) return Promise.resolve([])
				const current = next
				signal.addEventListener("abort", () => current.resolve([]), { once: true })
				return current.promise
			}),
			sendText: vi.fn(async (_chat, _thread, text, _signal, keyboard) => {
				deliveries.push({ text, keyboard })
				return [deliveries.length]
			}),
			editText: vi.fn(async (_chat, _id, text, _signal, keyboard) => {
				deliveries.push({ text, keyboard })
			}),
		}
		const report = vi.fn()
		const send = vi.fn()
		const coordinator = new TelegramCoordinator(
			api as unknown as TelegramApi,
			123,
			{ load: async () => {}, get: () => 5 } as unknown as TelegramTopicStore,
			report,
		)
		await coordinator.start()
		coordinator.connect("client", send)
		const active = await coordinator.activate("client", "project", "task", "title", "notice")
		const request = {
			operation: "publish" as const,
			taskId: "task",
			epoch: active.epoch,
			messageId: "ask",
			text: "ask",
			partial: false,
			approvalRevision: 1,
			approval: { requestId: "r", approveLabel: "yes", denyLabel: "no" },
		}
		try {
			coordinator.publish("client", request)
			await vi.waitFor(() => expect(deliveries.at(-1)?.keyboard).toBeDefined())
			const callback = deliveries.at(-1)!.keyboard![0][0].callback_data
			const previous = next
			next = deferred<TelegramUpdate[]>()
			previous.resolve([
				{
					update_id: 1,
					callback_query: {
						id: "click",
						from: { id: 123 },
						data: callback,
						message: {
							message_id: 1,
							message_thread_id: 5,
							date: Date.now() / 1000,
							chat: { id: 123, type: "private" },
						},
					},
				},
			])
			await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
			coordinator.publish("client", { ...request, text: "updated" })
			await vi.waitFor(() => expect(deliveries.at(-1)?.text).toBe("updated"))
			expect(deliveries.at(-1)?.keyboard).toBeUndefined()
			const now = Date.now()
			vi.spyOn(Date, "now").mockReturnValue(now + 7 * 24 * 60 * 60 * 1000)
			const old = next
			next = deferred<TelegramUpdate[]>()
			old.resolve([])
			await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.stringContaining("expired")))
			expect(() => coordinator.publish("client", request)).toThrow("no longer active")
			expect(api.updates).toHaveBeenCalledWith(0, expect.any(AbortSignal), 0)
		} finally {
			vi.restoreAllMocks()
			await coordinator.stop()
		}
	})

	it("invalidates while a publish is pending and rejects stale callbacks", async () => {
		vi.useFakeTimers()
		const gate = deferred()
		let pending: ClineMessage | undefined = { ts: 1, type: "ask", ask: "tool", text: "read" }
		const task = Object.assign(new EventEmitter(), {
			taskId: "task",
			instanceId: "instance",
			cwd: "/project",
			getRemotePendingAsk: () => pending,
			respondToRemoteAsk: vi.fn(),
			messageQueueService: { addMessage: vi.fn() },
		})
		const client = Object.assign(new EventEmitter(), {
			request: vi.fn(async (request) => {
				if (request.operation === "publish") await gate.promise
			}),
			close: vi.fn(),
		})
		const bridge = new TelegramTaskBridge(
			task as unknown as Task,
			client as unknown as TelegramLocalClient,
			route,
			() => true,
			vi.fn(),
			{ approve: "yes", deny: "no", thinking: "Thinking…", confirmation: "Review in IDE" },
		)
		try {
			await vi.advanceTimersByTimeAsync(300)
			pending = undefined
			await vi.advanceTimersByTimeAsync(300)
			expect(client.request).toHaveBeenCalledWith(
				expect.objectContaining({ operation: "invalidateApproval", approvalRevision: 2 }),
			)
			client.emit("input", {
				kind: "approval",
				taskId: "task",
				epoch: "epoch",
				requestId: "instance:1",
				approved: true,
			})
			expect(task.respondToRemoteAsk).not.toHaveBeenCalled()
		} finally {
			gate.resolve()
			bridge.dispose()
			vi.useRealTimers()
		}
	})

	it.each(["condense", "auto_approval_max_req_reached", "command_output"] as const)(
		"uses safe one-shot actions for %s",
		(ask) => {
			const pending: ClineMessage = { ts: 2, type: "ask", ask }
			const provider = { getCurrentTask: () => task, cancelTask: vi.fn(async () => {}) }
			const task = Object.assign(new EventEmitter(), {
				taskId: "task",
				instanceId: "instance",
				getRemotePendingAsk: () => pending,
				respondToRemoteAsk: vi.fn(),
				handleTerminalOperation: vi.fn(async () => {}),
				providerRef: { deref: () => provider },
			})
			const client = Object.assign(new EventEmitter(), { close: vi.fn() })
			const bridge = new TelegramTaskBridge(
				task as unknown as Task,
				client as unknown as TelegramLocalClient,
				route,
				() => true,
				vi.fn(),
				{ approve: "yes", deny: "no", thinking: "Thinking…", confirmation: "Review in IDE" },
			)
			try {
				const input = {
					kind: "approval",
					taskId: "task",
					epoch: "epoch",
					requestId: "instance:2",
					approved: false,
				}
				client.emit("input", input)
				client.emit("input", input)
				expect(task.respondToRemoteAsk).not.toHaveBeenCalled()
				if (ask === "command_output")
					expect(task.handleTerminalOperation).toHaveBeenCalledExactlyOnceWith("abort")
				else expect(provider.cancelTask).toHaveBeenCalledTimes(1)
			} finally {
				bridge.dispose()
			}
		},
	)

	it("replaces structured UI fields and browser images with one safe activity status", async () => {
		vi.useFakeTimers()
		const task = Object.assign(new EventEmitter(), {
			taskId: "task",
			cwd: "/project",
			getRemotePendingAsk: () => undefined,
		})
		const client = Object.assign(new EventEmitter(), { request: vi.fn(async () => null), close: vi.fn() })
		const bridge = new TelegramTaskBridge(
			task as unknown as Task,
			client as unknown as TelegramLocalClient,
			route,
			() => true,
			vi.fn(),
			{ approve: "yes", deny: "no", thinking: "Thinking…", confirmation: "Review in IDE" },
		)
		try {
			task.emit(RooCodeEventName.Message, {
				message: {
					ts: 3,
					type: "say",
					say: "browser_action_result",
					reasoning: "visible reasoning",
					text: JSON.stringify({ screenshot: "data:image/png;base64,YQ==", result: "ok" }),
					progressStatus: { text: "progress" },
					contextTruncation: {
						truncationId: "t",
						messagesRemoved: 2,
						prevContextTokens: 30,
						newContextTokens: 10,
					},
				},
			})
			await vi.advanceTimersByTimeAsync(300)
			expect(client.request).toHaveBeenCalledWith(
				expect.objectContaining({ operation: "publish", text: "Thinking…" }),
			)
			expect(client.request).toHaveBeenCalledWith(
				expect.objectContaining({ operation: "publish", text: expect.not.stringContaining("base64") }),
			)
			expect(client.request).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "publishImage" }))
		} finally {
			bridge.dispose()
			vi.useRealTimers()
		}
	})

	it("reads only explicit workspace image attachments and rejects symlink escape/non-images", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "ivol-telegram-media-"))
		const outside = await mkdtemp(path.join(tmpdir(), "ivol-telegram-outside-"))
		const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
		const row = (imagePath: string): ClineMessage => ({
			ts: 1,
			type: "say",
			say: "image",
			text: JSON.stringify({ imageUri: "webview:image", imagePath }),
		})
		try {
			await writeFile(path.join(root, "image.png"), png)
			if (process.platform !== "linux") {
				await expect(readTelegramImageAttachment(row(path.join(root, "image.png")), root)).rejects.toThrow(
					"unsupported on this platform",
				)
				return // Secure local reads require Linux procfs; data URI media remains portable.
			}
			expect(await readTelegramImageAttachment(row(path.join(root, "image.png")), root)).toBe(
				`data:image/png;base64,${png.toString("base64")}`,
			)
			expect(await readTelegramImageAttachment({ ...row("/private/secret"), say: "text" }, root)).toBeUndefined()
			await writeFile(path.join(outside, "image.png"), png)
			await symlink(path.join(outside, "image.png"), path.join(root, "escape.png"))
			await expect(readTelegramImageAttachment(row(path.join(root, "escape.png")), root)).rejects.toThrow(
				"outside",
			)
			await writeFile(path.join(root, "fake.png"), "secret text")
			await expect(readTelegramImageAttachment(row(path.join(root, "fake.png")), root)).rejects.toThrow("format")
		} finally {
			await rm(root, { recursive: true, force: true })
			await rm(outside, { recursive: true, force: true })
		}
	})
})
