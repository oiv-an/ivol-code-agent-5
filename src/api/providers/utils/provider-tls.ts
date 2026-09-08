// kilocode_change - new file
import { Agent, Dispatcher, getGlobalDispatcher } from "undici"
import { createHash } from "node:crypto"

import { createOpenAiFetch } from "./openai-fetch"
import { createVsCodeProviderFetch } from "./provider-tls-vscode"

export interface ProviderFetchOptions {
	allowInsecureTls?: boolean
	baseUrl?: string
	timeoutMs?: number
}

type DispatcherFactory = () => Dispatcher
const insecureDispatcherFactories = new WeakMap<Dispatcher, DispatcherFactory>()

/** Register an equivalent route, retaining proxy authentication and proxy TLS validation. */
export function registerProviderTlsDispatcher(dispatcher: Dispatcher, insecureFactory: DispatcherFactory): void {
	insecureDispatcherFactories.set(dispatcher, insecureFactory)
}

const stockAgent = new Agent()

// Verified against undici 6.21.3 and Node 20's bundled undici 6.24.1.
// Literal fingerprints remain stable when the extension is bundled/minified.
const STOCK_NATIVE_ROUTING = {
	factory: "304d49c03d4043dc85fbdd5756797bf281023d62a3c09f65096fa7164c206bc4",
	dispatch: "9070d29d895f8af38fffd4ce10d5b03958873ae95cedad8c3709b74199c897cc",
	internalDispatch: "57ab9aead042100e83183976fd7b919a0594ce3340269f0338eee79f4d7741b2",
	interceptor: "b7cfcf547899a135965882356bdaeb140b2eb1f6afcaf65ca80abf9158135fb9",
} as const

function symbolValue(object: object, description: string): unknown {
	const symbol = Object.getOwnPropertySymbols(object).find((key) => key.description === description)
	return symbol ? Object.getOwnPropertyDescriptor(object, symbol)?.value : undefined
}

function normalizedFunction(value: unknown): string | undefined {
	if (typeof value !== "function") return undefined
	// Node bundles its own undici copy with formatting/semicolon/quote differences.
	return Function.prototype.toString
		.call(value)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/[^\n]*/g, "")
		.replace(/[\s;]+/g, "")
		.replace(/'/g, '"')
		.replace("__name(functionIntercept", "functionIntercept")
		.replace('},"Intercept")', "}")
}

function functionFingerprint(value: unknown): string | undefined {
	const source = normalizedFunction(value)
	return source === undefined ? undefined : createHash("sha256").update(source).digest("hex")
}

/**
 * Undici has no public API for changing TLS settings on an existing dispatcher.
 * Only verified stock undici 6/7 Agents may use the direct route below.
 * Guard every routing hook (including Node's separately bundled copy); unknown
 * versions, custom connectors/factories/interceptors and proxy agents fail closed.
 * Private fields are inspected for compatibility, never modified or cloned.
 */
function isStockDirectAgent(dispatcher: Dispatcher): boolean {
	const options = symbolValue(dispatcher, "options")
	if (!options || typeof options !== "object") return false
	// VS Code's Node 24 uses undici 7 with maxOrigins and no redirect interceptor.
	if (Object.hasOwn(options, "maxOrigins")) {
		return isStockNativeV7Agent(dispatcher, options as Record<string, unknown>)
	}
	if (Object.keys(options).some((key) => key !== "connect" && key !== "interceptors")) return false
	if (Object.values(options).some((value) => value !== undefined)) return false
	if (symbolValue(dispatcher, "maxRedirections") !== 0) return false
	const prototype = Object.getPrototypeOf(dispatcher)
	const interceptors = symbolValue(dispatcher, "dispatch interceptors")
	const defaults = symbolValue(stockAgent, "dispatch interceptors")
	if (!Array.isArray(interceptors) || !Array.isArray(defaults)) return false
	if (prototype === Agent.prototype) {
		return (
			dispatcher.dispatch === stockAgent.dispatch &&
			symbolValue(dispatcher, "factory") === symbolValue(stockAgent, "factory") &&
			interceptors.length === defaults.length &&
			interceptors.every((value, index) => normalizedFunction(value) === normalizedFunction(defaults[index]))
		)
	}
	return (
		prototype?.constructor?.name === "Agent" &&
		functionFingerprint(dispatcher.dispatch) === STOCK_NATIVE_ROUTING.dispatch &&
		functionFingerprint(symbolValue(dispatcher, "factory")) === STOCK_NATIVE_ROUTING.factory &&
		functionFingerprint(symbolValue(prototype, "dispatch")) === STOCK_NATIVE_ROUTING.internalDispatch &&
		interceptors.length === 1 &&
		functionFingerprint(interceptors[0]) === STOCK_NATIVE_ROUTING.interceptor
	)
}

