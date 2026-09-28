import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { TelegramLocalServer } from "../TelegramLocalServer"
import { TelegramLocalClient } from "../TelegramLocalClient"
import type { TelegramCoordinator } from "../TelegramCoordinator"

function deferred() {
	let resolve!: () => void
	let reject!: (error: Error) => void
	const promise = new Promise<void>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}

const activation = { operation: "activate", projectId: "project", taskId: "task", title: "title", notice: "notice" }

describe("Telegram server real MCP concurrency", () => {
	let directory: string
	let server: TelegramLocalServer
	let client: TelegramLocalClient
	let mcp: Client
	let gate: ReturnType<typeof deferred>
	let coordinator: {
		activate: ReturnType<typeof vi.fn>
		connect: ReturnType<typeof vi.fn>
		disconnect: ReturnType<typeof vi.fn>
		heartbeat: ReturnType<typeof vi.fn>
		stop: ReturnType<typeof vi.fn>
	}

	beforeEach(async () => {
		directory = await mkdtemp(path.join(tmpdir(), "tg-limit-"))
		const socketPath =
			process.platform === "win32" ? `\\\\.\\pipe\\tg-limit-${randomUUID()}` : path.join(directory, "s")
		gate = deferred()
		coordinator = {
			activate: vi.fn(async () => {
				await gate.promise
				return { epoch: "epoch" }
			}),
			connect: vi.fn(),
			disconnect: vi.fn(),
			heartbeat: vi.fn(),
			stop: vi.fn(async () => {}),
		}
		server = new TelegramLocalServer("123:fixture", 123, coordinator as unknown as TelegramCoordinator, vi.fn())
		await server.listen(socketPath)
		server.markReady()
		client = await TelegramLocalClient.connect(socketPath, "123:fixture", 123)
		// Use the authenticated SDK directly: the production client's 24-call cap
		// must not hide a broken server-side 32-call cap.
		mcp = (client as unknown as { mcp: Client }).mcp
	})

	afterEach(async () => {
		gate.resolve()
		client?.close()
		await server?.close()
		await rm(directory, { recursive: true, force: true })
	})

	const call = (sdk: Client) => sdk.callTool({ name: "telegram_control", arguments: activation })

	it("admits only 32 unresolved activations from a burst of 40, then disconnects", async () => {
		let disconnected = false
		const closed = new Promise<void>((resolve) =>
			client.once("disconnected", () => {
				disconnected = true
				resolve()
			}),
		)
		const requests = Array.from({ length: 40 }, () => call(mcp).catch(() => undefined))
		// A heartbeat behind the burst is a processing barrier on the same socket.
		await Promise.race([
			closed,
			mcp.callTool({ name: "telegram_control", arguments: { operation: "heartbeat" } }).catch(() => undefined),
		])
		expect(coordinator.activate).toHaveBeenCalledTimes(32)
		expect(disconnected).toBe(true)
		gate.resolve()
		await Promise.all(requests)
	})

	it.each([false, true])("releases slots after activation settles (rejected=%s)", async (reject) => {
		const requests = Array.from({ length: 32 }, () => call(mcp))
		await vi.waitFor(() => expect(coordinator.activate).toHaveBeenCalledTimes(32))
		if (reject) gate.reject(new Error("fixture activation failure"))
		else gate.resolve()
		const results = await Promise.all(requests)
		expect(results.every((result) => Boolean(result.isError) === reject)).toBe(true)
		coordinator.activate.mockResolvedValue({ epoch: "next" })
		const next = await call(mcp)
		expect(next.isError).not.toBe(true)
		expect(coordinator.activate).toHaveBeenCalledTimes(33)
		expect(server.connectionCount).toBe(1)
	})
})
