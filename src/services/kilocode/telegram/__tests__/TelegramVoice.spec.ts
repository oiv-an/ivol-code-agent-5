import { EventEmitter } from "node:events"
import { TelegramTaskBridge } from "../TelegramTaskBridge"
import { TelegramRouter } from "../TelegramRouter"
import { TelegramApi } from "../TelegramApi"
import { transcribeWithGroq, GROQ_TRANSCRIPTION_URL, GroqTranscriptionError } from "../groqTranscription"
import type { Task } from "../../../../core/task/Task"
import type { TelegramLocalClient } from "../TelegramLocalClient"
import type { TelegramRoute } from "../TelegramRouter"

const audio = `data:audio/ogg;base64,${Buffer.from("OggS-voice").toString("base64")}`
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

function bridgeFixture(transcribe?: (audio: string) => Promise<string>) {
	const queue: { text: string }[] = []
	const task = Object.assign(new EventEmitter(), {
		taskId: "task",
		instanceId: "instance",
		getRemotePendingAsk: () => undefined,
		respondToRemoteText: vi.fn(() => true),
		messageQueueService: {
			messages: queue,
			isEmpty: () => queue.length === 0,
			addMessage: vi.fn(),
		},
	})
	const client = Object.assign(new EventEmitter(), { request: vi.fn(async () => null), close: vi.fn() })
	const bridge = new TelegramTaskBridge(
		task as unknown as Task,
		client as unknown as TelegramLocalClient,
		route,
		() => true,
		vi.fn(),
		{ approve: "yes", deny: "no", thinking: "Thinking…", confirmation: "Review", voiceFailed: "Voice failed" },
		[],
		transcribe,
	)
	const send = (updateId: number, text: string, withAudio = false) =>
		client.emit("input", {
			kind: "message",
			taskId: "task",
			epoch: "epoch",
			updateId,
			text,
			...(withAudio ? { audio } : {}),
		})
	return { task, client, bridge, send }
}

describe("Telegram voice messages", () => {
	it("routes a voice note with its file id", () => {
		const router = new TelegramRouter()
		router.activate({ ...route, epoch: undefined } as unknown as TelegramRoute)
		const accepted = router.accept({
			update_id: 10,
			message: {
				message_id: 1,
				message_thread_id: 5,
				date: Math.ceil(Date.now() / 1000) + 5,
				from: { id: 123 },
				chat: { id: 123, type: "private" },
				voice: { file_id: "voice-file", file_size: 1000, duration: 3 },
			},
		})
		expect(accepted?.voice).toEqual({ file_id: "voice-file", file_size: 1000 })
		expect(accepted?.input).toMatchObject({ kind: "message", text: "" })
	})

	it("delivers the transcript to the task in order and echoes it to the topic", async () => {
		const f = bridgeFixture(async () => "сделай коммит")
		try {
			f.send(1, "", true)
			f.send(2, "after")
			await vi.waitFor(() => expect(f.task.respondToRemoteText).toHaveBeenCalledTimes(2))
			expect(f.task.respondToRemoteText.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
				"сделай коммит",
				"after",
			])
			expect(f.client.request).toHaveBeenCalledWith(
				expect.objectContaining({ operation: "publish", text: "🎙 сделай коммит", markdown: false }),
			)
		} finally {
			f.bridge.dispose()
		}
	})

	it("never sends a failed transcription to the model and reports it in the topic", async () => {
		const f = bridgeFixture(async () => {
			throw new GroqTranscriptionError("missing-key")
		})
		try {
			f.send(1, "", true)
			await vi.waitFor(() =>
				expect(f.client.request).toHaveBeenCalledWith(
					expect.objectContaining({ text: expect.stringContaining("Groq API key is not configured") }),
				),
			)
			expect(f.task.respondToRemoteText).not.toHaveBeenCalled()
			expect(f.task.messageQueueService.addMessage).not.toHaveBeenCalled()
		} finally {
			f.bridge.dispose()
		}
	})
})

describe("transcribeWithGroq", () => {
	it("posts the OGG file to Groq whisper-large-v3", async () => {
		const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
			const form = init.body as FormData
			expect(form.get("model")).toBe("whisper-large-v3")
			expect((form.get("file") as File).name).toBe("voice.ogg")
			expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gsk_test")
			return new Response(JSON.stringify({ text: " привет " }), { status: 200 })
		})
		expect(await transcribeWithGroq(audio, "gsk_test", undefined, fetcher as unknown as typeof fetch)).toBe(
			"привет",
		)
		expect(fetcher.mock.calls[0][0]).toBe(GROQ_TRANSCRIPTION_URL)
	})

	it("reports HTTP errors without leaking the key", async () => {
		const fetcher = vi.fn(async () => new Response("bad gsk_test", { status: 401 }))
		const error = await transcribeWithGroq(audio, "gsk_test", undefined, fetcher as unknown as typeof fetch).catch(
			(e: Error) => e,
		)
		expect(String(error)).toContain("HTTP 401")
		expect(String(error)).not.toContain("gsk_test")
	})
})

describe("TelegramApi.downloadVoice", () => {
	it("accepts only OGG voice files", async () => {
		const respond = (bytes: string) =>
			vi.fn(async (url: string) =>
				url.includes("/getFile")
					? new Response(JSON.stringify({ ok: true, result: { file_path: "voice/file_1.oga" } }))
					: new Response(bytes),
			)
		const ok = new TelegramApi("123:fake", respond("OggSdata") as unknown as typeof fetch)
		expect(await ok.downloadVoice({ file_id: "file" }, new AbortController().signal)).toMatch(
			/^data:audio\/ogg;base64,/,
		)
		const bad = new TelegramApi("123:fake", respond("RIFFdata") as unknown as typeof fetch)
		await expect(bad.downloadVoice({ file_id: "file" }, new AbortController().signal)).rejects.toThrow("(415)")
	})
})
