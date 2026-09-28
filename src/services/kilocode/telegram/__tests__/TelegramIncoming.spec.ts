import { TelegramApi, TELEGRAM_IMAGE_MAX_BYTES, type TelegramUpdate } from "../TelegramApi"
import { TelegramCoordinator } from "../TelegramCoordinator"
import { TelegramRouter } from "../TelegramRouter"
import { telegramInputSchema } from "../protocol"
import type { TelegramTopicStore } from "../TelegramTopicStore"

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])
const image = `data:image/png;base64,${Buffer.from(png).toString("base64")}`
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
function photo(id = 1, caption?: string): TelegramUpdate {
	return {
		update_id: id,
		message: {
			message_id: id,
			date: Math.ceil(Date.now() / 1000) + 1,
			chat: { id: 123, type: "private" },
			from: { id: 123 },
			message_thread_id: 5,
			caption,
			photo: [
				{ file_id: "small", width: 1, height: 1 },
				{ file_id: "large", width: 100, height: 100 },
			],
		},
	}
}
async function fixture() {
	let next = deferred<TelegramUpdate[]>()
	const api = {
		verify: async () => ({ id: 1 }),
		updates: vi.fn((_offset: number, signal: AbortSignal, timeout?: number) => {
			if (timeout === 0) return Promise.resolve([])
			const current = next
			signal.addEventListener("abort", () => current.resolve([]), { once: true })
			return current.promise
		}),
		sendText: vi.fn(async (..._args: Parameters<TelegramApi["sendText"]>) => [1]),
		editText: vi.fn(async () => {}),
		downloadImage: vi.fn(async (_file: unknown, _signal: AbortSignal) => image),
		answerCallbackQuery: vi.fn(async () => {}),
	}
	const send = vi.fn(),
		fault = vi.fn(),
		report = vi.fn()
	const coordinator = new TelegramCoordinator(
		api as unknown as TelegramApi,
		123,
		{ load: async () => {}, get: () => 5 } as unknown as TelegramTopicStore,
		report,
	)
	await coordinator.start()
	coordinator.connect("client", send, fault)
	const route = await coordinator.activate("client", "project", "task", "title", "notice")
	const push = async (updates: TelegramUpdate[]) => {
		const previous = next
		next = deferred<TelegramUpdate[]>()
		previous.resolve(updates)
		await new Promise((resolve) => setImmediate(resolve))
	}
	return { api, send, fault, report, coordinator, route, push }
}

