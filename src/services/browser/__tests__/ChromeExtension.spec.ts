// kilocode_change - new file
import { readFileSync } from "node:fs"
import { createContext, runInContext } from "node:vm"
import { randomUUID, webcrypto } from "node:crypto"
import { TextEncoder } from "node:util"

function harness(targets: { id: string; tabId?: number; type: string; attached: boolean }[] = []) {
	const sent: any[] = []
	const debuggerCommands: string[] = []
	let connection: any
	const groups = new Map<number, { id: number; title: string; windowId: number }>()
	let nextGroupId = 42
	const chrome = {
		alarms: { onAlarm: { addListener: vi.fn() }, create: vi.fn(async () => undefined) },
		runtime: { id: "a".repeat(32), getURL: (path: string) => `chrome-extension://${"a".repeat(32)}/${path}` },
		action: { setBadgeText: vi.fn().mockResolvedValue(undefined), setBadgeBackgroundColor: vi.fn() },
		tabs: {
			query: vi.fn(async () => [{ id: 7, url: "https://example.com/form" }]),
			get: vi.fn(async () => ({ url: "https://example.com/form", windowId: 3 })),
			create: vi.fn(async () => ({ id: 8, url: "https://example.com/new" })),
			group: vi.fn(async (options: { tabIds: number[]; groupId?: number }) => {
				if (options.groupId !== undefined) {
					if (!groups.has(options.groupId)) throw new Error("Group no longer exists")
					return options.groupId
				}
				while (groups.has(nextGroupId)) nextGroupId++
				const id = nextGroupId++
				groups.set(id, { id, title: "", windowId: 3 })
				return id
			}),
		},
		tabGroups: {
			get: vi.fn(async (id: number) => {
				const group = groups.get(id)
				if (!group) throw new Error("Group no longer exists")
				return group
			}),
			query: vi.fn(async ({ title }: { title: string }) =>
				[...groups.values()].filter((group) => group.title === title),
			),
			update: vi.fn(async (id: number, properties: { title: string; color: string; collapsed: boolean }) => {
				const group = groups.get(id)
				if (!group) throw new Error("Group no longer exists")
				group.title = properties.title
			}),
		},
		windows: { get: vi.fn(async () => ({ width: 1600, height: 1000 })) },
		debugger: {
			getTargets: vi.fn(async () => targets),
			attach: vi.fn(),
			detach: vi.fn(),
			onDetach: { addListener: vi.fn() },
			onEvent: { addListener: vi.fn() },
			sendCommand: vi.fn(async (_target: unknown, method: string) => {
				debuggerCommands.push(method)
				if (method === "Page.getLayoutMetrics")
					return { cssVisualViewport: { clientWidth: 900, clientHeight: 600 } }
				if (method === "Page.captureScreenshot") return { data: "YQ==" }
				if (method === "Accessibility.getFullAXTree")
					return {
						nodes: [
							{ role: { value: "button" }, name: { value: "Submit" } },
							{
								role: { value: "textbox" },
								name: { value: "Password" },
								value: { value: "private-input" },
							},
						],
					}
				return {}
			}),
		},
	}
	class Socket {
		static OPEN = 1
		readyState = 1
		onopen?: () => void
		onclose?: () => void
		onmessage?: (event: { data: string }) => void
		constructor() {
			connection = { deliver: (data: string) => this.onmessage?.({ data }) }
			queueMicrotask(() => this.onopen?.())
		}
		send(raw: string) {
			sent.push(JSON.parse(raw))
		}
		close() {
			this.readyState = 3
			this.onclose?.()
		}
	}
	const fetchMock = vi.fn(async () => ({
		ok: true,
		json: async () => ({ version: 2, port: 19440, token: "a".repeat(64) }),
	}))
	const context = createContext({
		chrome,
		fetch: fetchMock,
		AbortSignal,
		WebSocket: Socket,
		URL,
		crypto: webcrypto,
		TextEncoder,
		console,
		setTimeout: (fn: () => void, ms: number) => (ms === 350 ? setTimeout(fn, 0) : setTimeout(fn, ms)),
		clearTimeout,
		setInterval: () => 1,
		clearInterval: () => undefined,
	})
	runInContext(readFileSync(new URL("../../../../browser-extension/background.js", import.meta.url), "utf8"), context)
	const connected = () => vi.waitFor(() => expect(connection).toBeDefined())
	const command = async (method: string, params: object) => {
		const id = randomUUID()
		connection.deliver(JSON.stringify({ version: 2, id, method, params }))
		await vi.waitFor(() => expect(sent.some((r) => r.id === id)).toBe(true))
		return sent.find((r) => r.id === id)
	}
	/** The chat grants access; the browser never shows a prompt. */
	const authorize = async (params: object = {}) => {
		const sessionId = randomUUID()
		const reply = await command("authorize", { sessionId, topic: "Browser", ...params })
		return { sessionId, reply }
	}
	const metricsOverrides = () =>
		chrome.debugger.sendCommand.mock.calls
			.filter((call: any[]) => call[1] === "Emulation.setDeviceMetricsOverride")
			.map((call: any[]) => call[2])
	return { connected, command, authorize, sent, chrome, groups, debuggerCommands, fetchMock, metricsOverrides }
}

