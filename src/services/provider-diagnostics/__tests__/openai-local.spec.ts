// kilocode_change - new file
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http"

import nock from "nock"
import type { ProviderSettings } from "@roo-code/types"

import { runProviderConnectionTest } from ".."

// Keep the real factory, OpenAI adapter, SDK, fetch transport, and report service.
// Other providers in the barrel are outside this loopback integration test.
vi.mock("../../../api/providers", async () => ({
	OpenAiHandler: (await import("../../../api/providers/openai")).OpenAiHandler,
}))

type CapturedRequest = { method?: string; url?: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }

describe("provider connection check through the real OpenAI adapter and local HTTP server", () => {
	const servers: Server[] = []
	const allowedOrigins = new Set<string>()
	let restoreNock = false
	const nativeFetch = globalThis.fetch

	beforeAll(() => {
		// Nock passthrough drops fetch's dispatcher option; exercise the actual socket transport.
		restoreNock = nock.isActive()
		if (restoreNock) nock.restore()
		const actualFetch = globalThis.fetch
		vi.stubGlobal("fetch", ((input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
			if (!allowedOrigins.has(url.origin))
				throw new Error("Integration test forbids non-fixture network requests")
			return actualFetch(input, init)
		}) as typeof fetch)
	})

	afterEach(async () => {
		await Promise.all(
			servers.splice(0).map(
				(server) =>
					new Promise<void>((resolve, reject) => {
						server.closeAllConnections()
						server.close((error) => (error ? reject(error) : resolve()))
					}),
			),
		)
		allowedOrigins.clear()
		vi.restoreAllMocks()
	})

	afterAll(() => {
		vi.unstubAllGlobals()
		if (restoreNock) nock.activate()
		nock.disableNetConnect()
		// Nock activation restores its own fetch interceptor.
		if (!restoreNock) globalThis.fetch = nativeFetch
	})

	async function fixture(respond: (response: ServerResponse) => void) {
		const requests: CapturedRequest[] = []
		let closed = 0
		const server = createServer((request, response) => {
			const chunks: Buffer[] = []
			response.once("close", () => closed++)
			request.on("data", (data: Buffer) => chunks.push(data))
			request.once("end", () => {
				requests.push({
					method: request.method,
					url: request.url,
					headers: request.headers,
					body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
				})
				respond(response)
			})
		})
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(0, "127.0.0.1", resolve)
		})
		servers.push(server)
		const address = server.address()
		if (!address || typeof address === "string") throw new Error("Expected loopback TCP server")
		const origin = `http://127.0.0.1:${address.port}`
		allowedOrigins.add(origin)
		return { origin, requests, closed: () => closed }
	}

	function draft(origin: string): ProviderSettings {
		return {
			apiProvider: "openai",
			openAiBaseUrl: `${origin}/v1`,
			openAiModelId: "fixture-chat-model",
			openAiApiKey: "fixture-private-api-key",
			openAiHeaders: { "X-Fixture-Secret": "fixture-private-custom-header" },
			openAiStreamingEnabled: true,
			openAiWebSearchEnabled: true,
			openAiWebSearchModelId: "must-not-use-search-model",
			openAiCustomModelInfo: {
				contextWindow: 8192,
				maxTokens: 64,
				supportsPromptCache: false,
				supportsNativeTools: true,
				inputPrice: 0,
				outputPrice: 0,
			},
		}
	}

	function options(signal = new AbortController().signal) {
		return {
			requestId: "loopback-check-id",
			signal,
			extensionVersion: "5.16.239",
			vscodeVersion: "test-runtime",
			timeoutMs: 2_000,
		}
	}

	function streamMetadata(response: ServerResponse) {
		response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_fixture_stream" })
		response.write(
			`data: ${JSON.stringify({ id: "fixture-stream", object: "chat.completion.chunk", created: 0, model: "fixture-chat-model", choices: [] })}\n\n`,
		)
	}

	it("POSTs the fixed generation prompt with the draft model and credentials, with no tools or history", async () => {
		const server = await fixture((response) => {
			streamMetadata(response)
			response.end(
				`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "IVOL_CONNECTION_OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
			)
		})
		const config = draft(server.origin)
		const original = structuredClone(config)
		const result = await runProviderConnectionTest(config, options())
		expect(result.status).toBe("success")
		expect(config).toEqual(original)
		expect(server.requests).toHaveLength(1)
		expect(server.requests[0]).toMatchObject({
			method: "POST",
			url: "/v1/chat/completions",
			headers: {
				authorization: "Bearer fixture-private-api-key",
				"x-fixture-secret": "fixture-private-custom-header",
			},
			body: {
				model: "fixture-chat-model",
				stream: true,
				messages: [
					{ role: "system", content: [{ type: "text", text: "" }] },
					{ role: "user", content: [{ type: "text", text: "Reply with IVOL_CONNECTION_OK only." }] },
				],
			},
		})
		expect(server.requests[0].body).not.toHaveProperty("tools")
		expect(server.requests[0].body).not.toHaveProperty("previous_response_id")
		expect(JSON.stringify(server.requests[0].body)).not.toContain("must-not-use-search-model")
		expect(result.report).not.toContain("IVOL_CONNECTION_OK")
		expect(result.report).not.toContain("fixture-private-api-key")
		expect(result.report).not.toContain("fixture-private-custom-header")
		expect(result.report).toContain("HTTP status: unavailable")
	})

	it.each([401, 503])(
		"preserves real HTTP %s and request ID without logging or copying echoed secrets",
		async (status) => {
			const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
			const server = await fixture((response) => {
				response.writeHead(status, {
					"content-type": "application/json",
					"x-request-id": `req_fixture_${status}`,
				})
				response.end(
					JSON.stringify({
						error: {
							message:
								"fixture-private-api-key fixture-private-custom-header unknown-oauth-token private-account@example.com /Users/private/token",
							code: status === 401 ? "invalid_api_key" : "server_error",
						},
					}),
				)
			})
			const result = await runProviderConnectionTest(draft(server.origin), options())
			expect(result.status).toBe("error")
			expect(result.category).toBe(status === 401 ? "authentication" : "server_error")
			expect(result.report).toContain(`HTTP status: ${status}`)
			expect(result.report).toContain(`Provider request ID: req_fixture_${status}`)
			for (const privateText of [
				"fixture-private-api-key",
				"fixture-private-custom-header",
				"unknown-oauth-token",
				"private-account@example.com",
				"/Users/private",
			])
				expect(result.report).not.toContain(privateText)
			expect(log).not.toHaveBeenCalled()
			expect(server.requests).toHaveLength(1)
		},
	)

	it("cancellation closes a real streaming HTTP response", async () => {
		const server = await fixture(streamMetadata)
		const controller = new AbortController()
		const pending = runProviderConnectionTest(draft(server.origin), options(controller.signal))
		await vi.waitFor(() => expect(server.requests).toHaveLength(1))
		controller.abort()
		expect((await pending).status).toBe("cancelled")
		await vi.waitFor(() => expect(server.closed()).toBe(1), { timeout: 2_000 })
		expect(server.requests).toHaveLength(1)
	})
})
