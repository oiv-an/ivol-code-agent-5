// kilocode_change - new file
import WebSocket from "ws"
import nock from "nock"
import { ChromeConnector } from "../kilocode/ChromeConnector"
import { BrowserOSAccess, validateBrowserOSEndpoint } from "../kilocode/BrowserOSAccess"

it("restricts BrowserOS endpoints to explicit loopback HTTP addresses", () => {
	expect(validateBrowserOSEndpoint("http://127.0.0.1:9200/mcp")).toBe("http://127.0.0.1:9200/mcp")
	for (const value of [
		"https://example.com/mcp",
		"http://localhost:9200/mcp",
		"http://user:password@127.0.0.1/mcp",
		"http://127.0.0.1/mcp?token=value",
	])
		expect(() => validateBrowserOSEndpoint(value)).toThrow()
})

it("gates BrowserOS by host consent, connection, observation and manual control epoch", async () => {
	const access = new BrowserOSAccess()
	const owner = {}
	const connection = {}
	const request = vi.fn().mockResolvedValue("page")
	await expect(access.execute(owner, connection, { kind: "observation", page: 7 }, request)).rejects.toThrow(
		"not been granted",
	)
	expect(request).not.toHaveBeenCalled()
	await access.acquire(owner, connection, async () => true)
	await access.execute(owner, connection, { kind: "observation", page: 7 }, async () => ({
		isError: true,
		content: [],
	}))
	expect(access.getStatus()).toBe("idle")
	await expect(access.execute(owner, connection, { kind: "interaction", page: 7 }, request)).rejects.toThrow(
		"not been granted",
	)
	await access.acquire(owner, connection, async () => true)
	await expect(access.execute(owner, connection, { kind: "interaction", page: 7 }, request)).rejects.toThrow("fresh")
	await expect(access.execute(owner, connection, { kind: "observation", page: 7 }, request)).resolves.toBe("page")
	const confirmAgain = vi.fn()
	await access.acquire({}, connection, confirmAgain)
	expect(confirmAgain).not.toHaveBeenCalled()
	access.pause()
	await expect(access.execute(owner, connection, { kind: "observation", page: 7 }, request)).rejects.toThrow("paused")
	access.resume()
	await expect(access.execute(owner, connection, { kind: "interaction", page: 7 }, request)).rejects.toThrow("fresh")
	let finish!: (value: string) => void
	const pending = access.execute(
		owner,
		connection,
		{ kind: "observation", page: 7 },
		() =>
			new Promise<string>((resolve) => {
				finish = resolve
			}),
	)
	await vi.waitFor(() => expect(finish).toBeDefined())
	access.revoke(owner)
	finish("stale page")
	await expect(pending).rejects.toThrow("access changed")
	expect(access.getStatus()).toBe("idle")
})

it("requires nonempty MCP observation content before BrowserOS interactions", async () => {
	const access = new BrowserOSAccess()
	const owner = {}
	const connection = {}
	await access.acquire(owner, connection, async () => true)
	for (const result of [
		{ content: [] },
		{ content: [{ type: "text", text: "  " }] },
		{ content: [{ type: "image", mimeType: "image/svg+xml", data: "YQ==" }] },
	]) {
		await access.execute(owner, connection, { kind: "observation", page: 7 }, async () => result)
		await expect(
			access.execute(owner, connection, { kind: "interaction", page: 7 }, async () => "act"),
		).rejects.toThrow("fresh")
	}
	await access.execute(owner, connection, { kind: "observation", page: 7 }, async () => ({
		content: [{ type: "text", text: "Page tree" }],
	}))
	await expect(access.execute(owner, connection, { kind: "interaction", page: 7 }, async () => "act")).resolves.toBe(
		"act",
	)
	access.pause()
	access.resume()
	await access.execute(owner, connection, { kind: "observation", page: 7 }, async () => ({
		content: [{ type: "image", mimeType: "image/png", data: "YQ==" }],
	}))
	await expect(access.execute(owner, connection, { kind: "interaction", page: 7 }, async () => "act")).resolves.toBe(
		"act",
	)
})