describe("Telegram incoming images", () => {
	it("transfers the root topic without notices, rejects stale buttons and cancels old downloads", async () => {
		const f = await fixture()
		const gate = deferred<string>()
		f.api.downloadImage.mockReturnValueOnce(gate.promise)
		try {
			f.coordinator.publish("client", {
				operation: "publish",
				taskId: "task",
				epoch: f.route.epoch,
				messageId: "root:1",
				text: "approve",
				partial: false,
				approvalRevision: 1,
				approval: { requestId: "root-request", approveLabel: "yes", denyLabel: "no" },
			})
			await new Promise((resolve) => setImmediate(resolve))
			const keyboard = f.api.sendText.mock.calls.find((call) => call[2] === "approve")?.[4]
			const callbackData = keyboard?.[0]?.[0]?.callback_data
			expect(callbackData).toBeDefined()
			await f.push([photo(1)])
			const suspended = f.coordinator.beginTransfer("client", "task", f.route.epoch)
			expect(f.api.downloadImage.mock.calls[0][1].aborted).toBe(true)
			await f.push([photo(2, "during transfer")])
			const child = f.coordinator.finishTransfer("client", "child", suspended.epoch)
			expect(child.key).toBe(f.route.key)
			expect(child.threadId).toBe(f.route.threadId)
			expect(child.epoch).not.toBe(f.route.epoch)
			gate.resolve(image)
			await new Promise((resolve) => setImmediate(resolve))
			expect(f.send).not.toHaveBeenCalled()
			expect(() =>
				f.coordinator.publish("client", {
					operation: "publish",
					taskId: "task",
					epoch: f.route.epoch,
					messageId: "old",
					text: "old",
					partial: false,
					approvalRevision: 0,
				}),
			).toThrow()
			await f.push([
				{
					update_id: 3,
					callback_query: {
						id: "stale-callback",
						from: { id: 123 },
						data: callbackData,
						message: photo(3).message,
					},
				},
			])
			expect(f.send).not.toHaveBeenCalled()
			expect(f.api.answerCallbackQuery).not.toHaveBeenCalled()
			await f.push([photo(4, "new child")])
			expect(f.send).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ taskId: "child", epoch: child.epoch, text: "new child" }),
			)
			expect(f.api.sendText.mock.calls.filter((call) => call[2] === "notice")).toHaveLength(1)
			const back = f.coordinator.beginTransfer("client", "child", child.epoch)
			f.coordinator.deactivate("client")
			expect(() => f.coordinator.finishTransfer("client", "task", back.epoch)).toThrow()
		} finally {
			await f.coordinator.stop()
		}
	})
	it.each([undefined, "screen", "/stop"])(
		"delivers photo with caption %s and deduplicates updates",
		async (caption) => {
			const f = await fixture()
			try {
				await f.push([photo(1, caption), photo(1, caption)])
				expect(f.api.downloadImage).toHaveBeenCalledExactlyOnceWith(
					{ file_id: "large", file_size: undefined },
					expect.any(AbortSignal),
				)
				expect(f.send).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({ kind: "message", text: caption ?? "", images: [image] }),
				)
				expect(telegramInputSchema.parse(f.send.mock.calls[0][0]).kind).toBe("message")
			} finally {
				await f.coordinator.stop()
			}
		},
	)

	it("rejects unauthorized, offline, old and unsupported media before any download", async () => {
		const f = await fixture()
		try {
			const wrong = photo(1)
			wrong.message!.from!.id = 456
			const topic = photo(2)
			topic.message!.message_thread_id = 6
			const old = photo(3)
			old.message!.date = 0
			const document = photo(4)
			delete document.message!.photo
			document.message!.document = { file_id: "audio", mime_type: "audio/mpeg" }
			await f.push([wrong, topic, old, document])
			f.coordinator.deactivate("client")
			await f.push([photo(5)])
			expect(f.api.downloadImage).not.toHaveBeenCalled()
			expect(f.send).not.toHaveBeenCalled()
		} finally {
			await f.coordinator.stop()
		}
	})

	it.each(["image/png", "image/jpeg"])("accepts %s documents", async (mime_type) => {
		const f = await fixture()
		try {
			const update = photo()
			delete update.message!.photo
			update.message!.document = { file_id: "document", mime_type }
			await f.push([update])
			expect(f.send).toHaveBeenCalledOnce()
		} finally {
			await f.coordinator.stop()
		}
	})

	it("preserves photo/text order without blocking polling", async () => {
		const f = await fixture(),
			gate = deferred<string>()
		f.api.downloadImage.mockReturnValueOnce(gate.promise)
		try {
			await f.push([photo()])
			const text = photo(2)
			delete text.message!.photo
			text.message!.text = "after"
			await f.push([text])
			expect(f.send).not.toHaveBeenCalled()
			expect(f.api.updates.mock.calls.length).toBeGreaterThanOrEqual(4)
			gate.resolve(image)
			await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2))
			expect(f.send.mock.calls.map(([input]) => input.text)).toEqual(["", "after"])
		} finally {
			gate.resolve(image)
			await f.coordinator.stop()
		}
	})

	it.each(["reactivate", "stop", "shutdown"])(
		"discards stale download after %s without waiting for it",
		async (action) => {
			const f = await fixture(),
				gate = deferred<string>()
			f.api.downloadImage.mockReturnValueOnce(gate.promise)
			try {
				await f.push([photo()])
				const signal = f.api.downloadImage.mock.calls[0][1]
				if (action === "reactivate")
					await f.coordinator.activate("client", "project", "task", "title", "notice")
				else if (action === "shutdown") await f.coordinator.stop()
				else {
					const stop = photo(2)
					delete stop.message!.photo
					stop.message!.text = "/stop"
					await f.push([stop])
				}
				expect(signal.aborted).toBe(true)
				gate.resolve(image)
				await new Promise((resolve) => setImmediate(resolve))
				expect(f.send.mock.calls.filter(([input]) => input.kind === "message")).toHaveLength(0)
				if (action === "stop") expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "stop" }))
			} finally {
				gate.resolve(image)
				await f.coordinator.stop()
			}
		},
	)

	it("bounds the ordered queue and reports a sanitized failure", async () => {
		const f = await fixture(),
			gate = deferred<string>()
		f.api.downloadImage.mockReturnValueOnce(gate.promise)
		try {
			await f.push([photo()])
			await f.push(Array.from({ length: 33 }, (_, i) => photo(i + 2)))
			expect(f.fault).toHaveBeenCalledWith(expect.stringContaining("queue is full"))
			gate.resolve(image)
			await new Promise((resolve) => setImmediate(resolve))
			expect(f.send).not.toHaveBeenCalled()
		} finally {
			gate.resolve(image)
			await f.coordinator.stop()
		}
	})

	it("fails closed on download errors without leaking transport details", async () => {
		const f = await fixture()
		f.api.downloadImage.mockRejectedValueOnce(new Error("secret-token-url"))
		try {
			await f.push([photo()])
			expect(f.fault).toHaveBeenCalledOnce()
			expect(JSON.stringify(f.fault.mock.calls)).not.toContain("secret-token")
			expect(f.send).not.toHaveBeenCalled()
		} finally {
			await f.coordinator.stop()
		}
	})

	it("limits concurrent downloads across independent windows", async () => {
		const f = await fixture(),
			gate = deferred<string>()
		f.api.downloadImage.mockReturnValue(gate.promise)
		try {
			for (let index = 0; index < 4; index++) {
				f.coordinator.connect(`extra-${index}`, vi.fn(), f.fault)
				const store = (f.coordinator as unknown as { store: { get: () => number } }).store
				store.get = () => 6 + index
				await f.coordinator.activate(`extra-${index}`, "project", `task-${index}`, "title", "notice")
			}
			for (let index = 0; index < 5; index++) {
				const update = photo(index + 1)
				update.message!.message_thread_id = 5 + index
				await f.push([update])
			}
			expect(f.api.downloadImage).toHaveBeenCalledTimes(4)
			expect(f.fault).toHaveBeenCalledWith(expect.stringContaining("download limit"))
		} finally {
			gate.resolve(image)
			await f.coordinator.stop()
		}
	})

	it("acks only a valid owner callback once; ack rejection does not replay or disconnect", async () => {
		const f = await fixture()
		f.api.answerCallbackQuery.mockRejectedValueOnce(new Error("secret-token"))
		try {
			const router = (f.coordinator as unknown as { router: TelegramRouter }).router
			const token = router.createApproval(f.route, "ask")
			const callback = (id: number, owner = 123): TelegramUpdate => ({
				update_id: id,
				callback_query: {
					id: `callback-${id}`,
					from: { id: owner },
					message: photo().message,
					data: `ivol:${token}:yes`,
				},
			})
			await f.push([callback(1, 456)])
			expect(f.api.answerCallbackQuery).not.toHaveBeenCalled()
			await f.push([callback(2), callback(2), callback(3)])
			expect(f.api.answerCallbackQuery).toHaveBeenCalledExactlyOnceWith("callback-2", expect.any(AbortSignal))
			expect(f.send).toHaveBeenCalledOnce()
			expect(f.fault).not.toHaveBeenCalled()
			expect(f.report).toHaveBeenCalledWith("Telegram button acknowledgement failed")
			await f.push([photo(4)])
			expect(f.send).toHaveBeenCalledTimes(2)
			f.coordinator.deactivate("client")
			await f.push([callback(5)])
			expect(f.api.answerCallbackQuery).toHaveBeenCalledOnce()
		} finally {
			await f.coordinator.stop()
		}
	})
})

