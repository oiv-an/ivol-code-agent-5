// kilocode_change - new file
import { Dispatcher, getGlobalDispatcher } from "undici"

const DEFAULT_TIMEOUT_MS = 600_000

/** Delegates to the already-configured connection pool/proxy; owns no connections. */
class RequestTimeoutDispatcher extends Dispatcher {
	constructor(
		private readonly delegate: Dispatcher,
		private readonly timeoutMs: number,
	) {
		super()
	}

	override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
		return this.delegate.dispatch(
			{ ...options, headersTimeout: this.timeoutMs, bodyTimeout: this.timeoutMs },
			handler,
		)
	}
}

/**
 * Node's fetch has its own body-idle timeout, independent of the SDK's timer
 * (which ends at response headers). Align both waits with the user's setting.
 * Fetch/undici retain ownership of cancellation, timers and pooled connections.
 * Never replace the global dispatcher: that would bypass configured proxies.
 */
export function createOpenAiFetch(timeoutMs?: number): typeof globalThis.fetch {
	const effectiveTimeout =
		typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
			? Math.ceil(timeoutMs)
			: DEFAULT_TIMEOUT_MS
	return (input, init) => {
		const requestInit = init as (RequestInit & { dispatcher?: Dispatcher }) | undefined
		const dispatcher = new RequestTimeoutDispatcher(
			requestInit?.dispatcher ?? getGlobalDispatcher(),
			effectiveTimeout,
		)
		return globalThis.fetch(input, { ...init, dispatcher } as RequestInit)
	}
}
