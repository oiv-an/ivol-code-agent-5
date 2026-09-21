import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { createServer, type Server } from "node:http"
import WebSocket, { WebSocketServer } from "ws"
import { z } from "zod"

const replySchema = z.object({
	id: z.string().uuid(),
	result: z.unknown().optional(),
	error: z.string().max(2000).optional(),
})

export const chromeSnapshotSchema = z.object({
	screenshot: z
		.string()
		.max(16 * 1024 * 1024)
		.regex(/^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/),
	currentUrl: z.string().max(32768),
	viewportWidth: z.number().positive().max(32768),
	viewportHeight: z.number().positive().max(32768),
	logs: z.string().max(65536).optional(),
	pageContent: z.string().max(32000).optional(),
	tabs: z
		.array(z.object({ id: z.string().max(20), url: z.string().max(32768), active: z.boolean() }))
		.max(20)
		.optional(),
})

export type ChromeSnapshot = z.infer<typeof chromeSnapshotSchema>
export type ChromeCommand =
	| "snapshot"
	| "click"
	| "hover"
	| "type"
	| "press"
	| "scroll"
	| "navigate"
	| "select_tab"
	| "create_tab"
export type ChromeConnectorStatus = "disconnected" | "connected" | "awaitingPermission" | "active" | "paused"

/** One connector per extension host. Pairing is transient and never stored in task history. */
export class ChromeConnector {
	private server?: Server
	private sockets?: WebSocketServer
	private socket?: WebSocket
	private secret?: string
	private pairingExpires = 0
	private caller?: object
	private sessionId?: string
	private status: ChromeConnectorStatus = "disconnected"
	private pending = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>()
	private queue: Promise<unknown> = Promise.resolve()
	private generation = 0
	private needsFreshSnapshot = false
	private controlEpoch = 0
	private pairingInProgress = false
	private resumePending = false

	private autoStart?: Promise<void>
	private discovering = false
	private waitingOwner?: object
	private automaticConnection = false
	// Kept separate so transport tests can use ephemeral ports, never a personal browser's discovery range.
	private discoveryPorts = Array.from({ length: 10 }, (_, i) => 19440 + i)

	/** Discoverable only while a chat request is waiting; never restores task permission. */
	async connectAutomatically(isCurrent: () => boolean = () => true): Promise<void> {
		if (this.socket?.readyState === WebSocket.OPEN) return
		if (this.autoStart) return this.autoStart
		this.autoStart = (async () => {
			await this.createPairing(true)
			const generation = this.generation
			this.discovering = true
			try {
				const deadline = Date.now() + 45_000
				while (this.socket?.readyState !== WebSocket.OPEN) {
					if (generation !== this.generation || !isCurrent()) throw new Error("Browser connection cancelled")
					if (Date.now() >= deadline)
						throw new Error(
							"Open Chrome with IVOL Browser Connector enabled, then try again. No pairing code is needed.",
						)
					await new Promise((resolve) => setTimeout(resolve, 100))
				}
				if (generation !== this.generation || !isCurrent()) throw new Error("Browser connection cancelled")
			} catch (error) {
				// A cancelled or timed out request must not leave a discoverable listener behind.
				if (generation === this.generation) await this.stop()
				throw error
			} finally {
				this.discovering = false
			}
		})().finally(() => {
			this.autoStart = undefined
		})
		return this.autoStart
	}

	getStatus(): ChromeConnectorStatus {
		return this.status
	}

	hasSession(): boolean {
		return this.status === "active" || this.status === "paused"
	}

	/** A chat ending invalidates its queued work, not the host's browser permission. */
	endTask(caller: object): void {
		if (this.waitingOwner === caller) this.waitingOwner = undefined
		if (this.caller !== caller) return
		this.caller = undefined
		++this.controlEpoch
		this.needsFreshSnapshot = true
	}

	/** Returns a short-lived pairing payload for the trusted settings UI only. */
	async startPairing(): Promise<string> {
		if (this.pairingInProgress) throw new Error("Chrome pairing is already starting")
		this.pairingInProgress = true
		try {
			return await this.createPairing()
		} finally {
			this.pairingInProgress = false
		}
	}

