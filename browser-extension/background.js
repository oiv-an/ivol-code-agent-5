// kilocode_change - new file
let socket
let session
let heartbeat
let queue = Promise.resolve()
let approving = false
let connecting = false
let controlEpoch = 0
let actionEpoch

async function discover() {
	if (connecting || approving || socket?.readyState === WebSocket.OPEN) return
	connecting = true
	try {
		await startupCleanup
		for (let port = 19440; port < 19450; port++) {
			try {
				const response = await fetch(`http://127.0.0.1:${port}/ivol-browser/discover`, {
					method: "POST",
					headers: { "X-IVOL-Connector": "1" },
					cache: "no-store",
					credentials: "omit",
					redirect: "error",
					signal: AbortSignal.timeout(500),
				})
				if (!response.ok) continue
				const config = await response.json()
				if (config.port !== port) continue
				await connect(JSON.stringify(config))
				return
			} catch (error) {
				// An IDE may be closed or this discovery slot may belong to another application.
				console.debug("IVOL discovery slot unavailable", port, error.message)
			}
		}
	} finally {
		connecting = false
	}
}

// Chrome owns debugger attachments independently of worker globals. Never restore grants after a crash.
const startupCleanup = (async () => {
	const targets = await chrome.debugger.getTargets()
	for (const target of targets) {
		if (!target.attached || target.type !== "page") continue
		try {
			// Chrome checks extension ownership; another extension's debugger cannot be detached here.
			await chrome.debugger.detach(target.tabId !== undefined ? { tabId: target.tabId } : { targetId: target.id })
		} catch (error) {
			console.debug("Startup target is not attached to this extension", error.message)
		}
	}
	await chrome.action.setBadgeText({ text: "" })
})()
// Register listeners synchronously below; report failure and fail closed when pairing is requested.
void startupCleanup.catch((error) => console.error("Browser connector startup cleanup failed", error.message))

function send(value) {
	if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
}

async function revoke(notify = true) {
	++controlEpoch
	const previous = session
	session = undefined
	if (previous) {
		if (notify) send({ event: "revoked", sessionId: previous.id })
		try {
			// The tab keeps its own size and layout, so nothing has to be restored.
			if (previous.tabId !== undefined) await chrome.debugger.detach({ tabId: previous.tabId })
		} catch (error) {
			console.debug("Debugger already detached", error.message)
		}
	}
	await chrome.action.setBadgeText({ text: "" })
}

function requireSession(id) {
	if (!session || session.id !== id || session.paused) throw new Error("Browser access is missing or paused")
	return session
}

async function command(id, method, params = {}) {
	const current = requireSession(id)
	if (actionEpoch !== controlEpoch) throw new Error("Control changed during action")
	return chrome.debugger.sendCommand({ tabId: current.tabId }, method, params)
}

async function snapshot(id, includeStructure = false) {
	const metrics = await command(id, "Page.getLayoutMetrics")
	const viewport = metrics.cssVisualViewport || metrics.visualViewport
	const image = await command(id, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false })
	let pageContent
	if (includeStructure) {
		const tree = await command(id, "Accessibility.getFullAXTree", { depth: 8 })
		const lines = []
		let length = 0
		for (const node of (tree.nodes || []).slice(0, 2000)) {
			if (node.ignored) continue
			const role = String(node.role?.value || "").slice(0, 100)
			const name = String(node.name?.value || "").slice(0, 500)
			if (!name && ["generic", "none", "InlineTextBox"].includes(role)) continue
			// Intentionally omit AX values and properties, which can contain form input.
			const line = `${role}: ${name}`
			if (length + line.length + 1 > 32000) break
			lines.push(line)
			length += line.length + 1
		}
		pageContent = lines.join("\n")
	}
	const current = requireSession(id)
	const tab = await chrome.tabs.get(current.tabId)
	const tabs = []
	for (const tabId of current.allowedTabs) {
		requireSession(id)
		if (actionEpoch !== controlEpoch) throw new Error("Control changed during capture")
		try {
			const allowed = await chrome.tabs.get(tabId)
			tabs.push({ id: String(tabId), url: (allowed.url || "").slice(0, 32768), active: tabId === current.tabId })
		} catch (error) {
			current.allowedTabs.delete(tabId)
			console.debug("Granted tab is no longer available", error.message)
		}
	}
	return {
		screenshot: `data:image/png;base64,${image.data}`,
		currentUrl: tab.url || "",
		viewportWidth: viewport.clientWidth,
		viewportHeight: viewport.clientHeight,
		logs: current.logs.splice(0).join("\n").slice(0, 65536),
		tabs,
		...(pageContent !== undefined ? { pageContent } : {}),
	}
}