describe("Telegram bounded file API", () => {
	const metadata = (file_path = "photos/image.jpg", file_size?: number) =>
		new Response(JSON.stringify({ ok: true, result: { file_path, file_size } }))
	it.each([png, new Uint8Array([255, 216, 255, 0])])(
		"downloads signatures using only Telegram file API",
		async (bytes) => {
			const fetcher = vi.fn().mockResolvedValueOnce(metadata()).mockResolvedValueOnce(new Response(bytes))
			const api = new TelegramApi("123:fake", fetcher)
			expect(await api.downloadImage({ file_id: "file" }, new AbortController().signal)).toMatch(
				/^data:image\/(png|jpeg);base64,/,
			)
			expect(fetcher.mock.calls[1][0]).toBe("https://api.telegram.org/file/bot123:fake/photos/image.jpg")
			expect(fetcher.mock.calls[1][1].redirect).toBe("error")
		},
	)
	it.each(["https://evil/x", "../secret", "photos/%2e%2e/x", "photos//x", "/absolute", "photos/x?token=1"])(
		"rejects file path %s",
		async (value) => {
			const fetcher = vi.fn().mockResolvedValueOnce(metadata(value))
			await expect(
				new TelegramApi("123:fake", fetcher).downloadImage({ file_id: "file" }, new AbortController().signal),
			).rejects.toThrow("(400)")
			expect(fetcher).toHaveBeenCalledOnce()
		},
	)
	it.each(["declared", "metadata", "header", "stream", "format", "network", "aborted"])(
		"bounds and sanitizes %s failure",
		async (kind) => {
			const fetcher = vi
				.fn()
				.mockResolvedValueOnce(
					metadata("photos/x", kind === "metadata" ? TELEGRAM_IMAGE_MAX_BYTES + 1 : undefined),
				)
			const controller = new AbortController()
			if (kind === "aborted") controller.abort()
			if (kind === "network") fetcher.mockRejectedValueOnce(new Error("https://api.telegram.org/bot123:fake"))
			else
				fetcher.mockResolvedValueOnce(
					new Response(
						kind === "stream" ? new Uint8Array(TELEGRAM_IMAGE_MAX_BYTES + 1) : new Uint8Array([0]),
						kind === "header"
							? { headers: { "content-length": String(TELEGRAM_IMAGE_MAX_BYTES + 1) } }
							: undefined,
					),
				)
			await expect(
				new TelegramApi("123:fake", fetcher).downloadImage(
					{ file_id: "file", file_size: kind === "declared" ? TELEGRAM_IMAGE_MAX_BYTES + 1 : undefined },
					controller.signal,
				),
			).rejects.toThrow(/^Telegram request failed \(\d+\)$/)
		},
	)
	it("aborts stalled body reads at the total download deadline and cancels the reader", async () => {
		const deadline = new AbortController()
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
		const cancel = vi.fn()
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(metadata())
			.mockImplementationOnce(
				async (_url, init) =>
					new Response(
						new ReadableStream({
							start(controller) {
								init.signal.addEventListener(
									"abort",
									() => controller.error(new Error("secret-token-url")),
									{ once: true },
								)
							},
							cancel,
						}),
					),
			)
		try {
			const pending = new TelegramApi("123:fake", fetcher).downloadImage(
				{ file_id: "file" },
				new AbortController().signal,
			)
			const rejected = expect(pending).rejects.toThrow("(503)")
			await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
			deadline.abort()
			await rejected
			expect(timeout).toHaveBeenCalledWith(20_000)
		} finally {
			timeout.mockRestore()
		}
	})

	it("sends callback acknowledgement without retrying a failed request", async () => {
		const fetcher = vi.fn().mockRejectedValue(new Error("secret-token"))
		await expect(
			new TelegramApi("123:fake", fetcher).answerCallbackQuery("callback", new AbortController().signal),
		).rejects.toThrow("(503)")
		expect(fetcher).toHaveBeenCalledOnce()
		expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ callback_query_id: "callback" })
	})
})

it("disconnect aborts output, clears pending chunks/messages and rejects late publications and transfer", async () => {
	const f = await fixture()
	const gate = deferred<number[]>()
	f.api.sendText.mockReturnValueOnce(gate.promise)
	const publish = (messageId: string, text: string) =>
		f.coordinator.publish("client", {
			operation: "publish",
			taskId: "task",
			epoch: f.route.epoch,
			messageId,
			text,
			partial: false,
			approvalRevision: 0,
		})
	publish("first", "x".repeat(9000))
	await new Promise((resolve) => setImmediate(resolve))
	publish("queued", "must not be sent")
	const signal = f.api.sendText.mock.calls.at(-1)![3]!
	const suspended = f.coordinator.beginTransfer("client", "task", f.route.epoch)
	f.coordinator.disconnect("client")
	expect(signal.aborted).toBe(true)
	gate.resolve([2]) // A request already accepted remotely cannot be recalled.
	await new Promise((resolve) => setImmediate(resolve))
	expect(f.api.sendText).toHaveBeenCalledTimes(2) // notice + first chunk only
	expect(() => publish("late", "late")).toThrow()
	expect(() => f.coordinator.finishTransfer("client", "child", suspended.epoch)).toThrow()
	f.coordinator.stop()
})
