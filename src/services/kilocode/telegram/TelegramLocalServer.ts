import * as net from "node:net"
import * as fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { JsonLineConnection } from "./JsonLineConnection"
import { telegramNonce, telegramProof, telegramProofSchema, verifyTelegramProof } from "./authentication"
import { connectTelegramMcpServer } from "./TelegramMcpServer"
import { TelegramCoordinator } from "./TelegramCoordinator"

/** Private socket plus mutual challenge authentication; the bot token is never sent over the socket. */
export class TelegramLocalServer {
	private readonly server: net.Server
	private readonly peers = new Set<JsonLineConnection>()
	private readonly authenticatedPeers = new Set<JsonLineConnection>()
	private stopping = false
	private ready = false

	constructor(
		private readonly token: string,
		private readonly ownerId: number,
		private readonly coordinator: TelegramCoordinator,
		private readonly onEmpty: () => void,
	) {
		this.server = net.createServer((socket) => this.accept(socket))
	}

	async listen(socketPath: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject)
			this.server.listen(socketPath, () => {
				this.server.off("error", reject)
				resolve()
			})
		})
		if (process.platform !== "win32") await fs.chmod(socketPath, 0o600)
		this.server.on("error", () => {
			console.error("Telegram local listener failed")
			void this.close()
		})
	}

	markReady(): void {
		this.ready = true
	}

	private accept(socket: net.Socket): void {
		if (!this.ready || this.stopping || this.peers.size >= 64) {
			socket.destroy()
			return
		}
		const peer = new JsonLineConnection(socket)
		this.peers.add(peer)
		const id = randomUUID()
		const serverNonce = telegramNonce()
		let authenticated = false
		let inFlight = 0
		const timeout = setTimeout(() => peer.close(), 5000)
		peer.on("closed", () => {
			clearTimeout(timeout)
			this.coordinator.disconnect(id)
			this.peers.delete(peer)
			this.authenticatedPeers.delete(peer)
			if (!this.peers.size && !this.stopping) this.onEmpty()
		})
		peer.on("frame", (value: unknown) => {
			if (!authenticated) {
				const proof = telegramProofSchema.safeParse(value)
				if (
					!proof.success ||
					proof.data.ownerId !== this.ownerId ||
					!verifyTelegramProof(
						proof.data.proof,
						telegramProof(this.token, "client", serverNonce, proof.data.nonce, this.ownerId),
					)
				) {
					peer.close()
					return
				}
				authenticated = true
				this.authenticatedPeers.add(peer)
				clearTimeout(timeout)
				this.coordinator.connect(
					id,
					(input) => peer.send({ type: "input", input }),
					(message) => peer.send({ type: "error", message }),
				)
				void connectTelegramMcpServer(peer, async (request) => {
					if (inFlight >= 32) {
						peer.close()
						throw new Error("Too many Telegram operations")
					}
					inFlight++
					try {
						switch (request.operation) {
							case "heartbeat":
								this.coordinator.heartbeat(id)
								return null
							case "deactivate":
								this.coordinator.deactivate(id)
								return null
							case "activate":
								return await this.coordinator.activate(
									id,
									request.projectId,
									request.taskId,
									request.title,
									request.notice,
									request.taskText,
								)
							case "beginTransfer":
								return this.coordinator.beginTransfer(id, request.taskId, request.epoch)
							case "finishTransfer":
								return this.coordinator.finishTransfer(id, request.taskId, request.epoch)
							case "publishImage":
								await this.coordinator.publishImage(id, request)
								return null
							case "publish":
								this.coordinator.publish(id, request)
								return null
							case "invalidateApproval":
								this.coordinator.invalidateApproval(id, request.epoch, request.approvalRevision)
								return null
						}
					} finally {
						inFlight--
					}
				}).then(
					() => {
						peer.send({
							type: "authenticated",
							proof: telegramProof(this.token, "server", serverNonce, proof.data.nonce, this.ownerId),
						})
					},
					() => peer.close(),
				)
				return
			}
			// Authenticated traffic is handled only by the MCP transport.
			if (!value || typeof value !== "object" || !("type" in value) || value.type !== "mcp") peer.close()
		})
		peer.send({ type: "challenge", version: 1, nonce: serverNonce })
	}

	broadcastError(message: string): void {
		for (const peer of this.authenticatedPeers) peer.send({ type: "error", message })
	}

	get connectionCount(): number {
		return this.peers.size
	}

	async close(): Promise<void> {
		if (this.stopping) return
		this.stopping = true
		for (const peer of this.peers) peer.close()
		if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()))
		await this.coordinator.stop()
	}
}