it("revokes BrowserOS on tool errors without retaining or replaying a stopped session", async () => {
	const access = new BrowserOSAccess()
	const owner = {}
	const connection = {}
	await access.acquire(owner, connection, async () => true)
	await access.execute(owner, connection, { kind: "discovery" }, async () => ({
		_meta: { "com.browseros.neo/session": "old-session" },
		content: [],
	}))
	const request = vi.fn().mockResolvedValue({
		isError: true,
		content: [{ type: "text", text: "Session stopped" }],
		_meta: { "com.browseros.neo/session": "stopped-session" },
	})
	const result = await access.execute(owner, connection, { kind: "observation", page: 7 }, request)
	expect(result).toEqual({
		isError: true,
		content: [{ type: "text", text: "Session stopped" }],
		_meta: {},
	})
	expect(access.getStatus()).toBe("idle")
	expect(access.toolArguments()).toEqual({})
	await expect(access.execute(owner, connection, { kind: "observation", page: 7 }, request)).rejects.toThrow(
		"not been granted",
	)
	expect(request).toHaveBeenCalledOnce()
})

it("revokes a failed BrowserOS request without replaying it", async () => {
	const access = new BrowserOSAccess()
	const owner = {}
	const connection = {}
	const request = vi.fn().mockRejectedValue(new Error("Connection lost"))
	await access.acquire(owner, connection, async () => true)
	await expect(access.execute(owner, connection, { kind: "observation", page: 7 }, request)).rejects.toThrow(
		"Connection lost",
	)
	expect(access.getStatus()).toBe("idle")
	await expect(access.execute(owner, connection, { kind: "observation", page: 7 }, request)).rejects.toThrow(
		"not been granted",
	)
	expect(request).toHaveBeenCalledOnce()
})

it("ignores late BrowserOS failures and disconnects from a replaced grant", async () => {
	const access = new BrowserOSAccess()
	const owner = {}
	const oldConnection = {}
	const newConnection = {}
	await access.acquire(owner, oldConnection, async () => true)
	let rejectRequest!: (error: Error) => void
	const pending = access.execute(
		owner,
		oldConnection,
		{ kind: "observation", page: 7 },
		() =>
			new Promise((_, reject) => {
				rejectRequest = reject
			}),
	)
	const rejected = expect(pending).rejects.toThrow("Old transport")
	await vi.waitFor(() => expect(rejectRequest).toBeDefined())
	access.revokeConnection(oldConnection)
	await access.acquire(owner, newConnection, async () => true)
	access.revokeConnection(oldConnection)
	rejectRequest(new Error("Old transport"))
	await rejected
	expect(access.getStatus()).toBe("active")
	await expect(
		access.execute(owner, newConnection, { kind: "interaction", page: 7 }, async () => "click"),
	).rejects.toThrow("fresh")
	access.revokeConnection(newConnection)
	expect(access.getStatus()).toBe("idle")
})

it("keeps BrowserOS discovery separate from observation and privately carries its session", async () => {
	const access = new BrowserOSAccess()
	const owner = {}
	const connection = {}
	await access.acquire(owner, connection, async () => true)
	expect(access.toolArguments({ action: "list", session: "model-supplied" })).toEqual({ action: "list" })
	const result = await access.execute(owner, connection, { kind: "discovery" }, async () => ({
		content: [{ type: "text", text: "Page 7" }],
		_meta: { "com.browseros.neo/session": "server-handle", other: "retained" },
	}))
	expect(result._meta).toEqual({ other: "retained" })
	expect(access.toolArguments({ page: 7, session: "wrong" })).toEqual({ page: 7, session: "server-handle" })
	const act = vi.fn()
	await expect(access.execute(owner, connection, { kind: "interaction", page: 7 }, act)).rejects.toThrow("fresh")
	expect(act).not.toHaveBeenCalled()
	await access.execute(owner, connection, { kind: "observation", page: 7 }, async () => ({
		content: [{ type: "text", text: "Page tree" }],
	}))
	await access.execute(owner, connection, { kind: "interaction", page: 7 }, async () => "clicked")
	access.pause()
	access.resume()
	expect(access.toolArguments()).toEqual({ session: "server-handle" })
	await expect(access.execute(owner, connection, { kind: "interaction", page: 7 }, act)).rejects.toThrow("fresh")
	access.revoke()
	await access.acquire({}, connection, async () => true)
	expect(access.toolArguments()).toEqual({})
})