it("connects automatically and takes no page access before the chat asks", async () => {
	const h = harness()
	await h.connected()
	expect(h.fetchMock).toHaveBeenCalledWith(
		"http://127.0.0.1:19440/ivol-browser/discover",
		expect.objectContaining({ method: "POST" }),
	)
	expect(h.chrome.debugger.attach).not.toHaveBeenCalled()
	expect(h.debuggerCommands).toEqual([])
	expect((await h.command("snapshot", { sessionId: randomUUID() })).error).toContain("missing")
})

it("grants control of the current tab from chat without any browser prompt", async () => {
	const h = harness()
	await h.connected()
	const { sessionId, reply } = await h.authorize()
	expect(reply.result).toEqual({ approved: true })
	expect(h.chrome.tabs.create).not.toHaveBeenCalled()
	expect(h.chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 7 }, "1.3")
	const snapshot = await h.command("snapshot", { sessionId })
	expect(snapshot.result.currentUrl).toBe("https://example.com/form")
	expect(snapshot.result.pageContent).toContain("button: Submit")
	expect(snapshot.result.pageContent).not.toContain("private-input")
	expect(h.debuggerCommands).not.toContain("Page.navigate")
})

it("opens the requested site in the background without stealing focus", async () => {
	const h = harness()
	await h.connected()
	const { sessionId, reply } = await h.authorize({ url: "https://example.com/new" })
	expect(reply.result).toEqual({ approved: true })
	expect(h.chrome.tabs.create).toHaveBeenCalledWith({ url: "https://example.com/new", active: false })
	expect(h.chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 8 }, "1.3")
	expect((await h.command("snapshot", { sessionId })).result.screenshot).toContain("data:image/png")
})

it("never changes the size, zoom or layout of the personal browser window", async () => {
	const h = harness()
	await h.connected()
	const { sessionId } = await h.authorize({ url: "https://example.com/new" })
	await h.command("snapshot", { sessionId })
	await h.command("create_tab", { sessionId, url: "https://example.com/second" })
	await h.command("select_tab", { sessionId, tabId: "8" })
	await h.command("release", { sessionId })
	expect(h.metricsOverrides()).toEqual([])
	expect(h.debuggerCommands).not.toContain("Emulation.clearDeviceMetricsOverride")
	expect(h.debuggerCommands).not.toContain("Emulation.setPageScaleFactor")
	expect(h.debuggerCommands).not.toContain("Browser.setWindowBounds")
	// A background tab may be frozen, so only its lifecycle state is kept active.
	expect(h.debuggerCommands).toContain("Page.setWebLifecycleState")
})