function text(value, max = 10000) {
	if (typeof value !== "string" || value.length > max) throw new Error("Invalid text")
	return value
}

/**
 * A hidden tab may be frozen by Chrome. This keeps it running without touching its
 * size, zoom or layout: the page stays exactly as the user has it in the browser.
 */
async function keepRendering(tabId) {
	try {
		await chrome.debugger.sendCommand({ tabId }, "Page.setWebLifecycleState", { state: "active" })
	} catch (error) {
		// Screenshots of a frozen tab may be stale, but the user's window must not be resized.
		console.debug("Cannot keep the background tab active", error.message)
	}
}

// Only groups created by this connector during this worker lifetime are eligible.
// A matching personal group title never grants ownership.
const topicGroups = new Map()

function topicTitle(value = "Browser") {
	if (typeof value !== "string" || !/^[A-Za-z]{1,24}$/.test(value))
		throw new Error("Use one short English word for the browser group")
	return value[0].toUpperCase() + value.slice(1).toLowerCase()
}

async function findTaskGroup(title, check) {
	try {
		const id = topicGroups.get(title)
		if (id === undefined) return undefined
		const group = await chrome.tabGroups.get(id)
		check()
		if (group.title === title) return group
		topicGroups.delete(title)
		return undefined
	} catch (error) {
		check()
		topicGroups.delete(title)
		console.debug("Cannot find the task group", error.message)
		return undefined
	}
}

/** Only newly created agent tabs are grouped; existing personal tabs are left in place. */
async function groupAgentTab(tabId, title, check) {
	try {
		const tab = await chrome.tabs.get(tabId)
		check()
		const known = await findTaskGroup(title, check)
		check()
		// Never move a tab across windows, including when the user moves a group mid-request.
		if (known && known.windowId !== tab.windowId) return undefined
		const groupId = await chrome.tabs.group(known ? { tabIds: [tabId], groupId: known.id } : { tabIds: [tabId] })
		check()
		topicGroups.set(title, groupId)
		// A failed title update must not cause a second group to be created.
		await chrome.tabGroups.update(groupId, { title, color: "blue", collapsed: false })
		check()
		return groupId
	} catch (error) {
		check()
		console.debug("Cannot group the agent tab", error.message)
		return undefined
	}
}

async function createTaskTab(url, title, check) {
	const group = await findTaskGroup(title, check)
	check()
	// Create directly in the existing group's window without activating either window or tab.
	return chrome.tabs.create({ url, active: false, ...(group ? { windowId: group.windowId } : {}) })
}

