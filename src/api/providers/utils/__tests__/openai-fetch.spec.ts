// kilocode_change - new file
import { createServer, type Server, type ServerResponse } from "node:http"

import nock from "nock"
import OpenAI from "openai"
import { Agent, type Dispatcher, getGlobalDispatcher } from "undici"

import { createOpenAiFetch } from "../openai-fetch"

type FetchOptionsWithDispatcher = RequestInit & { dispatcher: Pick<Dispatcher, "dispatch"> }

describe("createOpenAiFetch local HTTP transport", () => {
	const agents: Agent[] = []
	const servers: Server[] = []
	let restoreNock = false

	beforeAll(() => {
		// Nock's fetch passthrough rebuilds Request and drops the nonstandard dispatcher option.
		// Exercise the real fetch transport here; every server binds exclusively to loopback.
		restoreNock = nock.isActive()
		if (restoreNock) {
			nock.restore()
		}
	})

	afterEach(async () => {
		await Promise.all(agents.splice(0).map((agent) => agent.destroy()))
		await Promise.all(
			servers.splice(0).map(
				(server) =>
					new Promise<void>((resolve, reject) => {
						server.closeAllConnections()
						server.close((error) => (error ? reject(error) : resolve()))
					}),
			),
		)
	})

	afterAll(() => {
		if (restoreNock) {
			nock.activate()
		}
		nock.disableNetConnect()
	})

	function createAgent() {
		const agent = new Agent({ connections: 1 })
		agents.push(agent)
		return agent
	}

	async function startServer(onResponse: (response: ServerResponse) => void) {
		let closedResponses = 0
		const server = createServer((request, response) => {
			request.resume()
			response.on("close", () => closedResponses++)
			onResponse(response)
		})
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(0, "127.0.0.1", resolve)
		})
		servers.push(server)
		const address = server.address()
		if (!address || typeof address === "string") {
			throw new Error("Expected an ephemeral loopback TCP address")
		}
		return {
			url: `http://127.0.0.1:${address.port}`,
			getClosedResponses: () => closedResponses,
		}
	}

	function metadataStream(response: ServerResponse) {
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"x-request-id": "local-transport-test",
		})
		response.write(
			`data: ${JSON.stringify({
				id: "local-stream",
				object: "chat.completion.chunk",
				created: 0,
				model: "local-test-model",
				choices: [],
			})}\n\n`,
		)
	}

	function createClient(url: string, timeoutMs: number) {
		const fetchOptions = { dispatcher: createAgent() }
		return new OpenAI({
			apiKey: "local-test-key",
			baseURL: `${url}/v1`,
			maxRetries: 0,
			timeout: 5_000,
			fetch: createOpenAiFetch(timeoutMs),
			fetchOptions,
		})
	}

	it("overrides the inherited body timeout after immediate headers without replacing the parent dispatcher", async () => {
		const configuredTimeout = 5_000
		const globalDispatcher = getGlobalDispatcher()
		const fixture = await startServer((response) => {
			response.writeHead(200, { "content-type": "text/plain" })
			response.flushHeaders()
			const timer = setTimeout(() => response.end("completed after an idle gap"), 1_800)
			response.once("close", () => clearTimeout(timer))
		})
		const agent = createAgent()
		const parentDispatcher = {
			dispatch: vi.fn((options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers) =>
				agent.dispatch(
					{
						...options,
						// Compress native fetch's 300-second default for a fast regression test.
						// Explicit shorter per-request settings still reach the real Agent unchanged.
						bodyTimeout: options.bodyTimeout && options.bodyTimeout < 300_000 ? options.bodyTimeout : 100,
					},
					handler,
				),
			),
		}
		const options: FetchOptionsWithDispatcher = { dispatcher: parentDispatcher }

		const baseline = await globalThis.fetch(fixture.url, options)
		await expect(baseline.text()).rejects.toMatchObject({ cause: { code: "UND_ERR_BODY_TIMEOUT" } })

		const response = await createOpenAiFetch(configuredTimeout)(fixture.url, options)
		expect(response.status).toBe(200)
		await expect(response.text()).resolves.toBe("completed after an idle gap")
		expect(parentDispatcher.dispatch).toHaveBeenCalledTimes(2)
		expect(parentDispatcher.dispatch.mock.calls[1][0]).toMatchObject({
			headersTimeout: configuredTimeout,
			bodyTimeout: configuredTimeout,
		})
		expect(options.dispatcher).toBe(parentDispatcher)
		expect(getGlobalDispatcher()).toBe(globalDispatcher)
	})

	it("still rejects a stalled body after headers when the configured idle timeout expires", async () => {
		const fixture = await startServer((response) => {
			response.writeHead(200, { "content-type": "text/plain" })
			response.flushHeaders()
		})
		const options: FetchOptionsWithDispatcher = { dispatcher: createAgent() }
		const response = await createOpenAiFetch(100)(fixture.url, options)

		expect(response.status).toBe(200)
		await expect(response.text()).rejects.toMatchObject({ cause: { code: "UND_ERR_BODY_TIMEOUT" } })
		await vi.waitFor(() => expect(fixture.getClosedResponses()).toBe(1), { timeout: 2_000 })
	})

	it("closes the HTTP response when an OpenAI metadata-only stream is aborted", async () => {
		const fixture = await startServer(metadataStream)
		const client = createClient(fixture.url, 5_000)
		const stream = await client.chat.completions.create({
			model: "local-test-model",
			messages: [{ role: "user", content: "Local transport test" }],
			stream: true,
		})
		const iterator = stream[Symbol.asyncIterator]()
		await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { choices: [] } })
		const pendingRead = iterator.next()

		stream.controller.abort()

		await expect(pendingRead).resolves.toMatchObject({ done: true })
		await vi.waitFor(() => expect(fixture.getClosedResponses()).toBe(1), { timeout: 2_000 })
	})

	it("closes the HTTP response when the OpenAI stream iterator is returned early", async () => {
		const fixture = await startServer(metadataStream)
		const client = createClient(fixture.url, 5_000)
		const stream = await client.chat.completions.create({
			model: "local-test-model",
			messages: [{ role: "user", content: "Local transport test" }],
			stream: true,
		})
		const iterator = stream[Symbol.asyncIterator]()
		await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { choices: [] } })

		expect(iterator.return).toBeTypeOf("function")
		await iterator.return?.()

		expect(stream.controller.signal.aborted).toBe(true)
		await vi.waitFor(() => expect(fixture.getClosedResponses()).toBe(1), { timeout: 2_000 })
	})

	it("allows total streaming time to exceed the timeout while body chunks keep arriving", async () => {
		const configuredTimeout = 800
		const fixture = await startServer((response) => {
			response.writeHead(200, { "content-type": "text/plain" })
			response.write("0,")
			let chunk = 0
			const timer = setInterval(() => {
				chunk++
				response.write(`${chunk},`)
				if (chunk === 12) {
					clearInterval(timer)
					response.end("done")
				}
			}, 150)
			response.once("close", () => clearInterval(timer))
		})
		const options: FetchOptionsWithDispatcher = { dispatcher: createAgent() }
		const startedAt = performance.now()
		const response = await createOpenAiFetch(configuredTimeout)(fixture.url, options)

		await expect(response.text()).resolves.toBe("0,1,2,3,4,5,6,7,8,9,10,11,12,done")
		expect(performance.now() - startedAt).toBeGreaterThan(configuredTimeout * 2)
	})
})