it("scrolls a background tab without wheel input, which such a tab never processes", async () => {
	const h = harness()
	await h.connected()
	const { sessionId } = await h.authorize({ url: "https://example.com/new" })
	await h.command("snapshot", { sessionId })
	expect((await h.command("scroll", { sessionId, direction: "down" })).result).toBeDefined()
	expect((await h.command("scroll", { sessionId, direction: "up" })).result).toBeDefined()
	expect((await h.command("scroll", { sessionId, direction: "sideways" })).error).toContain("direction")
	const scrolls = h.chrome.debugger.sendCommand.mock.calls
		.filter((call: any[]) => call[1] === "Runtime.evaluate")
		.map((call: any[]) => String(call[2]?.expression ?? ""))
	expect(scrolls).toHaveLength(2)
	expect(scrolls[0]).toContain("window.scrollBy")
	expect(scrolls[0]).toContain("1 *")
	expect(scrolls[1]).toContain("-1 *")
	expect(h.debuggerCommands).not.toContain("Input.dispatchMouseEvent")
})

it("keeps working when the background tab cannot be kept active", async () => {
	const h = harness()
	await h.connected()
	h.chrome.debugger.sendCommand.mockImplementation(async (_target: unknown, method: string) => {
		if (method === "Page.setWebLifecycleState") throw new Error("Unsupported")
		if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 900, clientHeight: 600 } }
		if (method === "Page.captureScreenshot") return { data: "YQ==" }
		return {}
	})
	const { sessionId, reply } = await h.authorize({ url: "https://example.com/new" })
	expect(reply.result).toEqual({ approved: true })
	expect((await h.command("snapshot", { sessionId })).result.screenshot).toContain("data:image/png")
})

it("shows a group named after the task even with a single tab", async () => {
	const h = harness()
	await h.connected()
	const { sessionId } = await h.authorize({ url: "https://example.com/new", topic: "Research" })
	expect(h.chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [8] })
	// A short topic is visible instead of an internal task identifier.
	expect(h.chrome.tabGroups.update).toHaveBeenCalledWith(42, {
		title: "Research",
		color: "blue",
		collapsed: false,
	})
	await h.command("snapshot", { sessionId })
	await h.command("create_tab", { sessionId, url: "https://example.com/second" })
	// Additional agent tabs join the same group instead of creating a new one.
	expect(h.chrome.tabs.group).toHaveBeenLastCalledWith({ tabIds: [8], groupId: 42 })
})

it("reuses one group per task across separate sessions", async () => {
	const h = harness()
	await h.connected()
	const first = await h.authorize({ url: "https://example.com/new", taskId: "task-a" })
	await h.command("release", { sessionId: first.sessionId })
	await h.authorize({ url: "https://example.com/again", taskId: "task-a" })
	expect(h.chrome.tabs.group).toHaveBeenLastCalledWith({ tabIds: [8], groupId: 42 })
	const titles = h.chrome.tabGroups.update.mock.calls.map((call: any[]) => call[1].title)
	expect(new Set(titles)).toEqual(new Set(["Browser"]))
})

it("gives a different task its own group", async () => {
	const h = harness()
	await h.connected()
	const first = await h.authorize({ url: "https://example.com/new", taskId: "task-a" })
	await h.command("release", { sessionId: first.sessionId })
	await h.authorize({ url: "https://example.com/other", topic: "Invoices" })
	expect(h.chrome.tabs.group).toHaveBeenLastCalledWith({ tabIds: [8] })
	expect(h.chrome.tabGroups.update).toHaveBeenLastCalledWith(43, {
		title: "Invoices",
		color: "blue",
		collapsed: false,
	})
})

it("starts a new group when the remembered one no longer exists", async () => {
	const h = harness()
	await h.connected()
	const first = await h.authorize({ url: "https://example.com/new", taskId: "task-a" })
	await h.command("release", { sessionId: first.sessionId })
	// The user may close the group; grouping must not fail because of a stale identifier.
	h.groups.clear()
	const { sessionId, reply } = await h.authorize({ url: "https://example.com/again", taskId: "task-a" })
	expect(reply.result).toEqual({ approved: true })
	expect(h.chrome.tabs.group).toHaveBeenLastCalledWith({ tabIds: [8] })
	expect((await h.command("snapshot", { sessionId })).result.screenshot).toContain("data:image/png")
})

