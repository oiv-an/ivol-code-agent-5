// kilocode_change - new file: a rejected new tab must explain the rule, not leak a parser error.
import { BrowserOSAccess, browserOSOperation } from "../kilocode/BrowserOSAccess"

const RULE = "BrowserOS new tabs require HTTP(S) or about:blank without credentials"

describe("browserOSOperation: tabs new", () => {
	it.each([undefined, null, "", "   ", "about:blank"])("opens a blank tab for %p", (url) => {
		expect(browserOSOperation("tabs", { action: "new", url })).toEqual({ kind: "create" })
	})

	it.each(["https://example.com", "http://example.com/path?q=1"])("accepts the web address %s", (url) => {
		expect(browserOSOperation("tabs", { action: "new", url })).toEqual({ kind: "create" })
	})

	it.each([
		["a malformed address", "not a url"],
		["a bare host without a scheme", "example.com"],
		["a file path", "file:///etc/passwd"],
		["a script url", "javascript:alert(1)"],
		["a data url", "data:text/html,<h1>x</h1>"],
		["an embedded credential", "https://user:secret@example.com"],
	])("reports the rule for %s", (_label, url) => {
		// A raw TypeError from the URL parser used to reach the user instead of this rule.
		expect(() => browserOSOperation("tabs", { action: "new", url })).toThrow(RULE)
	})

	it.each([42, {}, []])("reports the rule for the non-string value %p", (url) => {
		expect(() => browserOSOperation("tabs", { action: "new", url })).toThrow(RULE)
	})

	it("never reports a bare parser failure", () => {
		try {
			browserOSOperation("tabs", { action: "new", url: "not a url" })
			throw new Error("Expected a rejection")
		} catch (error) {
			expect(error).toBeInstanceOf(Error)
			expect((error as Error).message).toBe(RULE)
			expect((error as Error).message).not.toMatch(/invalid url/i)
		}
	})
})

describe("BrowserOS page-scoped observations", () => {
	const ok = { content: [{ type: "text", text: "Page" }] }
	async function setup() {
		const access = new BrowserOSAccess()
		const owner = {}
		const connection = {}
		await access.acquire(owner, connection, async () => true)
		const request = vi.fn(async () => ok)
		const call = (name: string, page = 1, args: Record<string, unknown> = {}) =>
			access.execute(owner, connection, browserOSOperation(name, { page, ...args }), request)
		return { access, call, request }
	}

	it.each(["read", "grep", "diff", "wait", "pdf"])(
		"allows %s without granting or consuming observations",
		async (name) => {
			const { call } = await setup()
			await call(name)
			await expect(call("act")).rejects.toThrow("fresh")
			await call("snapshot")
			await call(name)
			await call(name)
			await expect(call("act")).resolves.toEqual(ok)
			await call(name)
			await expect(call("act")).rejects.toThrow("fresh")
		},
	)

	it("allows navigation without a snapshot but invalidates only its target", async () => {
		const { call } = await setup()
		await call("navigate")
		await expect(call("act")).rejects.toThrow("fresh")
		await call("snapshot", 1)
		await call("snapshot", 2)
		await call("navigate", 1)
		await expect(call("act", 1)).rejects.toThrow("fresh")
		await expect(call("act", 2)).resolves.toEqual(ok)
	})

	it.each(["act", "upload", "download", "tabs"])(
		"requires observation for %s and preserves other pages",
		async (name) => {
			const { call } = await setup()
			const args = name === "tabs" ? { action: "close" } : {}
			await expect(call(name, 1, args)).rejects.toThrow("fresh")
			await call("snapshot", 1)
			await call("snapshot", 2)
			await call(name, 1, args)
			await expect(call("act", 1)).rejects.toThrow("fresh")
			await expect(call("act", 2)).resolves.toEqual(ok)
		},
	)

	it("opening a background tab preserves existing observations without granting new ones", async () => {
		const { call } = await setup()
		await call("snapshot", 1)
		await call("tabs", 2, { action: "new", url: "https://example.com" })
		await expect(call("act", 2)).rejects.toThrow("fresh")
		await expect(call("act", 1)).resolves.toEqual(ok)
	})

	it.each(["read", "grep", "diff", "wait", "pdf", "navigate"])("still validates the numeric page for %s", (name) => {
		expect(() => browserOSOperation(name, { page: "1" })).toThrow("target page ID")
	})

	it.each(["read", "navigate"])("does not allow %s to bypass pause or revocation", async (name) => {
		const { access, call, request } = await setup()
		access.pause()
		await expect(call(name)).rejects.toThrow("paused")
		access.resume()
		await call(name)
		access.revoke()
		await expect(call(name)).rejects.toThrow("not been granted")
		expect(request).toHaveBeenCalledTimes(1)
	})
})