	private async createPairing(automatic = false): Promise<string> {
		const stopping = this.stop()
		const generation = this.generation
		await stopping
		if (generation !== this.generation) throw new Error("Chrome pairing was cancelled")
		this.automaticConnection = automatic
		this.secret = randomBytes(32).toString("hex")
		this.pairingExpires = Date.now() + 5 * 60_000
		const server = createServer((request, response) => {
			const origin = request.headers.origin ?? ""
			const address = server.address()
			if (
				automatic &&
				this.discovering &&
				!this.socket &&
				this.secret &&
				generation === this.generation &&
				Date.now() <= this.pairingExpires &&
				request.method === "POST" &&
				request.url === "/ivol-browser/discover" &&
				/^chrome-extension:\/\/[a-p]{32}$/.test(origin) &&
				request.headers["x-ivol-connector"] === "1" &&
				address &&
				typeof address !== "string" &&
				request.headers.host === `127.0.0.1:${address.port}`
			) {
				response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
				response.end(JSON.stringify({ version: 2, port: address.port, token: this.secret }))
				return
			}
			response.writeHead(404)
			response.end()
		})
		const sockets = new WebSocketServer({ noServer: true, maxPayload: 18 * 1024 * 1024, perMessageDeflate: false })
		this.server = server
		this.sockets = sockets
		server.on("upgrade", (request, socket, head) => {
			const origin = request.headers.origin ?? ""
			const protocols = request.headers["sec-websocket-protocol"]?.split(",").map((value) => value.trim()) ?? []
			const supplied = protocols.find((value) => value.startsWith("ivol-auth-"))?.slice(10) ?? ""
			const expected = this.secret ?? ""
			const validSecret =
				/^[a-f0-9]{64}$/.test(supplied) &&
				supplied.length === expected.length &&
				timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
			if (
				generation !== this.generation ||
				(automatic && !this.discovering) ||
				request.url !== "/ivol-browser" ||
				!/^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
				!validSecret ||
				Date.now() > this.pairingExpires ||
				this.socket
			) {
				socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
				return
			}
			sockets.handleUpgrade(request, socket, head, (connection) => {
				this.socket = connection
				this.secret = undefined
				this.status = "connected"
				connection.on("message", (data) => {
					if (this.socket === connection && generation === this.generation) this.receive(data.toString())
				})
				connection.on("close", () => {
					if (this.socket !== connection) return
					this.socket = undefined
					this.invalidate("Chrome disconnected. Ask again to reconnect.")
					this.status = "disconnected"
				})
				connection.on("error", () => connection.terminate())
			})
		})
		const ports = automatic ? this.discoveryPorts : [0]
		for (const port of ports) {
			try {
				await new Promise<void>((resolve, reject) => {
					const failed = (error: Error) => {
						server.off("listening", ready)
						reject(error)
					}
					const ready = () => {
						server.off("error", failed)
						resolve()
					}
					server.once("error", failed)
					server.once("listening", ready)
					server.listen(port, "127.0.0.1")
				})
				break
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || port === ports.at(-1)) {
					await this.discard(server, sockets)
					throw error
				}
			}
		}
		if (generation !== this.generation) {
			await this.discard(server, sockets)
			throw new Error("Chrome pairing was cancelled")
		}
		server.on("error", () => {
			this.socket?.terminate()
			this.invalidate("Chrome connector failed. Ask again to reconnect.")
		})
		const address = server.address()
		if (!address || typeof address === "string") {
			await this.discard(server, sockets)
			throw new Error("Cannot start Chrome connector")
		}
		return JSON.stringify({ version: 2, port: address.port, token: this.secret })
	}

	/** Releases a listener that never became the active connector. */
	private async discard(server: Server, sockets: WebSocketServer): Promise<void> {
		if (this.server === server) this.server = undefined
		if (this.sockets === sockets) this.sockets = undefined
		this.secret = undefined
		this.discovering = false
		sockets.close()
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}

	private receive(raw: string): void {
		let value: unknown
		try {
			value = JSON.parse(raw)
		} catch {
			this.socket?.close(1008, "Invalid message")
			return
		}
		const event = z
			.object({ event: z.enum(["paused", "resumed", "revoked"]), sessionId: z.string().uuid() })
			.safeParse(value)
		if (event.success) {
			if (event.data.sessionId !== this.sessionId) return
			if (event.data.event === "revoked") {
				this.invalidate("Browser access was revoked. Request permission again.")
			} else {
				this.status = event.data.event === "paused" ? "paused" : "active"
				this.needsFreshSnapshot = true
				++this.controlEpoch
			}
			return
		}
		const reply = replySchema.safeParse(value)
		if (!reply.success) {
			this.socket?.close(1008, "Invalid reply")
			return
		}
		const pending = this.pending.get(reply.data.id)
		if (!pending) return
		clearTimeout(pending.timer)
		this.pending.delete(reply.data.id)
		if (reply.data.error) pending.reject(new Error(reply.data.error))
		else pending.resolve(reply.data.result)
	}

	private request(method: string, params: Record<string, unknown>, timeout = 30_000): Promise<unknown> {
		const socket = this.socket
		if (!socket || socket.readyState !== WebSocket.OPEN)
			return Promise.reject(new Error("Chrome is not connected. Ask again to reconnect automatically."))
		const id = randomUUID()
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(
					new Error(
						"Chrome request timed out. The action may have executed; it will not be retried. Reconnect before continuing.",
					),
				)
				socket.terminate()
			}, timeout)
			this.pending.set(id, { resolve, reject, timer })
			socket.send(JSON.stringify({ version: 2, id, method, params }), (error) => {
				if (!error) return
				clearTimeout(timer)
				this.pending.delete(id)
				reject(new Error("Chrome connection failed; the action was not retried."))
				socket.terminate()
			})
		})
	}

	async acquire(
		caller: object,
		url?: string,
		topic = "Browser",
		confirm: () => Promise<boolean> = async () => true,
		isCurrent: () => boolean = () => true,
	): Promise<void> {
		if (!/^[A-Za-z]{1,24}$/.test(topic)) throw new Error("Use one short English word for the browser group")
		if (this.status === "active") return
		if (this.status === "paused") throw new Error("Browser control is paused. Ask to resume it in chat.")
		if (this.status === "awaitingPermission") throw new Error("A browser request is still starting.")
		if (!this.socket) {
			if (this.waitingOwner) throw new Error("Chrome is already connecting")
			const waiting = caller
			this.waitingOwner = waiting
			try {
				await this.connectAutomatically(() => this.waitingOwner === waiting && isCurrent())
				if (this.waitingOwner !== waiting) throw new Error("Browser connection cancelled")
			} finally {
				if (this.waitingOwner === waiting) this.waitingOwner = undefined
			}
		}
		if (!isCurrent()) throw new Error("Browser caller changed before permission")
		this.caller = caller
		const sessionId = randomUUID()
		this.sessionId = sessionId
		this.status = "awaitingPermission"
		try {
			const approved = await confirm()
			if (!isCurrent() || this.sessionId !== sessionId || this.status !== "awaitingPermission")
				throw new Error("Chrome permission request expired")
			if (!approved) throw new Error("Chrome browser control declined")
			// Only the IDE asks for consent; the connector never opens a second permission popup.
			const result = z
				.object({ approved: z.literal(true) })
				.parse(await this.request("authorize", { sessionId, topic, url }, 30_000))
			if (!result.approved || !isCurrent() || this.caller !== caller || this.sessionId !== sessionId)
				throw new Error("Chrome authorization expired")
			this.status = "active"
		} catch (error) {
			if (this.sessionId === sessionId) this.invalidate("Chrome authorization failed")
			// A rejected request must free an automatic connection for the next editor.
			if (this.automaticConnection && !this.sessionId) await this.stop()
			throw error
		}
	}

	async action(
		caller: object,
		method: ChromeCommand,
		params: Record<string, unknown> = {},
		isCurrent: () => boolean = () => true,
	): Promise<ChromeSnapshot> {
		if (!isCurrent()) throw new Error("Browser caller is no longer current")
		if (this.caller !== caller) {
			this.caller = caller
			++this.controlEpoch
			this.needsFreshSnapshot = true
		}
		const sessionId = this.sessionId
		const epoch = this.controlEpoch
		const run = async () => {
			if (epoch !== this.controlEpoch) throw new Error("Control changed; queued action cancelled")
			if (
				!sessionId ||
				this.caller !== caller ||
				!isCurrent() ||
				this.sessionId !== sessionId ||
				this.status !== "active"
			) {
				throw new Error("Browser control is not active. Ask to use the browser again.")
			}
			if (this.needsFreshSnapshot && method !== "snapshot") {
				throw new Error("Manual control changed the page. Request a fresh screenshot before another action.")
			}
			const result = chromeSnapshotSchema.parse(await this.request(method, { ...params, sessionId }, 30_000))
			if (!isCurrent() || this.sessionId !== sessionId || this.status !== "active" || epoch !== this.controlEpoch)
				throw new Error("Chrome access changed; result discarded")
			if (method === "snapshot") this.needsFreshSnapshot = false
			return result
		}
		const next = this.queue.then(run, run)
		this.queue = next.catch(() => undefined)
		return next
	}

	async pause(): Promise<void> {
		if (!this.sessionId || !["active", "paused"].includes(this.status)) throw new Error("No active Chrome session")
		const sessionId = this.sessionId
		this.status = "paused"
		this.needsFreshSnapshot = true
		++this.controlEpoch
		try {
			await this.request("pause", { sessionId })
		} catch (error) {
			if (this.sessionId === sessionId) await this.stop()
			throw error
		}
	}

	async resume(confirm: () => Promise<boolean>, isCurrent: () => boolean): Promise<void> {
		if (this.resumePending) throw new Error("Chrome resume permission is already pending")
		if (!this.sessionId || this.status !== "paused") throw new Error("Chrome is not paused")
		const sessionId = this.sessionId
		const epoch = this.controlEpoch
		this.resumePending = true
		try {
			if (!(await confirm())) return
			if (!isCurrent() || this.sessionId !== sessionId || this.controlEpoch !== epoch || this.status !== "paused")
				throw new Error("Chrome resume permission expired")
			try {
				await this.request("resume", { sessionId })
				if (!isCurrent() || this.sessionId !== sessionId || this.controlEpoch !== epoch)
					throw new Error("Chrome resume permission expired")
				++this.controlEpoch
				this.needsFreshSnapshot = true
				this.status = "active"
			} catch (error) {
				if (this.sessionId === sessionId) await this.stop()
				throw error
			}
		} finally {
			this.resumePending = false
		}
	}

	async release(): Promise<void> {
		if (this.waitingOwner) {
			this.waitingOwner = undefined
			await this.stop()
			return
		}
		if (!this.sessionId) return
		const sessionId = this.sessionId
		const socket = this.socket
		this.invalidate("Browser session ended")
		try {
			await this.request("release", { sessionId }, 3000)
		} catch {
			// A failed old release must never terminate a replacement connection.
			socket?.terminate()
		}
		if (this.automaticConnection && this.socket === socket && !this.sessionId) await this.stop()
	}

	private invalidate(reason: string): void {
		++this.controlEpoch
		this.needsFreshSnapshot = false
		this.caller = undefined
		this.sessionId = undefined
		this.status = this.socket ? "connected" : "disconnected"
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer)
			entry.reject(new Error(reason))
		}
		this.pending.clear()
	}

	async stop(): Promise<void> {
		++this.generation
		this.discovering = false
		this.secret = undefined
		this.socket?.terminate()
		this.socket = undefined
		this.invalidate("Chrome connector stopped")
		this.sockets?.close()
		this.sockets = undefined
		const server = this.server
		this.server = undefined
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
	}
}

export const chromeConnector = new ChromeConnector()