it("keeps controlling the page when grouping is not available", async () => {
	const h = harness()
	await h.connected()
	h.chrome.tabs.group.mockRejectedValue(new Error("Grouping unavailable"))
	const { sessionId, reply } = await h.authorize({ url: "https://example.com/new" })
	expect(reply.result).toEqual({ approved: true })
	expect((await h.command("snapshot", { sessionId })).result.screenshot).toContain("data:image/png")
})

it("revokes an unacknowledged grant when the active badge fails", async () => {
	const h = harness()
	await h.connected()
	h.chrome.action.setBadgeText.mockImplementation(async ({ text }: { text: string }) => {
		if (text === "ON") throw new Error("Badge unavailable")
	})
	const { sessionId, reply } = await h.authorize({ url: "https://example.com/new" })
	expect(reply.error).toContain("Badge unavailable")
	expect(h.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 8 })
	expect((await h.command("snapshot", { sessionId })).error).toContain("missing")
})

it("does not adopt a surviving group by its title after a worker restart", async () => {
	const first = harness()
	await first.connected()
	const grant = await first.authorize({ url: "https://example.com/new", taskId: "persistent-task" })
	await first.command("release", { sessionId: grant.sessionId })
	const restarted = harness()
	for (const [id, group] of first.groups) restarted.groups.set(id, { ...group })
	await restarted.connected()
	expect(restarted.chrome.debugger.attach).not.toHaveBeenCalled()
	const next = await restarted.authorize({ url: "https://example.com/again", taskId: "persistent-task" })
	expect(next.reply.result).toEqual({ approved: true })
	expect(restarted.chrome.tabs.create).toHaveBeenCalledWith({
		url: "https://example.com/again",
		active: false,
	})
	expect(restarted.chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [8] })
	expect(restarted.groups.size).toBe(2)
	await restarted.command("snapshot", { sessionId: next.sessionId })
	expect((await restarted.command("select_tab", { sessionId: next.sessionId, tabId: "7" })).error).toContain(
		"not been granted",
	)
})

it("never adopts a personal group with the same topic", async () => {
	const h = harness()
	h.groups.set(90, { id: 90, title: "Research", windowId: 3 })
	await h.connected()
	await h.authorize({ url: "https://example.com/new", topic: "Research" })
	expect(h.chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [8] })
	expect(h.chrome.tabGroups.update).toHaveBeenCalledWith(42, expect.objectContaining({ title: "Research" }))
	expect(h.groups.get(90)).toEqual({ id: 90, title: "Research", windowId: 3 })
})

it("does not regroup an existing personal tab", async () => {
	const h = harness()
	await h.connected()
	await h.authorize()
	expect(h.chrome.tabs.group).not.toHaveBeenCalled()
})

it("never approves a session revoked while grouping is in flight", async () => {
	const h = harness()
	await h.connected()
	let finish!: (id: number) => void
	h.chrome.tabs.group.mockImplementationOnce(
		() =>
			new Promise<number>((resolve) => {
				finish = resolve
			}),
	)
	const sessionId = randomUUID()
	const pending = h.command("authorize", { sessionId, taskId: "task", url: "https://example.com/new" })
	await vi.waitFor(() => expect(finish).toBeDefined())
	await h.command("release", { sessionId })
	finish(42)
	expect((await pending).error).toBeDefined()
	expect(h.sent.some((reply) => reply.result?.approved)).toBe(false)
	expect(h.chrome.tabGroups.update).not.toHaveBeenCalled()
	expect((await h.command("snapshot", { sessionId })).error).toContain("missing")
})

it("does not create a second group when naming the first group fails", async () => {
	const h = harness()
	await h.connected()
	h.chrome.tabGroups.update.mockRejectedValueOnce(new Error("Group update failed"))
	const { reply } = await h.authorize({ url: "https://example.com/new" })
	expect(reply.result).toEqual({ approved: true })
	expect(h.chrome.tabs.group).toHaveBeenCalledOnce()
})