function isStockNativeV7Agent(dispatcher: Dispatcher, options: Record<string, unknown>): boolean {
	if (Object.keys(options).some((key) => key !== "maxOrigins" && key !== "connect")) return false
	if (options.maxOrigins !== Infinity || options.connect !== undefined) return false
	if (symbolValue(dispatcher, "dispatch interceptors") !== undefined) return false
	const prototype = Object.getPrototypeOf(dispatcher)
	return (
		prototype?.constructor?.name === "Agent" &&
		functionFingerprint(symbolValue(dispatcher, "factory")) === STOCK_NATIVE_ROUTING.factory &&
		functionFingerprint(dispatcher.dispatch) ===
			"9b6db65543d066f53a421acd500c14b6151e8e55af179b625eae99fe2bcf6f0a" &&
		[
			// Node 24.18.1 bundled undici and VS Code's separate undici 7.29.0 package.
			"6d02af0b920503f03336084a36191564548961e05e8e5d1ab15ad45847e029a5",
			"efbeeac1c593795b7ba7cf9c97716593aea615ed75ab1fa9ec47f46d8116a0b6",
		].includes(functionFingerprint(symbolValue(prototype, "dispatch")) ?? "")
	)
}

function insecureFactoryFor(delegate: Dispatcher): DispatcherFactory {
	const registered = insecureDispatcherFactories.get(delegate)
	if (registered) return registered
	// In particular, model catalogues previously used axios, which honors these
	// environment routes. Never turn an opt-out into an implicit direct request.
	const proxyConfigured = [
		"http_proxy",
		"HTTP_PROXY",
		"https_proxy",
		"HTTPS_PROXY",
		"all_proxy",
		"ALL_PROXY",
		"GLOBAL_AGENT_HTTP_PROXY",
		"GLOBAL_AGENT_HTTPS_PROXY",
	].some((name) => Boolean(process.env[name]?.trim()))
	if (proxyConfigured) {
		throw new Error(
			"Cannot ignore the provider certificate with an unregistered environment proxy. " +
				"Certificate validation remains enabled; the configured proxy route was not bypassed.",
		)
	}
	if (isStockDirectAgent(delegate)) {
		return () => new Agent({ connect: { rejectUnauthorized: false } })
	}
	throw new Error(
		"Cannot ignore the provider certificate with this custom network dispatcher. " +
			"Certificate validation remains enabled; the configured proxy route was not bypassed.",
	)
}

class ProviderTlsDispatcher extends Dispatcher {
	constructor(
		private readonly delegate: Dispatcher,
		private readonly allowedOrigin: string,
	) {
		super()
	}

	override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
		if (!options.origin || new URL(options.origin).origin !== this.allowedOrigin) {
			return this.delegate.dispatch(options, handler)
		}
		// Own each insecure connection until its stream completes or is cancelled.
		// Never retain an insecure pooled connection for another provider/profile.
		const owned = insecureFactoryFor(this.delegate)()
		let released = false
		const release = () => {
			if (released) return
			released = true
			void owned.close().catch(() => {
				console.warn("[Provider TLS] Failed to close a provider-scoped connection pool")
			})
		}
		const scopedHandler: Dispatcher.DispatchHandlers = {
			onConnect: (...args) => handler.onConnect?.(...args),
			onResponseStarted: () => handler.onResponseStarted?.(),
			onHeaders: (...args) => handler.onHeaders?.(...args) ?? true,
			onData: (...args) => handler.onData?.(...args) ?? true,
			onBodySent: (...args) => handler.onBodySent?.(...args),
			onComplete: (...args) => {
				try {
					handler.onComplete?.(...args)
				} finally {
					release()
				}
			},
			onError: (...args) => {
				try {
					handler.onError?.(...args)
				} finally {
					release()
				}
			},
			onUpgrade: (...args) => {
				try {
					handler.onUpgrade?.(...args)
				} finally {
					release()
				}
			},
		}
		try {
			return owned.dispatch(options, scopedHandler)
		} catch (error) {
			release()
			throw error
		}
	}
}

/** TLS opt-out is explicit, HTTPS-only and limited to the configured provider origin. */
export function createProviderFetch(options: ProviderFetchOptions = {}): typeof globalThis.fetch {
	const fetch = createOpenAiFetch(options.timeoutMs)
	if (options.allowInsecureTls !== true || !options.baseUrl) return fetch
	let origin: string
	try {
		const baseUrl = new URL(options.baseUrl)
		if (baseUrl.protocol !== "https:") return fetch
		origin = baseUrl.origin
	} catch {
		// Invalid/unconfigured URLs never broaden the opt-out to arbitrary hosts.
		return fetch
	}
	return (input, init) => {
		const dispatcher = (init as (RequestInit & { dispatcher?: Dispatcher }) | undefined)?.dispatcher
		// VS Code's own HTTPS patch retains OS/PAC/auth routing and per-request TLS.
		if (
			typeof (globalThis as typeof globalThis & { __vscodeOriginalFetch?: unknown }).__vscodeOriginalFetch ===
			"function"
		) {
			if (dispatcher || !isStockDirectAgent(getGlobalDispatcher())) {
				return Promise.reject(
					new Error(
						"Cannot ignore the provider certificate with a custom dispatcher in VS Code; the route was not bypassed.",
					),
				)
			}
			return createVsCodeProviderFetch(origin, options.timeoutMs)(input, init)
		}
		return fetch(input, {
			...init,
			dispatcher: new ProviderTlsDispatcher(dispatcher ?? getGlobalDispatcher(), origin),
		} as RequestInit)
	}
}
