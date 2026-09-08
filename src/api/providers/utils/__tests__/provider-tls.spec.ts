// kilocode_change - new file
import { execFile, execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer, type Server } from "node:https"
import { connect, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib"

import nock from "nock"
import { Agent, Dispatcher, getGlobalDispatcher, ProxyAgent } from "undici"
import { build } from "esbuild"

import { createProviderFetch, registerProviderTlsDispatcher } from "../provider-tls"
import { createVsCodeProviderFetch } from "../provider-tls-vscode"

describe("provider-scoped TLS opt-out on real loopback HTTPS", () => {
	let directory: string
	let key: Buffer
	let cert: Buffer
	let restoreNock: boolean
	const servers: (Server | ReturnType<typeof createHttpServer>)[] = []
	const sockets = new Set<Socket>()
	const agents: Dispatcher[] = []
	const originalDispatcher = getGlobalDispatcher()
	const originalTlsEnvironment = process.env.NODE_TLS_REJECT_UNAUTHORIZED

	beforeAll(async () => {
		restoreNock = nock.isActive()
		if (restoreNock) nock.restore()
		directory = await mkdtemp(join(tmpdir(), "ivol-provider-tls-test-"))
		// Generate a disposable fixture; never commit a private key or contact an external server.
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-sha256",
				"-days",
				"1",
				"-subj",
				"/CN=localhost",
				"-keyout",
				join(directory, "key.pem"),
				"-out",
				join(directory, "cert.pem"),
			],
			{ stdio: "ignore" },
		)
		key = await readFile(join(directory, "key.pem"))
		cert = await readFile(join(directory, "cert.pem"))
	})

	afterEach(async () => {
		await Promise.all(agents.splice(0).map((agent) => agent.destroy()))
		for (const socket of sockets) socket.destroy()
		sockets.clear()
		await Promise.all(
			servers.splice(0).map(
				(server) =>
					new Promise<void>((resolve, reject) => {
						server.closeAllConnections()
						server.close((error) => (error ? reject(error) : resolve()))
					}),
			),
		)
		expect(getGlobalDispatcher()).toBe(originalDispatcher)
		expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(originalTlsEnvironment)
		vi.restoreAllMocks()
	})

	afterAll(async () => {
		if (directory) await rm(directory, { recursive: true, force: true })
		if (restoreNock) nock.activate()
		nock.disableNetConnect()
	})

	async function listen(server: Server | ReturnType<typeof createHttpServer>, protocol = "https:") {
		server.on("connection", (socket) => {
			sockets.add(socket)
			socket.on("close", () => sockets.delete(socket))
		})
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(0, "127.0.0.1", resolve)
		})
		servers.push(server)
		const address = server.address()
		if (!address || typeof address === "string") throw new Error("Missing loopback address")
		return `${protocol}//127.0.0.1:${address.port}`
	}

	async function startServer(
		handler: (request: IncomingMessage, response: ServerResponse) => void = (_req, res) => res.end("ok"),
	) {
		return listen(createServer({ key, cert }, handler))
	}

	it("rejects self-signed certificates by default, allows only the opted-in profile and remains strict afterwards", async () => {
		const url = await startServer()
		const strict = createProviderFetch({ baseUrl: url })
		const insecure = createProviderFetch({ baseUrl: `${url}/v1`, allowInsecureTls: true })
		await expect(strict(url)).rejects.toMatchObject({ cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } })
		await expect(insecure(url).then((response) => response.text())).resolves.toBe("ok")
		await expect(strict(url)).rejects.toMatchObject({ cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } })
	})

	it("isolates concurrent strict and insecure profiles for the same endpoint", async () => {
		const url = await startServer()
		const results = await Promise.allSettled([
			createProviderFetch({ baseUrl: url, allowInsecureTls: true })(url).then((response) => response.text()),
			createProviderFetch({ baseUrl: url, allowInsecureTls: false })(url),
		])
		expect(results[0]).toEqual({ status: "fulfilled", value: "ok" })
		expect(results[1]).toMatchObject({
			status: "rejected",
			reason: { cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } },
		})
	})

	it("does not disable validation for another origin or a cross-origin redirect", async () => {
		const other = await startServer()
		const first = await startServer((_request, response) =>
			response.writeHead(302, { location: `${other}/redirected` }).end(),
		)
		const fetch = createProviderFetch({ baseUrl: first, allowInsecureTls: true })
		await expect(fetch(other)).rejects.toMatchObject({ cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } })
		await expect(fetch(first)).rejects.toMatchObject({ cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } })
	})

	it.each([undefined, "not a url", "http://127.0.0.1"])(
		"does not broaden opt-out with an invalid/non-HTTPS base URL: %s",
		async (baseUrl) => {
			const url = await startServer()
			await expect(createProviderFetch({ baseUrl, allowInsecureTls: true })(url)).rejects.toMatchObject({
				cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
			})
		},
	)

	it("preserves cancellation after response headers and closes the server response", async () => {
		let closed = false
		const url = await startServer((_request, response) => {
			response.writeHead(200)
			response.flushHeaders()
			response.once("close", () => (closed = true))
		})
		const controller = new AbortController()
		const response = await createProviderFetch({ baseUrl: url, allowInsecureTls: true })(url, {
			signal: controller.signal,
		})
		const body = response.text()
		controller.abort()
		await expect(body).rejects.toMatchObject({ name: "AbortError" })
		await vi.waitFor(() => expect(closed).toBe(true))
	})

	it("preserves configured body idle timeouts with TLS opt-out", async () => {
		const url = await startServer((_request, response) => {
			response.writeHead(200)
			response.flushHeaders()
		})
		const response = await createProviderFetch({ baseUrl: url, allowInsecureTls: true, timeoutMs: 100 })(url)
		await expect(response.text()).rejects.toMatchObject({ cause: { code: "UND_ERR_BODY_TIMEOUT" } })
	})

	it("does not bypass an unregistered custom dispatcher", async () => {
		const url = await startServer()
		const dispatch = vi.fn()
		await expect(
			createProviderFetch({ baseUrl: url, allowInsecureTls: true })(url, {
				dispatcher: { dispatch },
			} as RequestInit),
		).rejects.toMatchObject({ cause: { message: expect.stringContaining("proxy route was not bypassed") } })
		expect(dispatch).not.toHaveBeenCalled()
	})

	it.each(["HTTPS_PROXY", "http_proxy", "ALL_PROXY", "GLOBAL_AGENT_HTTPS_PROXY"])(
		"does not bypass the %s environment route",
		async (name) => {
			const original = process.env[name]
			try {
				process.env[name] = "http://local-fixture.invalid:8080"
				const url = await startServer()
				await expect(createProviderFetch({ baseUrl: url, allowInsecureTls: true })(url)).rejects.toMatchObject({
					cause: { message: expect.stringContaining("environment proxy") },
				})
			} finally {
				if (original === undefined) delete process.env[name]
				else process.env[name] = original
			}
		},
	)

	it.each([{ connect: { timeout: 1000 } }, { factory: () => new Agent() }, { connections: 1 }])(
		"fails closed for a custom Agent configuration: %j",
		async (options) => {
			const agent = new Agent(options)
			agents.push(agent)
			const url = await startServer()
			await expect(
				createProviderFetch({ baseUrl: url, allowInsecureTls: true })(url, {
					dispatcher: agent,
				} as RequestInit),
			).rejects.toMatchObject({ cause: { message: expect.stringContaining("custom network dispatcher") } })
		},
	)

	it("keeps the registered authenticated CONNECT proxy route without changing the strict proxy agent", async () => {
		const url = await startServer()
		const target = new URL(url)
		const proxyRequests: string[] = []
		const proxy = createHttpServer()
		proxy.on("connect", (request, client, head) => {
			proxyRequests.push(request.headers["proxy-authorization"] ?? "")
			if (request.url !== target.host) {
				client.end("HTTP/1.1 403 Forbidden\r\n\r\n")
				return
			}
			const upstream = connect(Number(target.port), "127.0.0.1", () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
				upstream.write(head)
				client.pipe(upstream).pipe(client)
			})
			sockets.add(upstream)
			upstream.on("close", () => sockets.delete(upstream))
			upstream.on("error", () => client.destroy())
			client.on("error", () => upstream.destroy())
		})
		const proxyUrl = await listen(proxy, "http:")
		const proxyOptions = { uri: proxyUrl, token: "Basic local-fixture-only" }
		const delegate = new ProxyAgent(proxyOptions)
		agents.push(delegate)
		registerProviderTlsDispatcher(
			delegate,
			() => new ProxyAgent({ ...proxyOptions, requestTls: { rejectUnauthorized: false } }),
		)
		const init = { dispatcher: delegate } as RequestInit
		await expect(createProviderFetch({ baseUrl: url })(url, init)).rejects.toThrow()
		await expect(
			createProviderFetch({ baseUrl: url, allowInsecureTls: true })(url, init).then((response) =>
				response.text(),
			),
		).resolves.toBe("ok")
		await expect(createProviderFetch({ baseUrl: url })(url, init)).rejects.toThrow()
		expect(proxyRequests).toEqual([proxyOptions.token, proxyOptions.token, proxyOptions.token])
	})

	it("retains certificate validation for the HTTPS proxy itself", async () => {
		const url = await startServer()
		const proxyUrl = await startServer()
		const delegate = new ProxyAgent({ uri: proxyUrl })
		agents.push(delegate)
		registerProviderTlsDispatcher(
			delegate,
			() => new ProxyAgent({ uri: proxyUrl, requestTls: { rejectUnauthorized: false } }),
		)
		await expect(
			createProviderFetch({ baseUrl: url, allowInsecureTls: true })(url, { dispatcher: delegate } as RequestInit),
		).rejects.toMatchObject({ cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } })
	})

	it("works after production minification with native and bundled stock dispatchers", async () => {
		const bundle = join(directory, "provider-tls.cjs")
		await build({
			entryPoints: [join(__dirname, "../provider-tls.ts")],
			outfile: bundle,
			bundle: true,
			minify: true,
			format: "cjs",
			platform: "node",
			logLevel: "silent",
		})
		const url = await startServer()
		const executables = [
			process.execPath,
			...(process.env.IVOL_TLS_TEST_NODE_EXECUTABLE ? [process.env.IVOL_TLS_TEST_NODE_EXECUTABLE] : []),
		]
		for (const executable of executables) {
			for (const nativeFirst of [false, true]) {
				const program = `
					(async () => {
						if (${nativeFirst}) await globalThis.fetch("data:text/plain,initialize-native-dispatcher");
						const {createProviderFetch} = require(process.argv[1]);
						const url = process.argv[2];
						const results = [];
						for (const allowInsecureTls of [false, true, false]) {
							try { results.push(await (await createProviderFetch({baseUrl: url, allowInsecureTls})(url)).text()); }
							catch (error) { results.push(error.cause?.code || error.cause?.message || error.message); }
						}
						process.stdout.write(JSON.stringify(results));
					})().catch(error => { console.error(error); process.exitCode = 1; });
				`
				const result = await promisify(execFile)(executable, ["-e", program, bundle, url], {
					env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
					timeout: 10_000,
				})
				expect(JSON.parse(result.stdout)).toEqual([
					"DEPTH_ZERO_SELF_SIGNED_CERT",
					"ok",
					"DEPTH_ZERO_SELF_SIGNED_CERT",
				])
			}
		}
	})

	describe("portable VS Code HTTPS adapter semantics", () => {
		it.each([
			["gzip", gzipSync],
			["deflate", deflateSync],
			["br", brotliCompressSync],
		] as const)("preserves request bodies/headers and decodes %s responses", async (encoding, encode) => {
			let receivedBody = ""
			let receivedAuthorization: string | undefined
			const url = await startServer((request, response) => {
				receivedAuthorization = request.headers.authorization
				request.setEncoding("utf8")
				request.on("data", (chunk) => (receivedBody += chunk))
				request.on("end", () =>
					response
						.writeHead(200, { "content-encoding": encoding })
						.end(encode(Buffer.from('{"answer":"ok"}'))),
				)
			})
			const request = new Request(url, {
				method: "POST",
				body: '{"prompt":"fixture-only"}',
				headers: { Authorization: "Bearer fixture-only", "Content-Type": "application/json" },
			})
			await expect(createVsCodeProviderFetch(url)(request).then((response) => response.json())).resolves.toEqual({
				answer: "ok",
			})
			expect(receivedBody).toBe('{"prompt":"fixture-only"}')
			expect(receivedAuthorization).toBe("Bearer fixture-only")
		})

		it("returns a valid empty 204 response", async () => {
			const url = await startServer((_request, response) => response.writeHead(204).end())
			const response = await createVsCodeProviderFetch(url)(url)
			expect(response.status).toBe(204)
			expect(response.body).toBeNull()
			await expect(response.text()).resolves.toBe("")
		})

		it("closes the node response when its web stream is cancelled", async () => {
			let closed = false
			const url = await startServer((_request, response) => {
				response.writeHead(200)
				response.write("stream-start")
				response.once("close", () => (closed = true))
			})
			const response = await createVsCodeProviderFetch(url)(url)
			const reader = response.body!.getReader()
			await expect(reader.read()).resolves.toMatchObject({ done: false })
			await reader.cancel()
			await vi.waitFor(() => expect(closed).toBe(true))
		})

		it("propagates abort after response headers", async () => {
			let closed = false
			const url = await startServer((_request, response) => {
				response.writeHead(200)
				response.flushHeaders()
				response.once("close", () => (closed = true))
			})
			const controller = new AbortController()
			const response = await createVsCodeProviderFetch(url)(url, { signal: controller.signal })
			const body = response.text()
			controller.abort()
			await expect(body).rejects.toMatchObject({ name: "AbortError" })
			await vi.waitFor(() => expect(closed).toBe(true))
		})

		it("enforces header and body idle timeouts", async () => {
			const headerUrl = await startServer(() => undefined)
			await expect(createVsCodeProviderFetch(headerUrl, 100)(headerUrl)).rejects.toMatchObject({
				cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
			})
			const bodyUrl = await startServer((_request, response) => {
				response.writeHead(200)
				response.flushHeaders()
			})
			const response = await createVsCodeProviderFetch(bodyUrl, 100)(bodyUrl)
			await expect(response.text()).rejects.toMatchObject({ cause: { code: "UND_ERR_BODY_TIMEOUT" } })
		})

		it("rejects a 101 upgrade instead of leaving fetch unresolved", async () => {
			const url = await startServer((_request, response) => {
				response.writeHead(101, { Upgrade: "websocket", Connection: "Upgrade" })
				response.flushHeaders()
			})
			await expect(createVsCodeProviderFetch(url, 100)(url)).rejects.toThrow("protocol upgrade")
		})

		it("can abort an unread buffered gzip body even after the socket has closed", async () => {
			const url = await startServer((_request, response) => {
				response.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(Buffer.alloc(1_000_000, "A")))
			})
			const controller = new AbortController()
			const response = await createVsCodeProviderFetch(url)(url, { signal: controller.signal })
			await new Promise((resolve) => setTimeout(resolve, 50))
			controller.abort()
			await expect(response.text()).rejects.toMatchObject({ name: "AbortError" })
		})

		it("cancels a discarded dripping redirect body before following", async () => {
			let redirectClosed = false
			const url = await startServer((request, response) => {
				if (request.url === "/done") {
					response.end("complete")
					return
				}
				response.writeHead(302, { location: "/done" })
				response.write("ignored-start")
				const timer = setInterval(() => response.write("ignored-drip"), 20)
				response.once("close", () => {
					clearInterval(timer)
					redirectClosed = true
				})
			})
			await expect(createVsCodeProviderFetch(url)(url).then((response) => response.text())).resolves.toBe(
				"complete",
			)
			await vi.waitFor(() => expect(redirectClosed).toBe(true))
		})

		it("does not carry opt-out to a different HTTPS origin", async () => {
			const other = await startServer()
			const url = await startServer((_request, response) => response.writeHead(302, { location: other }).end())
			await expect(createVsCodeProviderFetch(url)(url)).rejects.toMatchObject({
				code: "DEPTH_ZERO_SELF_SIGNED_CERT",
			})
		})

		it("strips credentials on cross-origin GET and refuses to replay a POST body there", async () => {
			const receivedHeaders: IncomingMessage["headers"][] = []
			const other = await listen(
				createHttpServer((request, response) => {
					receivedHeaders.push(request.headers)
					response.end("ok")
				}),
				"http:",
			)
			const url = await startServer((request, response) =>
				response.writeHead(request.method === "POST" ? 307 : 302, { location: other }).end(),
			)
			const fetch = createVsCodeProviderFetch(url)
			await expect(
				fetch(url, { headers: { Authorization: "Bearer fixture-only", Cookie: "fixture-only" } }).then(
					(response) => response.text(),
				),
			).resolves.toBe("ok")
			expect(receivedHeaders).toHaveLength(1)
			expect(receivedHeaders[0].authorization).toBeUndefined()
			expect(receivedHeaders[0].cookie).toBeUndefined()
			await expect(fetch(url, { method: "POST", body: "private-fixture-body" })).rejects.toThrow(
				"request body was not forwarded",
			)
			expect(receivedHeaders).toHaveLength(1)
		})
	})
})