/** Takes control of a background tab so the user keeps working in the foreground. */
async function authorize(request) {
	approving = true
	const epoch = controlEpoch
	try {
		const check = () => {
			if (socket?.readyState !== WebSocket.OPEN) throw new Error("Connection closed before access started")
			// A detach or revocation during setup must never end in a granted session.
			if (epoch !== controlEpoch) throw new Error("Browser access ended before it started")
		}
		const groupTitle = topicTitle(request.topic)
		check()
		let tab
		// The agent works in the background and never steals the tab the user is reading.
		if (request.url) tab = await createTaskTab(request.url, groupTitle, check)
		else [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
		check()
		if (!tab?.id || !/^https?:\/\//.test(tab.url || tab.pendingUrl || request.url || ""))
			throw new Error("Open a normal website tab in Chrome, then ask again")
		await chrome.debugger.attach({ tabId: tab.id }, "1.3")
		try {
			await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.enable")
			await chrome.debugger.sendCommand({ tabId: tab.id }, "Log.enable")
			await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.enable", { enableFileChooserOpenedEvent: true })
			await keepRendering(tab.id)
			check()
		} catch (error) {
			await chrome.debugger.detach({ tabId: tab.id })
			throw error
		}
		session = {
			id: request.sessionId,
			tabId: tab.id,
			groupTitle,
			allowedTabs: new Set([tab.id]),
			paused: false,
			logs: [],
			needsSnapshot: true,
		}
		// Existing personal tabs keep their original group and position.
		if (request.url) await groupAgentTab(tab.id, groupTitle, check)
		check()
		await chrome.action.setBadgeText({ text: "ON" })
		check()
		send({ id: request.id, result: { approved: true } })
	} catch (error) {
		// A badge or setup failure must not leave an unacknowledged grant behind.
		if (session?.id === request.sessionId) await revoke()
		throw error
	} finally {
		approving = false
	}
}

/** Opens an additional tab already approved in chat; the current tab keeps its page. */
async function createGrantedTab(request) {
	const current = session
	approving = true
	let created = false
	try {
		const check = () => {
			if (session !== current || request.epoch !== controlEpoch || current.paused)
				throw new Error("Browser access changed before the tab was ready")
		}
		check()
		const title = request.topic ? topicTitle(request.topic) : current.groupTitle
		const tab = await createTaskTab(request.url, title, check)
		created = true
		check()
		if (!Number.isSafeInteger(tab.id)) throw new Error("Chrome did not return a tab ID")
		current.allowedTabs.add(tab.id)
		await groupAgentTab(tab.id, title, check)
		current.groupTitle = title
		check()
		actionEpoch = request.epoch
		const result = await snapshot(current.id, true)
		check()
		await chrome.action.setBadgeText({ text: "ON" })
		check()
		send({ id: request.id, result })
	} catch (error) {
		const failure = created
			? new Error(
					`A tab was created, but access changed or observation failed. Do not retry creation; inspect it manually. ${error.message}`,
				)
			: error
		// A created tab stays open after revocation; it never receives an implicit new grant.
		if (created && session === current) await revoke()
		throw failure
	} finally {
		approving = false
	}
}

async function execute(message) {
	const { id, method, params = {} } = message
	if (message.version !== 2 || typeof id !== "string" || id.length > 100)
		throw new Error("Unsupported protocol; update IVOL and Browser Connector together")
	if (method === "authorize") {
		if (session || approving) throw new Error("Another browser session is already active")
		let url
		if (params.url) {
			url = new URL(text(params.url, 32768))
			if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS pages are supported")
		}
		// The user already approved this task in the IVOL chat; the browser asks nothing.
		await authorize({
			id,
			sessionId: text(params.sessionId, 100),
			topic: topicTitle(params.topic),
			url: url?.href,
		})
		return
	}
	if (method === "release") {
		if (session?.id === params.sessionId) await revoke(false)
		send({ id, result: {} })
		return
	}
	const sid = params.sessionId
	if (method === "pause" || method === "resume") {
		if (!session || session.id !== sid) throw new Error("Browser session changed")
		const current = session
		++controlEpoch
		current.paused = method === "pause"
		current.needsSnapshot = true
		current.logs = []
		await chrome.action.setBadgeText({ text: current.paused ? "II" : "ON" })
		if (session !== current) throw new Error("Browser session changed")
		send({ id, result: {} })
		return
	}
	requireSession(sid)
	if (approving) throw new Error("A browser permission is still being applied")
	const epoch = controlEpoch
	actionEpoch = epoch
	if (session.needsSnapshot && method !== "snapshot")
		throw new Error("Request a fresh screenshot after manual control")
	switch (method) {
		case "create_tab": {
			if (session.allowedTabs.size >= 20) throw new Error("At most 20 tabs can be granted per task")
			const url = new URL(text(params.url, 32768))
			if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS pages are supported")
			// Opening the tab was already approved in the IVOL chat.
			await createGrantedTab({ id, sessionId: sid, url: url.href, epoch, topic: params.topic })
			return
		}
		case "select_tab": {
			const current = requireSession(sid)
			const tabId = Number(text(params.tabId, 20))
			if (!Number.isSafeInteger(tabId) || !current.allowedTabs.has(tabId))
				throw new Error("This tab has not been granted by the user")
			if (tabId === current.tabId) break
			const tab = await chrome.tabs.get(tabId)
			if (!/^https?:\/\//.test(tab.url || tab.pendingUrl || "")) throw new Error("Unsupported tab URL")
			if (epoch !== controlEpoch) throw new Error("Control changed during tab selection")
			requireSession(sid)
			const previousTabId = current.tabId
			current.tabId = undefined
			let attached = false
			try {
				await chrome.debugger.detach({ tabId: previousTabId })
				if (epoch !== controlEpoch) throw new Error("Control changed during tab selection")
				requireSession(sid)
				await chrome.debugger.attach({ tabId }, "1.3")
				attached = true
				if (epoch !== controlEpoch) throw new Error("Control changed during tab selection")
				requireSession(sid)
				current.tabId = tabId
				current.logs = []
				current.needsSnapshot = true
				await command(sid, "Runtime.enable")
				await command(sid, "Log.enable")
				await command(sid, "Page.enable", { enableFileChooserOpenedEvent: true })
				await keepRendering(tabId)
			} catch (error) {
				if (attached && current.tabId !== tabId) {
					try {
						await chrome.debugger.detach({ tabId })
					} catch (cleanupError) {
						console.debug("Debugger cleanup failed", cleanupError.message)
					}
				}
				if (session === current) {
					if (!current.tabId) current.tabId = previousTabId
					await revoke()
				}
				throw error
			}
			break
		}
		case "snapshot":
			break
		case "click":
		case "hover": {
			const { x, y } = params
			if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 32768 || y > 32768)
				throw new Error("Invalid coordinates")
			await command(sid, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
			if (method === "click") {
				await command(sid, "Input.dispatchMouseEvent", {
					type: "mousePressed",
					x,
					y,
					button: "left",
					clickCount: 1,
				})
				await command(sid, "Input.dispatchMouseEvent", {
					type: "mouseReleased",
					x,
					y,
					button: "left",
					clickCount: 1,
				})
			}
			break
		}
		case "type":
			await command(sid, "Input.insertText", { text: text(params.text) })
			break
		case "press": {
			const parts = text(params.key, 80)
				.split("+")
				.map((part) => part.trim())
			let key = parts.pop()
			const modifierBits = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 }
			let modifiers = 0
			for (const part of parts) {
				if (!Object.hasOwn(modifierBits, part.toLowerCase())) throw new Error("Unsupported key modifier")
				modifiers |= modifierBits[part.toLowerCase()]
			}
			const keys = {
				Enter: 13,
				Tab: 9,
				Escape: 27,
				Backspace: 8,
				Delete: 46,
				ArrowLeft: 37,
				ArrowUp: 38,
				ArrowRight: 39,
				ArrowDown: 40,
				Home: 36,
				End: 35,
				PageUp: 33,
				PageDown: 34,
				Space: 32,
			}
			const aliases = { esc: "Escape", return: "Enter", space: "Space" }
			key =
				aliases[key.toLowerCase()] ||
				Object.keys(keys).find((name) => name.toLowerCase() === key.toLowerCase()) ||
				key
			if (modifiers & 8 && /^[a-z]$/i.test(key)) key = key.toUpperCase()
			const character = /^[a-z0-9]$/i.test(key)
			if (!Object.hasOwn(keys, key) && !character)
				throw new Error(
					"Unsupported key; use letters, digits, Enter, Tab, Escape, arrows, editing or paging keys",
				)
			const values = {
				key: key === "Space" ? " " : key,
				code: character ? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : `Digit${key}`) : key,
				windowsVirtualKeyCode: character ? key.toUpperCase().charCodeAt(0) : keys[key],
				modifiers,
			}
			await command(sid, "Input.dispatchKeyEvent", {
				...values,
				type: "keyDown",
				...(!(modifiers & 7)
					? { text: key === "Enter" ? "\r" : character ? key : key === "Space" ? " " : "" }
					: {}),
			})
			await command(sid, "Input.dispatchKeyEvent", { ...values, type: "keyUp" })
			break
		}
		case "scroll": {
			if (params.direction !== "up" && params.direction !== "down") throw new Error("Invalid direction")
			// A background tab does not process wheel input, so scroll the page directly.
			const amount = params.direction === "up" ? -1 : 1
			await command(sid, "Runtime.evaluate", {
				expression: `window.scrollBy({ top: ${amount} * Math.round(window.innerHeight * 0.85), behavior: "instant" })`,
				returnByValue: true,
				awaitPromise: false,
			})
			break
		}
		case "navigate": {
			const url = new URL(text(params.url, 32768))
			if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS pages are supported")
			await command(sid, "Page.navigate", { url: url.href })
			break
		}
		default:
			throw new Error("Unsupported browser command")
	}
	await new Promise((resolve) => setTimeout(resolve, 350))
	if (epoch !== controlEpoch) throw new Error("Control changed during action; request a fresh screenshot")
	const result = await snapshot(sid, method === "snapshot" || method === "select_tab")
	requireSession(sid)
	if (epoch !== controlEpoch) throw new Error("Control changed during capture; result discarded")
	if (method === "snapshot" || method === "select_tab") session.needsSnapshot = false
	send({ id, result })
}

async function connect(pairing) {
	const config = JSON.parse(pairing)
	if (
		config.version !== 2 ||
		!Number.isInteger(config.port) ||
		config.port < 1024 ||
		config.port > 65535 ||
		!/^[a-f0-9]{64}$/.test(config.token)
	)
		throw new Error("Invalid pairing code")
	await revoke()
	socket?.close()
	clearInterval(heartbeat)
	const connection = new WebSocket(`ws://127.0.0.1:${config.port}/ivol-browser`, [`ivol-auth-${config.token}`])
	socket = connection
	connection.onmessage = (event) => {
		if (socket !== connection) return
		let message
		try {
			message = JSON.parse(event.data)
		} catch {
			connection.close(1008, "Invalid message")
			return
		}
		if (!message || typeof message !== "object" || Array.isArray(message)) {
			connection.close(1008, "Invalid message")
			return
		}
		const queuedEpoch = controlEpoch
		// Pause and revocation invalidate in-flight work without waiting for the action queue.
		if (message.method === "release" || message.method === "pause") {
			void execute(message).catch(() => connection.close(1008, "Invalid control command"))
			return
		}
		queue = queue.then(async () => {
			if (socket !== connection) return
			try {
				if (queuedEpoch !== controlEpoch) throw new Error("Control changed; queued command cancelled")
				await execute(message)
			} catch (error) {
				send({ id: message.id, error: String(error.message).slice(0, 2000) })
			}
		})
	}
	connection.onclose = () => {
		if (socket !== connection) return
		socket = undefined
		clearInterval(heartbeat)
		void revoke()
	}
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			connection.close()
			reject(new Error("Connection timed out"))
		}, 5000)
		connection.onopen = () => {
			clearTimeout(timer)
			// WebSocket traffic keeps the service worker alive while paired.
			heartbeat = setInterval(() => {
				if (connection.readyState === WebSocket.OPEN)
					connection.send(JSON.stringify({ id: crypto.randomUUID(), result: "heartbeat" }))
			}, 20000)
			resolve()
		}
		connection.onerror = () => {
			clearTimeout(timer)
			reject(new Error("Cannot connect to IVOL. Automatic discovery will try again."))
		}
	})
}

