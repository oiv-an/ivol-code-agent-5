import { EventEmitter } from "node:events"
import type { Socket } from "node:net"

const MAX_FRAME_BYTES = 24 * 1024 * 1024

/** Bounded framing for a local authenticated connection; never log raw frames. */
export class JsonLineConnection extends EventEmitter {
	private pending = Buffer.alloc(0)
	private closed = false

	constructor(readonly socket: Socket) {
		super()
		socket.on("data", (chunk: Buffer) => this.receive(chunk))
		socket.on("error", () => this.close())
		socket.on("close", () => {
			this.closed = true
			this.pending = Buffer.alloc(0)
			this.emit("closed")
		})
	}

	private receive(chunk: Buffer): void {
		if (this.closed) return
		this.pending = Buffer.concat([this.pending, chunk])
		let newline: number
		while ((newline = this.pending.indexOf(10)) !== -1) {
			if (newline > MAX_FRAME_BYTES) return this.close()
			const frame = this.pending.subarray(0, newline)
			this.pending = this.pending.subarray(newline + 1)
			let value: unknown
			try {
				value = JSON.parse(frame.toString("utf8"))
			} catch {
				this.close() // Invalid peer input terminates this connection, not the coordinator.
				return
			}
			this.emit("frame", value)
			if (this.closed) return
		}
		if (this.pending.length > MAX_FRAME_BYTES) this.close()
	}

	send(value: unknown): boolean {
		if (this.closed || this.socket.destroyed) return false
		const frame = JSON.stringify(value) + "\n"
		if (Buffer.byteLength(frame) > MAX_FRAME_BYTES || this.socket.writableLength > MAX_FRAME_BYTES * 2) {
			this.close()
			return false
		}
		this.socket.write(frame)
		return true
	}

	close(): void {
		if (this.closed) return
		this.closed = true
		this.pending = Buffer.alloc(0)
		this.socket.destroy()
	}
}
