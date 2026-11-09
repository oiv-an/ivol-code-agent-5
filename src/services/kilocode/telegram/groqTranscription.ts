/** Speech-to-text for Telegram voice notes through Groq's OpenAI-compatible Whisper endpoint. */
export const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
export const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3"

/** Never include the API key, request URL or raw response body: callers show this message to the user. */
export class GroqTranscriptionError extends Error {
	constructor(readonly code: number | "missing-key" | "empty" | "network") {
		super(
			code === "missing-key"
				? "Groq API key is not configured"
				: code === "empty"
					? "Groq returned an empty transcription"
					: code === "network"
						? "Groq transcription request failed"
						: `Groq transcription failed (HTTP ${code})`,
		)
		this.name = "GroqTranscriptionError"
	}
}

export async function transcribeWithGroq(
	audio: string,
	apiKey: string | undefined,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch,
): Promise<string> {
	if (!apiKey?.trim()) throw new GroqTranscriptionError("missing-key")
	const match = /^data:audio\/ogg;base64,([A-Za-z0-9+/=]+)$/.exec(audio)
	if (!match) throw new Error("Unsupported voice message format")
	const form = new FormData()
	form.set("file", new Blob([new Uint8Array(Buffer.from(match[1], "base64"))], { type: "audio/ogg" }), "voice.ogg")
	form.set("model", GROQ_TRANSCRIPTION_MODEL)
	form.set("response_format", "json")
	const timeout = AbortSignal.timeout(120_000)
	let response: Response
	try {
		response = await fetcher(GROQ_TRANSCRIPTION_URL, {
			method: "POST",
			redirect: "error",
			headers: { Authorization: `Bearer ${apiKey.trim()}` },
			body: form,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		})
	} catch {
		throw new GroqTranscriptionError("network")
	}
	if (!response.ok) throw new GroqTranscriptionError(response.status)
	let text: unknown
	try {
		text = ((await response.json()) as { text?: unknown }).text
	} catch {
		throw new GroqTranscriptionError("network")
	}
	if (typeof text !== "string" || !text.trim()) throw new GroqTranscriptionError("empty")
	return text.trim()
}