// Keep only bounded summaries; never evaluate console objects or inspect other tabs.
chrome.debugger.onEvent.addListener((source, method, params) => {
	if (!session || session.paused || source.tabId !== session.tabId) return
	if (method === "Page.fileChooserOpened") {
		++controlEpoch
		session.paused = true
		session.needsSnapshot = true
		session.logs = []
		send({ event: "paused", sessionId: session.id })
		void chrome.action
			.setBadgeText({ text: "II" })
			.catch((error) => console.error("Cannot update file chooser pause badge", error.message))
		return
	}
	let entry
	if (method === "Runtime.consoleAPICalled") {
		const values = (params.args || []).slice(0, 20).map((arg) => {
			if (["string", "number", "boolean"].includes(typeof arg.value)) return String(arg.value).slice(0, 2048)
			return String(arg.description || arg.type || "object").slice(0, 2048)
		})
		entry = `[${params.type || "log"}] ${values.join(" ")}`
	} else if (method === "Runtime.exceptionThrown") {
		entry = `[exception] ${params.exceptionDetails?.text || "Uncaught exception"}`
	} else if (method === "Log.entryAdded") {
		entry = `[${params.entry?.level || "log"}] ${params.entry?.text || ""}`
	}
	if (entry) {
		session.logs.push(entry.slice(0, 4096))
		if (session.logs.length > 100) session.logs.shift()
	}
})

chrome.debugger.onDetach.addListener((source) => {
	if (session?.tabId === source.tabId) void revoke()
	// Detaching the tab being prepared must cancel that grant as well.
	else if (approving) ++controlEpoch
})

// Alarms wake an idle MV3 worker; a short timer makes a running worker responsive.
chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === "ivol-discover") void discover().catch((error) => console.error(error.message))
})
void (async () => {
	await chrome.alarms.create("ivol-discover", { periodInMinutes: 0.5 })
	await discover()
})().catch((error) => console.error("Automatic connection failed", error.message))
setInterval(() => void discover().catch((error) => console.error(error.message)), 3000)
