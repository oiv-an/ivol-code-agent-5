// kilocode_change - new file
import { createStreamingMessage } from "../streaming-client"

const options = {
	connectionTest: true,
	accessToken: "test-oauth-token",
	model: "claude-sonnet-4-5",
	systemPrompt: "Connection check.",
	messages: [{ role: "user" as const, content: "Reply OK." }],
}

describe("Claude connection test streaming diagnostics", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it("returns HTTP status/request ID while discarding a sensitive error body", async () => {
		const response = new Response("secret body and key", { status: 403, headers: { "request-id": "req_claude" } })
		const readBody = vi.spyOn(response, "text")
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response))
		const logger = vi.spyOn(console, "error").mockImplementation(() => undefined)
		await expect(createStreamingMessage(options).next()).rejects.toMatchObject({
			status: 403,
			request_id: "req_claude",
		})
		expect(readBody).not.toHaveBeenCalled()
		expect(logger).not.toHaveBeenCalled()
	})

	it("fails malformed SSE without logging it and closes the response reader", async () => {
		const cancel = vi.fn()
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode("event: content_block_delta\ndata: server-secret-malformed\n\n"),
				)
			},
			cancel,
		})
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)))
		const logger = vi.spyOn(console, "error").mockImplementation(() => undefined)
		await expect(createStreamingMessage(options).next()).rejects.toThrow("Invalid SSE response")
		expect(logger).not.toHaveBeenCalled()
		expect(cancel).toHaveBeenCalledOnce()
	})

	it("forwards cancellation to the HTTP request", async () => {
		const signal = new AbortController().signal
		const fetch = vi.fn().mockResolvedValue(new Response(""))
		vi.stubGlobal("fetch", fetch)
		await createStreamingMessage({ ...options, signal }).next()
		expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal }))
	})
})
