// kilocode_change - new file
import http from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
	probeBrowserOSEndpoint,
	readBrowserOSEndpoint,
	discoverBrowserOSEndpoint,
} from "../kilocode/BrowserOSDiscovery"
import { allowNetConnect } from "../../../vitest.setup"

// Only the loopback test servers started below are reachable.
allowNetConnect("127.0.0.1")

/** Serves one canned MCP initialize response so the identity check can be exercised locally. */
async function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer(handler)
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => resolve())
	})
	const { port } = server.address() as AddressInfo
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	}
}

function identity(name: string): string {
	return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name, version: "0.0.54" } } })
}

describe("BrowserOS endpoint discovery", () => {
	let home: string
	let profile: string

	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!

	beforeEach(async () => {
		home = await mkdtemp(path.join(os.tmpdir(), "ivol-browseros-"))
		profile = path.join(home, "Library", "Application Support", "BrowserClaw", ".browseros")
		vi.spyOn(os, "homedir").mockReturnValue(home)
		// The profile layout differs per platform; these tests cover the macOS location.
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
	})

	afterEach(() => {
		Object.defineProperty(process, "platform", originalPlatform)
		vi.restoreAllMocks()
	})

	it("reads the proxy port the installed browser publishes", async () => {
		await mkdir(profile, { recursive: true })
		await writeFile(path.join(profile, "config.json"), JSON.stringify({ ports: { proxy: 9010, cdp: 9110 } }))
		await expect(readBrowserOSEndpoint()).resolves.toBe("http://127.0.0.1:9010/mcp")
	})

	it("reports a missing browser instead of guessing a port", async () => {
		await expect(readBrowserOSEndpoint()).rejects.toThrow("Could not find an installed BrowserOS neo browser")
	})

	it.each([{ ports: {} }, { ports: { proxy: 0 } }, { ports: { proxy: "9010" } }])(
		"rejects an unusable profile port %j",
		async (config) => {
			await mkdir(profile, { recursive: true })
			await writeFile(path.join(profile, "config.json"), JSON.stringify(config))
			await expect(readBrowserOSEndpoint()).rejects.toThrow("Could not find an installed BrowserOS neo browser")
		},
	)

	it("accepts the browser identity from a streamed response", async () => {
		const server = await startServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "text/event-stream" })
			response.end(`data:\nid: 0\n\ndata: ${identity("browseros-neo")}\n\n`)
		})
		try {
			await expect(probeBrowserOSEndpoint(server.url)).resolves.toBeUndefined()
		} finally {
			await server.close()
		}
	})

	it("accepts an initialize response without waiting for the SSE stream to close", async () => {
		const server = await startServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "text/event-stream" })
			response.write(`data: ${identity("browseros-neo")}\n\n`)
		})
		try {
			await expect(probeBrowserOSEndpoint(server.url, 1000)).resolves.toBeUndefined()
		} finally {
			await server.close()
		}
	})

	it("terminates only the transport session created by its initialize request", async () => {
		const requests: Array<{ method?: string; session?: string | string[] }> = []
		const server = await startServer((request, response) => {
			requests.push({ method: request.method, session: request.headers["mcp-session-id"] })
			if (request.method === "DELETE") {
				response.writeHead(204)
				response.end()
				return
			}
			response.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "probe-session" })
			response.end(identity("browseros-neo"))
		})
		try {
			await expect(probeBrowserOSEndpoint(server.url)).resolves.toBeUndefined()
			expect(requests).toEqual([
				{ method: "POST", session: undefined },
				{ method: "DELETE", session: "probe-session" },
			])
		} finally {
			await server.close()
		}
	})

	it("accepts pretty-printed JSON", async () => {
		const server = await startServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/json" })
			response.end(JSON.stringify(JSON.parse(identity("browseros-neo")), null, 2))
		})
		try {
			await expect(probeBrowserOSEndpoint(server.url)).resolves.toBeUndefined()
		} finally {
			await server.close()
		}
	})

	it("refuses a local endpoint owned by another MCP server", async () => {
		const server = await startServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/json" })
			response.end(identity("some-other-server"))
		})
		try {
			await expect(probeBrowserOSEndpoint(server.url)).rejects.toThrow('belongs to "some-other-server"')
		} finally {
			await server.close()
		}
	})

	it("refuses an endpoint that is not an MCP server", async () => {
		const server = await startServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "text/plain" })
			response.end("hello")
		})
		try {
			await expect(probeBrowserOSEndpoint(server.url)).rejects.toThrow("did not answer with an MCP server")
		} finally {
			await server.close()
		}
	})

	it("does not follow redirects even to another local endpoint", async () => {
		let targetCalls = 0
		const target = await startServer((_request, response) => {
			targetCalls++
			response.end(identity("browseros-neo"))
		})
		const source = await startServer((_request, response) => {
			response.writeHead(307, { Location: target.url })
			response.end()
		})
		try {
			await expect(probeBrowserOSEndpoint(source.url)).rejects.toThrow()
			expect(targetCalls).toBe(0)
		} finally {
			await source.close()
			await target.close()
		}
	})

	it("rejects oversized initialization responses", async () => {
		const server = await startServer((_request, response) => {
			response.end(" ".repeat(256 * 1024 + 1))
		})
		try {
			await expect(probeBrowserOSEndpoint(server.url)).rejects.toThrow("too large")
		} finally {
			await server.close()
		}
	})

	it("reports a refused connection", async () => {
		const server = await startServer((_request, response) => {
			response.writeHead(403)
			response.end()
		})
		try {
			await expect(probeBrowserOSEndpoint(server.url)).rejects.toThrow("HTTP 403")
		} finally {
			await server.close()
		}
	})

	it.each(["https://127.0.0.1:9010/mcp", "http://example.com/mcp", "http://user:pass@127.0.0.1:9010/mcp"])(
		"never probes the non-local endpoint %s",
		async (endpoint) => {
			await expect(probeBrowserOSEndpoint(endpoint)).rejects.toThrow("BrowserOS requires a local HTTP endpoint")
		},
	)

	it("combines the profile port with the identity check", async () => {
		const server = await startServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/json" })
			response.end(identity("browseros-neo"))
		})
		try {
			const port = new URL(server.url).port
			await mkdir(profile, { recursive: true })
			await writeFile(path.join(profile, "config.json"), JSON.stringify({ ports: { proxy: Number(port) } }))
			await expect(discoverBrowserOSEndpoint()).resolves.toBe(server.url)
		} finally {
			await server.close()
		}
	})
})
