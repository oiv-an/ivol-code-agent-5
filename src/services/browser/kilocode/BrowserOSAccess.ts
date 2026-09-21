export type BrowserOSAccessStatus = "idle" | "awaitingPermission" | "active" | "paused"

export type BrowserOSOperation =
	| { kind: "observation" | "interaction"; page: number }
	| { kind: "discovery" | "create" | "unsupported" }

/** Classify only the protocol we have verified. Scripts cannot declare their own observed target. */
export function browserOSOperation(name: string, args?: Record<string, unknown>): BrowserOSOperation {
	if (name === "tabs" && ["list", "active"].includes(String(args?.action))) return { kind: "discovery" }
	if (name === "tabs" && args?.action === "new") {
		if (args.url !== undefined && args.url !== "about:blank") {
			const url = new URL(String(args.url))
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
				throw new Error("BrowserOS new tabs require HTTP(S) or about:blank without credentials")
		}
		return { kind: "create" }
	}
	if (
		[
			"snapshot",
			"screenshot",
			"navigate",
			"act",
			"diff",
			"read",
			"grep",
			"wait",
			"pdf",
			"upload",
			"download",
		].includes(name) ||
		(name === "tabs" && args?.action === "close")
	) {
		const page = args?.page
		if (typeof page !== "number" || !Number.isInteger(page) || page < 0 || page > 0xffffffff)
			throw new Error("BrowserOS requires a valid numeric target page ID")
		return { kind: ["snapshot", "screenshot"].includes(name) ? "observation" : "interaction", page }
	}
	return { kind: "unsupported" }
}

/** Keep browser control local; do not accept credentials or ambiguous localhost DNS. */
export function validateBrowserOSEndpoint(value: string): string {
	const url = new URL(value)
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "[::1]"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.hash ||
		url.search
	)
		throw new Error(
			"BrowserOS requires a local HTTP endpoint on 127.0.0.1 or [::1], without credentials or query parameters",
		)
	return url.href
}

/** Explicit consent for this host and connection. Never persisted or owned by a chat. */
export class BrowserOSAccess {
	// Used only to invalidate stale work and observations, never as the owner of consent.
	private currentCaller?: object
	private connection?: object
	private status: BrowserOSAccessStatus = "idle"
	private epoch = 0
	private observedPages = new Set<number>()
	private queue: Promise<unknown> = Promise.resolve()
	private sessionHandle?: string
	private allowTaskActions = false

	hasAccess(connection: object): boolean {
		return this.status === "active" && this.connection === connection
	}

	isPausedConnection(connection: object): boolean {
		return this.status === "paused" && this.connection === connection
	}

	canApproveTaskAction(_caller: object, connection: object): boolean {
		return this.hasAccess(connection) && this.allowTaskActions
	}

	/** End a caller's work without withdrawing the user's host-scoped consent. */
	endTask(caller: object): void {
		if (this.currentCaller !== caller) return
		++this.epoch
		this.currentCaller = undefined
		this.observedPages.clear()
	}

	/** Called only inside the serialized, authorized request. Never accept a model's handle. */
	toolArguments(argumentsValue?: Record<string, unknown>): Record<string, unknown> {
		const args = { ...argumentsValue }
		delete args.session
		if (this.sessionHandle) args.session = this.sessionHandle
		return args
	}

	/** Keep the opaque handle out of model-visible results and task history. */
	private captureSession<T>(result: T, retain = true): T {
		if (!result || typeof result !== "object" || !("_meta" in result)) return result
		const meta = result._meta
		if (!meta || typeof meta !== "object" || Array.isArray(meta)) return result
		const copy = { ...meta } as Record<string, unknown>
		const handle = copy["com.browseros.neo/session"]
		if (retain && typeof handle === "string" && handle.length > 0 && handle.length <= 4096)
			this.sessionHandle = handle
		delete copy["com.browseros.neo/session"]
		return { ...result, _meta: copy }
	}

	getStatus(): BrowserOSAccessStatus {
		return this.status
	}