describe("BrowserOS scripts (run/evaluate)", () => {
	it.each(["run", "evaluate"])("classifies %s as a script, not as unsupported", (name) => {
		expect(browserOSOperation(name, { code: "return 1" })).toEqual({ kind: "script" })
	})

	it("still rejects unknown tools", () => {
		expect(browserOSOperation("history", {})).toEqual({ kind: "unsupported" })
	})

	it("executes a script and then requires a fresh observation before interacting", async () => {
		const access = new BrowserOSAccess()
		const owner = {}
		const connection = {}
		await access.acquire(owner, connection, async () => true)
		const ok = { content: [{ type: "text", text: "tree" }] }
		await access.execute(owner, connection, { kind: "observation", page: 1 }, async () => ok)
		await expect(access.execute(owner, connection, { kind: "script" }, async () => ok)).resolves.toEqual(ok)
		await expect(
			access.execute(owner, connection, { kind: "interaction", page: 1 }, async () => ok),
		).rejects.toThrow("fresh BrowserOS observation")
	})
})

// kilocode_change start: preserve consent only for verified action failures.
describe("BrowserOS recoverable failures", () => {
	it.each([
		"error: Element e55 is covered by <div.bubble> at its click point; dismiss it first.",
		"evaluate: ReferenceError: browser is not defined",
		"error: evaluate: TypeError: Cannot read properties of null (reading 'querySelectorAll')",
		"error: page.setViewportSize is not part of this SDK.",
	])("preserves consent and the private handle for %s", async (text) => {
		const access = new BrowserOSAccess()
		const owner = {},
			connection = {}
		await access.acquire(owner, connection, async () => true, true)
		await access.execute(owner, connection, { kind: "observation", page: 1 }, async () => ({
			content: [{ type: "text", text: "tree" }],
			_meta: { "com.browseros.neo/session": "original" },
		}))
		const result = await access.execute(owner, connection, { kind: "script" }, async () => ({
			isError: true,
			content: [{ type: "text", text }],
			_meta: { "com.browseros.neo/session": "replacement" },
		}))
		expect(access.canApproveTaskAction(owner, connection)).toBe(true)
		expect(access.toolArguments()).toEqual({ session: "original" })
		expect(JSON.stringify(result)).not.toContain("replacement")
		await expect(
			access.execute(owner, connection, { kind: "interaction", page: 1 }, async () => ({})),
		).rejects.toThrow("fresh")
	})

	it.each([
		"BrowserOS neo session is no longer live",
		"This browser session was stopped from the BrowserOS neo cockpit",
		"browser session not connected",
		"Unknown failure",
	])("revokes consent for %s", async (text) => {
		const access = new BrowserOSAccess()
		const owner = {},
			connection = {}
		await access.acquire(owner, connection, async () => true)
		await access.execute(owner, connection, { kind: "script" }, async () => ({
			isError: true,
			content: [{ type: "text", text }],
		}))
		expect(access.hasAccess(connection)).toBe(false)
	})
})

import { BrowserOSHeartbeat } from "../kilocode/BrowserOSHeartbeat"

describe("BrowserOS transport heartbeat", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("keeps the same transport alive beyond the server idle limit and stops on disposal", async () => {
		const ping = vi.fn().mockResolvedValue({})
		const failed = vi.fn()
		const heartbeat = new BrowserOSHeartbeat(() => true, ping, failed)
		await vi.advanceTimersByTimeAsync(600_000)
		expect(ping).toHaveBeenCalledTimes(10)
		expect(failed).not.toHaveBeenCalled()
		heartbeat.stop()
		await vi.advanceTimersByTimeAsync(120_000)
		expect(ping).toHaveBeenCalledTimes(10)
	})

	it("reports a failed ping once without retrying or creating a new session", async () => {
		const ping = vi.fn().mockRejectedValue(new Error("Session lost"))
		const failed = vi.fn()
		new BrowserOSHeartbeat(() => true, ping, failed)
		await vi.advanceTimersByTimeAsync(600_000)
		expect(ping).toHaveBeenCalledTimes(1)
		expect(failed).toHaveBeenCalledTimes(1)
	})

	it("does not ping a replaced connection", async () => {
		const ping = vi.fn()
		new BrowserOSHeartbeat(() => false, ping, vi.fn())
		await vi.advanceTimersByTimeAsync(120_000)
		expect(ping).not.toHaveBeenCalled()
	})

	it("ignores late failure after disposal", async () => {
		let reject!: (error: Error) => void
		const failed = vi.fn()
		const heartbeat = new BrowserOSHeartbeat(
			() => true,
			() =>
				new Promise((_, rejectPromise) => {
					reject = rejectPromise
				}),
			failed,
		)
		await vi.advanceTimersByTimeAsync(60_000)
		heartbeat.stop()
		reject(new Error("Late failure"))
		await vi.advanceTimersByTimeAsync(60_000)
		expect(failed).not.toHaveBeenCalled()
	})
})
// kilocode_change end