it("does not retain BrowserOS session metadata from a revoked in-flight response", async () => {
	const access = new BrowserOSAccess()
	const owner = {}
	const connection = {}
	await access.acquire(owner, connection, async () => true)
	let finish!: (value: unknown) => void
	const pending = access.execute(
		owner,
		connection,
		{ kind: "discovery" },
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const rejected = expect(pending).rejects.toThrow("access changed")
	await vi.waitFor(() => expect(finish).toBeDefined())
	access.revoke()
	finish({ _meta: { "com.browseros.neo/session": "expired-handle" } })
	await rejected
	expect(access.toolArguments()).toEqual({})
})

it("invalidates BrowserOS page observations after interactions, empty captures and manual control", async () => {
	const access = new BrowserOSAccess()
	const owner = {}
	const connection = {}
	const capture = async () => ({ content: [{ type: "text", text: "Page tree" }] })
	const act = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Changed" }] })
	await expect(access.execute(owner, connection, { kind: "create" }, act)).rejects.toThrow("not been granted")
	await access.acquire(owner, connection, async () => true)
	await access.execute(owner, connection, { kind: "create" }, act)
	await expect(access.execute(owner, connection, { kind: "interaction", page: 8 }, act)).rejects.toThrow("fresh")
	await access.execute(owner, connection, { kind: "observation", page: 7 }, capture)
	await expect(access.execute(owner, connection, { kind: "interaction", page: 8 }, act)).rejects.toThrow("fresh")
	await access.execute(owner, connection, { kind: "observation", page: 8 }, capture)
	await access.execute(owner, connection, { kind: "interaction", page: 7 }, act)
	for (const page of [7, 8])
		await expect(access.execute(owner, connection, { kind: "interaction", page }, act)).rejects.toThrow("fresh")
	await access.execute(owner, connection, { kind: "observation", page: 7 }, capture)
	await access.execute(owner, connection, { kind: "observation", page: 7 }, async () => ({ content: [] }))
	await expect(access.execute(owner, connection, { kind: "interaction", page: 7 }, act)).rejects.toThrow("fresh")
	await access.execute(owner, connection, { kind: "observation", page: 7 }, capture)
	access.pause()
	await expect(access.execute(owner, connection, { kind: "create" }, act)).rejects.toThrow("paused")
	access.resume()
	await expect(access.execute(owner, connection, { kind: "interaction", page: 7 }, act)).rejects.toThrow("fresh")
	expect(act).toHaveBeenCalledTimes(2)
})

const origin = `chrome-extension://${"a".repeat(32)}`
const snapshot = {
	screenshot: "data:image/png;base64,YQ==",
	currentUrl: "https://example.com",
	viewportWidth: 900,
	viewportHeight: 600,
}
const chromeCaller = {}
const anotherChromeCaller = {}
let connector: ChromeConnector
let client: WebSocket | undefined

beforeEach(() => {
	nock.enableNetConnect("127.0.0.1")
	connector = new ChromeConnector()
	;(connector as any).discoveryPorts = [0]
})
afterEach(async () => {
	client?.terminate()
	client = undefined
	await connector.stop()
	nock.disableNetConnect()
})

async function connect() {
	const pairing = JSON.parse(await connector.startPairing())
	client = new WebSocket(`ws://127.0.0.1:${pairing.port}/ivol-browser`, [`ivol-auth-${pairing.token}`], { origin })
	await new Promise<void>((resolve, reject) => {
		client!.once("open", resolve)
		client!.once("error", reject)
	})
	return client
}

it("discovers a chat connection without user codes and still requires task approval", async () => {
	const acquired = connector.acquire(chromeCaller)
	const outcome = acquired.catch((error) => {
		throw error
	})
	let port = 0
	await vi.waitFor(() => {
		const address = (connector as any).server?.address()
		expect(address?.port).toBeGreaterThan(0)
		port = address.port
	})
	const { request } = await import("node:http")
	const discover = (requestOrigin: string) =>
		new Promise<{ status: number; body: string }>((resolve, reject) => {
			const req = request(
				`http://127.0.0.1:${port}/ivol-browser/discover`,
				{
					method: "POST",
					headers: { Origin: requestOrigin, "X-IVOL-Connector": "1" },
				},
				(res) => {
					let body = ""
					res.on("data", (chunk) => {
						body += chunk
					})
					res.on("end", () => resolve({ status: res.statusCode!, body }))
				},
			)
			req.on("error", reject)
			req.end()
		})
	expect((await discover("https://example.com")).status).toBe(404)
	const response = await discover(origin)
	expect(response.status).toBe(200)
	const config = JSON.parse(response.body)
	client = new WebSocket(`ws://127.0.0.1:${config.port}/ivol-browser`, [`ivol-auth-${config.token}`], { origin })
	let authorization: any
	client.on("message", (raw) => {
		const message = JSON.parse(raw.toString())
		if (message.method === "authorize") authorization = message
		else client!.send(JSON.stringify({ id: message.id, result: {} }))
	})
	await vi.waitFor(() => expect(authorization).toBeDefined())
	expect(connector.hasSession()).toBe(false)
	expect((await discover(origin)).status).toBe(404)
	client.send(JSON.stringify({ id: authorization.id, result: { approved: true } }))
	await outcome
	expect(connector.hasSession()).toBe(true)
	await connector.release()
	expect(connector.getStatus()).toBe("disconnected")
})

it.each(["ended", "changed"])("cancels automatic discovery when its caller %s", async (state) => {
	let current = true
	const acquiring = connector.acquire(
		chromeCaller,
		undefined,
		"Browser",
		async () => true,
		() => current,
	)
	const rejected = expect(acquiring).rejects.toThrow("cancelled")
	await vi.waitFor(() => expect((connector as any).discovering).toBe(true))
	if (state === "ended") connector.endTask(chromeCaller)
	else current = false
	await rejected
	expect(connector.getStatus()).toBe("disconnected")
	expect((connector as any).server).toBeUndefined()
})

it("cancels automatic discovery when its task is released", async () => {
	const acquiring = connector.acquire(chromeCaller)
	const rejected = expect(acquiring).rejects.toThrow("cancelled")
	await vi.waitFor(() => expect((connector as any).discovering).toBe(true))
	await connector.release()
	await rejected
	expect(connector.hasSession()).toBe(false)
	expect((connector as any).server).toBeUndefined()
})

it("closes the discovery listener when no browser answers in time", async () => {
	vi.useFakeTimers()
	try {
		const acquiring = connector.acquire(chromeCaller)
		const rejected = expect(acquiring).rejects.toThrow("Open Chrome")
		await vi.waitUntil(() => (connector as any).discovering, { interval: 1 })
		await vi.advanceTimersByTimeAsync(45_100)
		await rejected
		expect((connector as any).server).toBeUndefined()
		expect((connector as any).discovering).toBe(false)
	} finally {
		vi.useRealTimers()
	}
})

it("skips a discovery port already used by another editor", async () => {
	const { createServer } = await import("node:http")
	const blocker = createServer()
	await new Promise<void>((resolve, reject) => {
		blocker.once("error", reject)
		blocker.listen(0, "127.0.0.1", resolve)
	})
	const blockedPort = (blocker.address() as import("node:net").AddressInfo).port
	;(connector as any).discoveryPorts = [blockedPort, 0]
	try {
		const acquiring = connector.acquire(chromeCaller)
		acquiring.catch(() => undefined)
		await vi.waitFor(() => {
			const address = (connector as any).server?.address()
			expect(address?.port).toBeGreaterThan(0)
			expect(address?.port).not.toBe(blockedPort)
		})
		await connector.release()
		await expect(acquiring).rejects.toThrow("cancelled")
	} finally {
		await new Promise<void>((resolve) => blocker.close(() => resolve()))
	}
})

it("frees an automatic connection when the user rejects the request", async () => {
	const acquiring = connector.acquire(chromeCaller)
	const rejected = expect(acquiring).rejects.toThrow()
	let port = 0
	await vi.waitFor(() => {
		const address = (connector as any).server?.address()
		expect(address?.port).toBeGreaterThan(0)
		port = address.port
	})
	const token = (connector as any).secret
	client = new WebSocket(`ws://127.0.0.1:${port}/ivol-browser`, [`ivol-auth-${token}`], { origin })
	client.on("message", (raw) => {
		const message = JSON.parse(raw.toString())
		client!.send(JSON.stringify({ id: message.id, error: "Access rejected" }))
	})
	await rejected
	expect(connector.getStatus()).toBe("disconnected")
	expect((connector as any).server).toBeUndefined()
})

it("cancels pairing when stopped before the listener starts", async () => {
	const pairing = connector.startPairing()
	const rejected = expect(pairing).rejects.toThrow("cancelled")
	await connector.stop()
	await rejected
	expect(connector.getStatus()).toBe("disconnected")
})

it("rejects simultaneous pairing attempts without creating a second listener", async () => {
	const first = connector.startPairing()
	await expect(connector.startPairing()).rejects.toThrow("already starting")
	const pairing = JSON.parse(await first)
	client = new WebSocket(`ws://127.0.0.1:${pairing.port}/ivol-browser`, [`ivol-auth-${pairing.token}`], { origin })
	await new Promise<void>((resolve, reject) => {
		client!.once("open", resolve)
		client!.once("error", reject)
	})
	expect(connector.getStatus()).toBe("connected")
})

it("rejects web page origins even with a valid pairing token", async () => {
	const pairing = JSON.parse(await connector.startPairing())
	client = new WebSocket(`ws://127.0.0.1:${pairing.port}/ivol-browser`, [`ivol-auth-${pairing.token}`], {
		origin: "https://example.com",
	})
	const error = await new Promise<Error>((resolve) => client!.once("error", resolve))
	expect(error.message).toContain("403")
	expect(connector.getStatus()).toBe("disconnected")
})

it("sends no authorization or page request when explicit Chrome consent is declined", async () => {
	const socket = await connect()
	const sent = vi.fn()
	socket.on("message", sent)
	const confirm = vi.fn().mockResolvedValue(false)
	await expect(connector.acquire(chromeCaller, "https://example.com", "Research", confirm)).rejects.toThrow(
		"declined",
	)
	expect(confirm).toHaveBeenCalledOnce()
	expect(sent).not.toHaveBeenCalled()
	expect(connector.hasSession()).toBe(false)
})

it("does not authorize Chrome after the invoking chat changes during consent", async () => {
	const socket = await connect()
	const sent = vi.fn()
	socket.on("message", sent)
	let current = true
	await expect(
		connector.acquire(
			chromeCaller,
			"https://example.com",
			"Research",
			async () => {
				current = false
				return true
			},
			() => current,
		),
	).rejects.toThrow("expired")
	expect(sent).not.toHaveBeenCalled()
	expect(connector.hasSession()).toBe(false)
})

it.each(["changed", "ended"])(
	"discards Chrome authorization if its caller %s while awaiting the connector",
	async (state) => {
		const socket = await connect()
		let current = true
		socket.on("message", (data) => {
			const request = JSON.parse(data.toString())
			if (state === "changed") current = false
			else connector.endTask(chromeCaller)
			socket.send(JSON.stringify({ id: request.id, result: { approved: true } }))
		})
		await expect(
			connector.acquire(
				chromeCaller,
				"https://example.com",
				"Research",
				async () => true,
				() => current,
			),
		).rejects.toThrow("expired")
		expect(connector.hasSession()).toBe(false)
	},
)

it("does not reactivate control when pause wins against an in-flight resume reply", async () => {
	const socket = await connect()
	let replyResume: (() => void) | undefined
	socket.on("message", (data) => {
		const request = JSON.parse(data.toString())
		const reply = () => socket.send(JSON.stringify({ id: request.id, result: { approved: true } }))
		if (request.method === "resume") replyResume = reply
		else reply()
	})
	await connector.acquire(chromeCaller)
	await connector.pause()
	const resuming = connector.resume(
		async () => true,
		() => true,
	)
	const rejected = expect(resuming).rejects.toThrow("expired")
	await vi.waitFor(() => expect(replyResume).toBeDefined())
	await connector.pause()
	replyResume!()
	await rejected
	expect(connector.getStatus()).toBe("disconnected")
	expect(connector.hasSession()).toBe(false)
})

it("serializes resume consent and lets a new pause cancel the pending decision", async () => {
	const socket = await connect()
	const methods: string[] = []
	socket.on("message", (data) => {
		const request = JSON.parse(data.toString())
		methods.push(request.method)
		socket.send(JSON.stringify({ id: request.id, result: { approved: true } }))
	})
	await connector.acquire(chromeCaller)
	await connector.pause()
	let finish!: (approved: boolean) => void
	const pending = connector.resume(
		() =>
			new Promise<boolean>((resolve) => {
				finish = resolve
			}),
		() => true,
	)
	const rejected = expect(pending).rejects.toThrow("expired")
	const duplicate = vi.fn().mockResolvedValue(true)
	await expect(connector.resume(duplicate, () => true)).rejects.toThrow("already pending")
	expect(duplicate).not.toHaveBeenCalled()
	await connector.pause()
	finish(true)
	await rejected
	expect(methods).not.toContain("resume")
	expect(connector.getStatus()).toBe("paused")
})

it("requires explicit resume consent and a fresh snapshot after an IDE pause", async () => {
	const socket = await connect()
	const methods: string[] = []
	socket.on("message", (data) => {
		const request = JSON.parse(data.toString())
		methods.push(request.method)
		socket.send(
			JSON.stringify({ id: request.id, result: request.method === "authorize" ? { approved: true } : snapshot }),
		)
	})
	await connector.acquire(chromeCaller)
	await connector.pause()
	expect(connector.getStatus()).toBe("paused")
	await expect(connector.action(chromeCaller, "snapshot")).rejects.toThrow("not active")
	await connector.resume(
		async () => false,
		() => true,
	)
	expect(methods).not.toContain("resume")
	await connector.resume(
		async () => true,
		() => true,
	)
	expect(connector.getStatus()).toBe("active")
	await expect(connector.action(chromeCaller, "click")).rejects.toThrow("fresh screenshot")
	await connector.action(chromeCaller, "snapshot")
	await connector.action(chromeCaller, "click")
})

it("requires host approval and supports explicit revocation", async () => {
	const socket = await connect()
	let sessionId = ""
	socket.on("message", (data) => {
		const request = JSON.parse(data.toString())
		if (request.method === "authorize") sessionId = request.params.sessionId
		socket.send(
			JSON.stringify({ id: request.id, result: request.method === "authorize" ? { approved: true } : snapshot }),
		)
	})
	await expect(connector.action(chromeCaller, "snapshot")).rejects.toThrow("not active")
	await connector.acquire(chromeCaller)
	expect(connector.hasSession()).toBe(true)
	expect(connector.hasSession()).toBe(true)
	await expect(connector.action(chromeCaller, "snapshot")).resolves.toEqual(snapshot)
	await expect(connector.acquire(anotherChromeCaller)).resolves.toBeUndefined()
	socket.send(JSON.stringify({ event: "revoked", sessionId }))
	await vi.waitFor(() => expect(connector.getStatus()).toBe("connected"))
	expect(connector.hasSession()).toBe(false)
	await expect(connector.action(chromeCaller, "click", { x: 1, y: 2 })).rejects.toThrow("not active")
})

it("retains host consent across callers but rejects commands from a stale caller", async () => {
	const socket = await connect()
	const previous = {},
		current = {}
	let approvals = 0
	socket.on("message", (data) => {
		const request = JSON.parse(data.toString())
		if (request.method === "authorize") approvals++
		socket.send(
			JSON.stringify({ id: request.id, result: request.method === "authorize" ? { approved: true } : snapshot }),
		)
	})
	await connector.acquire(previous)
	await connector.action(previous, "snapshot")
	connector.endTask(previous)
	await connector.acquire(current)
	expect(connector.hasSession()).toBe(true)
	await expect(connector.action(previous, "snapshot", {}, () => false)).rejects.toThrow("no longer current")
	await expect(connector.action(current, "click")).rejects.toThrow("fresh screenshot")
	await expect(connector.action(current, "snapshot")).resolves.toEqual(snapshot)
	connector.endTask(previous)
	await expect(connector.action(current, "click")).resolves.toEqual(snapshot)
	expect(approvals).toBe(1)
	await connector.release()
	expect(connector.hasSession()).toBe(false)
})

it("requires a fresh screenshot after manual control and preserves the socket on release", async () => {
	const socket = await connect()
	let sessionId = ""
	socket.on("message", (data) => {
		const request = JSON.parse(data.toString())
		if (request.method === "authorize") sessionId = request.params.sessionId
		socket.send(
			JSON.stringify({ id: request.id, result: request.method === "authorize" ? { approved: true } : snapshot }),
		)
	})
	await connector.acquire(chromeCaller)
	socket.send(JSON.stringify({ event: "paused", sessionId }))
	await vi.waitFor(() => expect(connector.getStatus()).toBe("paused"))
	await expect(connector.action(chromeCaller, "snapshot")).rejects.toThrow("not active")
	socket.send(JSON.stringify({ event: "resumed", sessionId }))
	await vi.waitFor(() => expect(connector.getStatus()).toBe("active"))
	await expect(connector.action(chromeCaller, "click")).rejects.toThrow("fresh screenshot")
	await connector.action(chromeCaller, "snapshot")
	await expect(connector.action(chromeCaller, "click")).resolves.toEqual(snapshot)
	await connector.release()
	expect(connector.getStatus()).toBe("connected")
	expect(socket.readyState).toBe(WebSocket.OPEN)
	await expect(connector.action(chromeCaller, "snapshot")).rejects.toThrow("not active")
})

it("does not terminate a replacement socket when an old release fails", async () => {
	const oldSocket = { terminate: vi.fn() }
	const replacement = { terminate: vi.fn() }
	const state = connector as unknown as {
		socket: unknown
		caller: object
		request: () => Promise<unknown>
	}
	state.socket = oldSocket
	state.caller = chromeCaller
	;(connector as any).sessionId = "active-session"
	let rejectRelease!: (error: Error) => void
	const request = vi.spyOn(state, "request").mockImplementation(
		() =>
			new Promise((_, reject) => {
				rejectRelease = reject
			}),
	)
	try {
		const releasing = connector.release()
		state.socket = replacement
		rejectRelease(new Error("Old connection closed"))
		await releasing
		expect(oldSocket.terminate).toHaveBeenCalledOnce()
		expect(replacement.terminate).not.toHaveBeenCalled()
	} finally {
		request.mockRestore()
		state.socket = undefined
	}
})

it("times out an additional-tab request without replaying it", async () => {
	vi.useFakeTimers()
	const state = connector as unknown as {
		socket: unknown
		caller: object
		sessionId: string
		status: string
	}
	const socket = { readyState: WebSocket.OPEN, send: vi.fn(), terminate: vi.fn() }
	state.socket = socket
	state.caller = chromeCaller
	state.sessionId = "test-session"
	state.status = "active"
	try {
		const pending = connector.action(chromeCaller, "create_tab", { url: "https://example.com" })
		const rejected = expect(pending).rejects.toThrow("will not be retried")
		await vi.advanceTimersByTimeAsync(29_999)
		expect(socket.send).toHaveBeenCalledOnce()
		expect(socket.terminate).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		await rejected
		expect(socket.terminate).toHaveBeenCalledOnce()
		expect(socket.send).toHaveBeenCalledOnce()
	} finally {
		state.socket = undefined
		vi.useRealTimers()
	}
})

it("rejects invalid screenshot results", async () => {
	const socket = await connect()
	socket.on("message", (data) => {
		const request = JSON.parse(data.toString())
		socket.send(
			JSON.stringify({
				id: request.id,
				result:
					request.method === "authorize"
						? { approved: true }
						: { ...snapshot, screenshot: "https://untrusted.example/image" },
			}),
		)
	})
	await connector.acquire(chromeCaller)
	await expect(connector.action(chromeCaller, "snapshot")).rejects.toThrow()
})