it("cleans orphan debugger attachments before connecting without restoring grants", async () => {
	const h = harness([
		{ id: "old", tabId: 7, type: "page", attached: true },
		{ id: "unused", tabId: 8, type: "page", attached: false },
	])
	await h.connected()
	expect(h.chrome.debugger.detach).toHaveBeenCalledExactlyOnceWith({ tabId: 7 })
	expect((await h.command("snapshot", { sessionId: randomUUID() })).error).toContain("missing")
})

it("creates an additional tab straight from chat and keeps the current target", async () => {
	const h = harness()
	await h.connected()
	const { sessionId } = await h.authorize()
	await h.command("snapshot", { sessionId })
	const response = await h.command("create_tab", { sessionId, url: "https://example.com/new" })
	expect(h.chrome.tabs.create).toHaveBeenCalledWith({ url: "https://example.com/new", active: false })
	expect(response.result.tabs).toEqual([
		{ id: "7", url: "https://example.com/form", active: true },
		{ id: "8", url: "https://example.com/form", active: false },
	])
	expect(h.chrome.debugger.detach).not.toHaveBeenCalled()
})

it("revokes access and warns against retrying when observation fails after tab creation", async () => {
	const h = harness()
	await h.connected()
	const { sessionId } = await h.authorize()
	await h.command("snapshot", { sessionId })
	h.chrome.debugger.sendCommand.mockRejectedValueOnce(new Error("Capture failed"))
	const reply = await h.command("create_tab", { sessionId, url: "https://example.com/new" })
	expect(reply.error).toContain("Do not retry creation")
	expect(h.chrome.tabs.create).toHaveBeenCalledOnce()
	expect((await h.command("snapshot", { sessionId })).error).toContain("missing")
})

it("dispatches bounded key combinations and rejects unknown modifiers", async () => {
	const h = harness()
	await h.connected()
	const { sessionId } = await h.authorize()
	await h.command("snapshot", { sessionId })
	expect((await h.command("press", { sessionId, key: "Ctrl+A" })).result).toBeDefined()
	expect(h.chrome.debugger.sendCommand).toHaveBeenCalledWith(
		{ tabId: 7 },
		"Input.dispatchKeyEvent",
		expect.objectContaining({ type: "keyDown", key: "A", code: "KeyA", modifiers: 2 }),
	)
	expect((await h.command("press", { sessionId, key: "Shift+a" })).result).toBeDefined()
	expect((await h.command("press", { sessionId, key: "Unknown+Enter" })).error).toContain("modifier")
})

it("revokes only when the currently controlled debugger detaches", async () => {
	const h = harness()
	await h.connected()
	const { sessionId } = await h.authorize()
	const detach = h.chrome.debugger.onDetach.addListener.mock.calls[0][0]
	detach({ tabId: 99 }, "target_closed")
	expect((await h.command("snapshot", { sessionId })).result).toBeDefined()
	detach({ tabId: 7 }, "canceled_by_user")
	expect((await h.command("snapshot", { sessionId })).error).toContain("missing")
	expect(h.sent).toContainEqual({ event: "revoked", sessionId })
})

it("hands file selection to the user without collecting files or controlling the dialog", async () => {
	const h = harness()
	await h.connected()
	const { sessionId } = await h.authorize()
	await h.command("snapshot", { sessionId })
	const event = h.chrome.debugger.onEvent.addListener.mock.calls[0][0]
	event({ tabId: 99 }, "Page.fileChooserOpened", {})
	expect((await h.command("snapshot", { sessionId })).result).toBeDefined()
	event({ tabId: 7 }, "Page.fileChooserOpened", { backendNodeId: 42 })
	expect(h.sent).toContainEqual({ event: "paused", sessionId })
	const count = h.debuggerCommands.length
	expect((await h.command("press", { sessionId, key: "Enter" })).error).toContain("paused")
	expect(h.debuggerCommands).toHaveLength(count)
	expect(h.debuggerCommands).not.toContain("DOM.setFileInputFiles")
	expect(h.debuggerCommands).not.toContain("Page.setInterceptFileChooserDialog")
	await h.command("resume", { sessionId })
	expect((await h.command("press", { sessionId, key: "Enter" })).error).toContain("fresh screenshot")
	expect((await h.command("snapshot", { sessionId })).result).toBeDefined()
	expect((await h.command("press", { sessionId, key: "Enter" })).result).toBeDefined()
})