	async acquire(
		_caller: object,
		connection: object,
		confirm: () => Promise<boolean>,
		allowTaskActions = false,
	): Promise<void> {
		if (this.connection === connection && this.status === "active" && this.allowTaskActions === allowTaskActions)
			return
		if (this.status === "paused") throw new Error("BrowserOS is paused. Return control explicitly in settings.")
		if (this.status === "awaitingPermission") throw new Error("BrowserOS permission is already pending")
		this.revoke()
		this.connection = connection
		this.status = "awaitingPermission"
		const epoch = this.epoch
		try {
			const approved = await confirm()
			if (this.epoch !== epoch || this.connection !== connection) throw new Error("BrowserOS permission expired")
			if (!approved) throw new Error("BrowserOS permission declined")
			this.allowTaskActions = allowTaskActions
			this.status = "active"
		} catch (error) {
			if (this.epoch === epoch) this.revoke()
			throw error
		}
	}

	pause(): void {
		if (this.status !== "active") throw new Error("No active BrowserOS grant")
		++this.epoch
		this.observedPages.clear()
		this.status = "paused"
	}

	resume(): void {
		if (this.status !== "paused") throw new Error("BrowserOS is not paused")
		++this.epoch
		this.observedPages.clear()
		this.status = "active"
	}

	revoke(caller?: object): void {
		if (caller && this.currentCaller !== caller) return
		++this.epoch
		this.currentCaller = undefined
		this.connection = undefined
		this.status = "idle"
		this.observedPages.clear()
		this.sessionHandle = undefined
		this.allowTaskActions = false
	}

	revokeConnection(connection: object): void {
		if (this.connection === connection) this.revoke()
	}

	async execute<T>(
		owner: object,
		connection: object,
		operation: BrowserOSOperation,
		request: () => Promise<T>,
	): Promise<T> {
		if (this.currentCaller !== owner) {
			++this.epoch
			this.currentCaller = owner
			this.observedPages.clear()
		}
		const epoch = this.epoch
		const policy = { ...operation }
		const check = () => {
			if (
				this.epoch !== epoch ||
				this.currentCaller !== owner ||
				this.connection !== connection ||
				this.status !== "active"
			)
				throw new Error("BrowserOS access changed, is paused, or has not been granted")
		}
		const run = async () => {
			check()
			if (policy.kind === "unsupported")
				throw new Error("This BrowserOS operation has no verified page-scoped policy and is not supported yet")
			if (policy.kind === "interaction" && !this.observedPages.has(policy.page))
				throw new Error("Get a fresh BrowserOS observation of the target page before interacting with it")
			// Every interaction may navigate or change references. Do not trust its response as a full snapshot.
			if (policy.kind === "interaction" || policy.kind === "create") this.observedPages.clear()
			if (policy.kind === "observation") this.observedPages.delete(policy.page)
			let result: T
			try {
				result = await request()
			} catch (error) {
				// A failed request may already have changed the page. Never replay or retain its grant.
				if (this.epoch === epoch) this.revoke(owner)
				throw error
			}
			check()
			// Tool-level failures can mean the user stopped the server session. Never silently revive it.
			if (result && typeof result === "object" && "isError" in result && result.isError === true) {
				this.revoke(owner)
				return this.captureSession(result, false)
			}
			if (policy.kind === "observation" && this.hasObservation(result)) this.observedPages.add(policy.page)
			return this.captureSession(result)
		}
		const next = this.queue.then(run, run)
		this.queue = next.catch(() => undefined)
		return next
	}

	private hasObservation(result: unknown): boolean {
		if (!result || typeof result !== "object" || !("content" in result)) return false
		if ("isError" in result && result.isError === true) return false
		if (!Array.isArray(result.content)) return false
		return result.content.some((block: unknown) => {
			if (!block || typeof block !== "object" || !("type" in block)) return false
			if (block.type === "text")
				return "text" in block && typeof block.text === "string" && block.text.trim().length > 0
			return (
				block.type === "image" &&
				"mimeType" in block &&
				["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(block.mimeType)) &&
				"data" in block &&
				typeof block.data === "string" &&
				block.data.length > 0 &&
				block.data.length <= 16 * 1024 * 1024 &&
				/^[A-Za-z0-9+/]+={0,2}$/.test(block.data)
			)
		})
	}
}
