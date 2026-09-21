// kilocode_change - new file
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { validateBrowserOSEndpoint } from "./BrowserOSAccess"
import { BrowserOSUnavailableError } from "./BrowserOSConnectFlow"

/** BrowserOS neo publishes its own MCP proxy port inside the browser profile. */
export const BROWSEROS_SERVER_NAME = "browseros-neo"

const PROFILE_DIRECTORY = "BrowserClaw"
const CONFIG_RELATIVE_PATH = path.join(".browseros", "config.json")

/** Candidate profile locations. The list is best effort: only existing readable files are used. */
function profileCandidates(): string[] {
	const home = os.homedir()
	if (!home) return []
	switch (process.platform) {
		case "darwin":
			return [path.join(home, "Library", "Application Support", PROFILE_DIRECTORY)]
		case "win32": {
			const roots = [process.env.LOCALAPPDATA, process.env.APPDATA].filter(
				(value): value is string => typeof value === "string" && value.length > 0,
			)
			return roots.flatMap((root) => [
				path.join(root, PROFILE_DIRECTORY),
				path.join(root, PROFILE_DIRECTORY, "User Data"),
			])
		}
		default:
			return [path.join(home, ".config", PROFILE_DIRECTORY), path.join(home, ".browseros")]
	}
}

function proxyPort(raw: string): number {
	const parsed = JSON.parse(raw)
	const port = parsed?.ports?.proxy
	// The profile is written by the browser, but never trust it blindly.
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("BrowserOS profile has no MCP proxy port")
	return port
}

/** Reads the endpoint the installed browser advertises. Does not contact the browser. */
export async function readBrowserOSEndpoint(): Promise<string> {
	const failures: string[] = []
	let onlyMissing = true
	for (const directory of profileCandidates()) {
		const configPath = path.join(directory, CONFIG_RELATIVE_PATH)
		try {
			const port = proxyPort(await readFile(configPath, "utf-8"))
			return validateBrowserOSEndpoint(`http://127.0.0.1:${port}/mcp`)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") onlyMissing = false
			// Missing profiles are expected; keep the reason for the final message.
			failures.push(`${configPath}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}
	console.error("BrowserOS profile lookup failed:", failures.join("; "))
	if (onlyMissing)
		throw new BrowserOSUnavailableError(
			"Could not find an installed BrowserOS neo browser. Start the browser and try again.",
		)
	throw new Error("Could not find an installed BrowserOS neo browser with a readable MCP proxy configuration")
}

function serverIdentity(body: string, streamed: boolean): string | undefined {
	// Only complete SSE events are considered; a JSON response can be pretty-printed.
	const payloads = streamed
		? body
				.split(/\r?\n\r?\n/)
				.slice(0, -1)
				.map((event) =>
					event
						.split(/\r?\n/)
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).replace(/^ /, ""))
						.join("\n"),
				)
		: [body]
	for (const payload of payloads) {
		if (!payload || payload === "[DONE]") continue
		try {
			const message = JSON.parse(payload)
			const name = message?.result?.serverInfo?.name
			if (message?.jsonrpc === "2.0" && message.id === 1 && typeof name === "string" && name.length > 0)
				return name
		} catch {
			// Incomplete JSON is expected while reading a chunked response.
			continue
		}
	}
	return undefined
}

/** Confirms the endpoint really belongs to BrowserOS neo before it is stored or connected. */
export async function probeBrowserOSEndpoint(endpoint: string, timeoutMs = 5000): Promise<void> {
	const url = validateBrowserOSEndpoint(endpoint)
	const response = await fetch(url, {
		method: "POST",
		redirect: "error",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "ivol-code", version: "1" },
			},
		}),
		signal: AbortSignal.timeout(timeoutMs),
	}).catch((error: unknown) => {
		const cause = (error as { cause?: { code?: string } })?.cause
		if (cause?.code === "ECONNREFUSED")
			throw new BrowserOSUnavailableError("BrowserOS is not accepting local connections")
		throw error
	})
	if (!response.ok) {
		await response.body?.cancel()
		throw new Error(`BrowserOS did not accept the connection (HTTP ${response.status})`)
	}
	if (!response.body) throw new Error("BrowserOS returned an empty response")
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let length = 0
	let name: string | undefined
	const streamed = response.headers.get("content-type")?.includes("text/event-stream") === true
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			length += value.byteLength
			if (length > 256 * 1024) throw new Error("BrowserOS initialization response is too large")
			chunks.push(value)
			name = serverIdentity(Buffer.concat(chunks).toString("utf-8"), streamed)
			if (name) break
		}
	} finally {
		await reader.cancel().catch((error) => console.error("Could not close BrowserOS probe response:", error))
		reader.releaseLock()
		// Only terminate the transport session created by this probe, never an agent session.
		const sessionId = response.headers.get("mcp-session-id")
		if (sessionId && sessionId.length <= 4096 && /^[\x21-\x7e]+$/.test(sessionId)) {
			try {
				const closed = await fetch(url, {
					method: "DELETE",
					redirect: "error",
					headers: { "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": "2025-06-18" },
					signal: AbortSignal.timeout(timeoutMs),
				})
				await closed.body?.cancel()
				if (!closed.ok && closed.status !== 404 && closed.status !== 405)
					console.error("BrowserOS probe session cleanup returned HTTP", closed.status)
			} catch {
				// Do not log session headers or make a successful identity check fail on cleanup.
				console.error("Could not terminate the temporary BrowserOS probe session")
			}
		}
	}
	if (!name) throw new Error("The local endpoint did not answer with an MCP server identity")
	if (name !== BROWSEROS_SERVER_NAME) throw new Error(`The local endpoint belongs to "${name}", not BrowserOS neo`)
}

/** Full automatic lookup: profile port plus identity check. */
export async function discoverBrowserOSEndpoint(): Promise<string> {
	const endpoint = await readBrowserOSEndpoint()
	await probeBrowserOSEndpoint(endpoint)
	return endpoint
}