it("pauses from the IDE and requires a fresh observation after resuming", async () => {
	const h = harness()
	await h.connected()
	const { sessionId } = await h.authorize()
	expect((await h.command("pause", { sessionId })).result).toBeDefined()
	expect((await h.command("snapshot", { sessionId })).error).toContain("paused")
	expect((await h.command("resume", { sessionId: "different" })).error).toContain("changed")
	expect((await h.command("resume", { sessionId })).result).toBeDefined()
	expect((await h.command("press", { sessionId, key: "Enter" })).error).toContain("fresh screenshot")
	expect((await h.command("snapshot", { sessionId })).result).toBeDefined()
})

it("releases the session without closing the personal tab", async () => {
	const h = harness()
	await h.connected()
	const { sessionId } = await h.authorize()
	await h.command("snapshot", { sessionId })
	expect((await h.command("click", { sessionId, x: 1, y: 1 })).result).toBeDefined()
	await h.command("release", { sessionId })
	expect(h.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 7 })
	expect(h.sent.filter((r) => r.event === "revoked")).toEqual([])
	expect((await h.command("snapshot", { sessionId })).error).toContain("missing")
})

it("lists and selects only tabs granted through chat", async () => {
	const h = harness()
	await h.connected()
	const { sessionId } = await h.authorize()
	expect((await h.command("snapshot", { sessionId })).result.tabs.map((tab: any) => tab.id)).toEqual(["7"])
	expect((await h.command("select_tab", { sessionId, tabId: "9" })).error).toContain("not been granted")
	await h.command("create_tab", { sessionId, url: "https://example.com/second" })
	const selected = await h.command("select_tab", { sessionId, tabId: "8" })
	expect(selected.result.tabs.find((tab: any) => tab.active).id).toBe("8")
	expect(h.chrome.debugger.attach).toHaveBeenLastCalledWith({ tabId: 8 }, "1.3")
})

it("collects bounded console messages only for the controlled tab", async () => {
	const h = harness()
	await h.connected()
	const { sessionId } = await h.authorize()
	const event = h.chrome.debugger.onEvent.addListener.mock.calls[0][0]
	const log = (tabId: number, value: string) =>
		event({ tabId }, "Runtime.consoleAPICalled", { type: "log", args: [{ value }] })
	log(9, "other tab")
	log(7, "allowed")
	expect((await h.command("snapshot", { sessionId })).result.logs).toBe("[log] allowed")
	for (let i = 0; i < 200; i++) log(7, "x".repeat(5000))
	expect((await h.command("snapshot", { sessionId })).result.logs.length).toBeLessThanOrEqual(65536)
})

it("does not grant access when the connection drops during authorization", async () => {
	const h = harness()
	await h.connected()
	let finishAttach!: () => void
	h.chrome.debugger.attach.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				finishAttach = resolve
			}),
	)
	const sessionId = randomUUID()
	const authorizing = h.command("authorize", { sessionId, taskId: "task" })
	await vi.waitFor(() => expect(finishAttach).toBeDefined())
	const detach = h.chrome.debugger.onDetach.addListener.mock.calls[0][0]
	detach({ tabId: 7 }, "canceled_by_user")
	await Promise.resolve()
	finishAttach()
	expect((await authorizing).error).toBeDefined()
	expect(h.sent.some((reply) => reply.result?.approved)).toBe(false)
	expect((await h.command("snapshot", { sessionId })).error).toContain("missing")
})
