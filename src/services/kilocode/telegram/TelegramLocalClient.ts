import * as net from "node:net"
import { EventEmitter } from "node:events"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { TelegramMcpTransport } from "./TelegramMcpTransport"
import { z } from "zod"
import { JsonLineConnection } from "./JsonLineConnection"
import { telegramChallengeSchema, telegramNonce, telegramProof, verifyTelegramProof } from "./authentication"
import { telegramInputSchema as inputSchema, type TelegramCoordinatorRequest } from "./protocol"
const envelopeSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("authenticated"), proof: z.string() }),
	z.object({ type: z.literal("input"), input: inputSchema }),
	z.object({ type: z.literal("error"), message: z.string().max(1000) }),
])

export class TelegramLocalClient extends EventEmitter {
	private readonly mcp = new Client({ name: "ivol-telegram-plugin", version: "1.0.0" })
	private pending = 0
	private heartbeat?: NodeJS.Timeout
	private ready = false

	private constructor(private readonly peer: JsonLineConnection) {
		super()
		peer.on("closed", () => {
			this.ready = false
			if (this.heartbeat) clearInterval(this.heartbeat)
			this.emit("disconnected")
		})
	}

	static async connect(socketPath: string, token: string, ownerId: number): Promise<TelegramLocalClient> {
		const socket = net.createConnection(socketPath)
		const client = new TelegramLocalClient(new JsonLineConnection(socket))
		try {
			await client.authenticate(token, ownerId)
			await client.mcp.connect(new TelegramMcpTransport(client.peer))
			client.ready = true
		} catch {
			client.close()
			throw new Error("Telegram coordinator connection failed")
		}
		client.heartbeat = setInterval(() => {
			void client.request({ operation: "heartbeat" }).catch(() => client.close())
		}, 5000)
		client.heartbeat.unref()
		return client
	}

	private authenticate(token: string, ownerId: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const clientNonce = telegramNonce()
			let serverNonce: string | undefined
			const fail = () => {
				clearTimeout(timer)
				this.peer.off("frame", onFrame)
				this.peer.off("closed", fail)
				this.close()
				reject(new Error("Telegram coordinator authentication failed"))
			}
			const timer = setTimeout(fail, 5000)
			const onFrame = (value: unknown) => {
				if (!serverNonce) {
					const challenge = telegramChallengeSchema.safeParse(value)
					if (!challenge.success) return fail()
					serverNonce = challenge.data.nonce
					this.peer.send({
						type: "authenticate",
						version: 1,
						nonce: clientNonce,
						ownerId,
						proof: telegramProof(token, "client", serverNonce, clientNonce, ownerId),
					})
					return
				}
				const result = envelopeSchema.safeParse(value)
				if (
					!result.success ||
					result.data.type !== "authenticated" ||
					!verifyTelegramProof(
						result.data.proof,
						telegramProof(token, "server", serverNonce, clientNonce, ownerId),
					)
				)
					return fail()
				clearTimeout(timer)
				this.peer.off("frame", onFrame)
				this.peer.off("closed", fail)
				this.peer.on("frame", (frame: unknown) => this.receive(frame))
				resolve()
			}
			this.peer.on("frame", onFrame)
			this.peer.once("closed", fail)
		})
	}

	private receive(value: unknown): void {
		if (value && typeof value === "object" && "type" in value && value.type === "mcp") return
		const envelope = envelopeSchema.safeParse(value)
		if (!envelope.success) return this.close()
		const frame = envelope.data
		if (frame.type === "input") this.emit("input", frame.input)
		if (frame.type === "error") this.emit("fault", frame.message)
	}

	async request(request: TelegramCoordinatorRequest): Promise<unknown> {
		if (!this.ready || this.pending >= 24) throw new Error("Telegram coordinator unavailable")
		this.pending++
		try {
			const result = await this.mcp.callTool({ name: "telegram_control", arguments: request }, undefined, {
				timeout: 60_000,
			})
			const content = result.content as Array<{ type: string; text?: string }>
			if (result.isError || content?.[0]?.type !== "text" || !content[0].text) {
				throw new Error("Telegram operation failed")
			}
			return JSON.parse(content[0].text)
		} catch {
			// Failed/timed-out activations must not accept input invisibly.
			this.close()
			throw new Error("Telegram operation failed")
		} finally {
			this.pending--
		}
	}

	close(): void {
		this.ready = false
		if (this.heartbeat) clearInterval(this.heartbeat)
		this.peer.close()
	}
}
