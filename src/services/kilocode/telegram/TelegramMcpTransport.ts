import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import { JsonLineConnection } from "./JsonLineConnection"

/** MCP over an already mutually authenticated local connection. Authentication must finish before connect(). */
export class TelegramMcpTransport implements Transport {
	onclose?: Transport["onclose"]
	onerror?: Transport["onerror"]
	onmessage?: Transport["onmessage"]
	private started = false

	constructor(private readonly peer: JsonLineConnection) {}

	private receive = (value: unknown): void => {
		if (!value || typeof value !== "object" || !("type" in value) || value.type !== "mcp") return
		const parsed = JSONRPCMessageSchema.safeParse("message" in value ? value.message : undefined)
		if (!parsed.success) {
			this.onerror?.(new Error("Invalid Telegram MCP frame"))
			this.peer.close()
			return
		}
		this.onmessage?.(parsed.data)
	}

	private disconnected = (): void => {
		this.peer.off("frame", this.receive)
		this.peer.off("closed", this.disconnected)
		this.started = false
		this.onclose?.()
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("Telegram MCP transport already started")
		this.started = true
		this.peer.on("frame", this.receive)
		this.peer.on("closed", this.disconnected)
	}

	async send(message: JSONRPCMessage): Promise<void> {
		if (!this.started || !this.peer.send({ type: "mcp", message })) {
			throw new Error("Telegram MCP transport disconnected")
		}
	}

	async close(): Promise<void> {
		this.peer.close()
	}
}
