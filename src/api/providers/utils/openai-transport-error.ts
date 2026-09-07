// kilocode_change - new file
import OpenAI from "openai"

const TRANSPORT_CODES = new Set([
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET",
	"ECONNRESET",
	"ECONNREFUSED",
	"EPIPE",
	"ETIMEDOUT",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"EAI_AGAIN",
	"ENOTFOUND",
	"OPENAI_CONNECTION_ERROR",
	"OPENAI_REQUEST_TIMEOUT",
	"OPENAI_STREAM_TERMINATED",
])

type ErrorDetails = { name?: unknown; message?: unknown; code?: unknown; status?: unknown; cause?: unknown }

function errorChain(error: unknown): ErrorDetails[] {
	const chain: ErrorDetails[] = []
	const seen = new Set<unknown>()
	while (error && typeof error === "object" && !seen.has(error) && chain.length < 8) {
		seen.add(error)
		chain.push(error)
		error = (error as ErrorDetails).cause
	}
	return chain
}

function errorKind(error: ErrorDetails): string | undefined {
	return error.constructor?.name === "Error" || error.constructor?.name === "Object"
		? typeof error.name === "string"
			? error.name
			: undefined
		: error.constructor?.name
}

function isSdkError(
	error: ErrorDetails,
	kind: "APIUserAbortError" | "APIConnectionError" | "APIConnectionTimeoutError",
): boolean {
	// Production bundles minify class names; the SDK's public static constructor
	// properties are stable. The guard also supports partial SDK test doubles.
	const constructor = OpenAI[kind]
	return typeof constructor === "function" && error instanceof constructor
}

/** User cancellation is never a retryable provider/network failure. */
export function isOpenAiAbortError(error: unknown): boolean {
	return errorChain(error).some(
		(item) =>
			item.name === "AbortError" ||
			isSdkError(item, "APIUserAbortError") ||
			errorKind(item) === "APIUserAbortError" ||
			item.code === "ABORT_ERR" ||
			item.code === "ERR_CANCELED",
	)
}

function transportCode(error: unknown): string | undefined {
	if (isOpenAiAbortError(error)) return undefined
	const chain = errorChain(error)
	// HTTP error payloads have their own policy, even if a provider copied a code.
	if (typeof chain[0]?.status === "number") return undefined
	for (const item of chain) {
		if (typeof item.code === "string" && TRANSPORT_CODES.has(item.code)) return item.code
	}
	if (
		chain.some(
			(item) => isSdkError(item, "APIConnectionTimeoutError") || errorKind(item) === "APIConnectionTimeoutError",
		)
	) {
		return "OPENAI_REQUEST_TIMEOUT"
	}
	if (chain.some((item) => isSdkError(item, "APIConnectionError") || errorKind(item) === "APIConnectionError")) {
		return "OPENAI_CONNECTION_ERROR"
	}
	if (chain.some((item) => errorKind(item) === "TypeError" && item.message === "terminated")) {
		return "OPENAI_STREAM_TERMINATED"
	}
	return undefined
}

/** Stable, provider-branded error containing no request, response or raw cause. */
export class OpenAiTransportError extends Error {
	readonly provider = "openai"
	readonly code: string
	override readonly cause: { code: string }

	constructor(code: string) {
		const safeCode = TRANSPORT_CODES.has(code) ? code : "OPENAI_CONNECTION_ERROR"
		const timedOut = safeCode.includes("TIMEOUT") || safeCode === "ETIMEDOUT"
		super(
			timedOut
				? `OpenAI connection timed out while waiting for response data (${safeCode}).`
				: `OpenAI response connection was interrupted (${safeCode}).`,
		)
		this.name = "OpenAiTransportError"
		this.code = safeCode
		this.cause = { code: safeCode }
	}
}

export function isOpenAiTransportError(error: unknown): boolean {
	return transportCode(error) !== undefined
}

/** Return undefined for ordinary API errors so their existing handler stays unchanged. */
export function normalizeOpenAiTransportError(error: unknown): OpenAiTransportError | undefined {
	const code = transportCode(error)
	return code ? new OpenAiTransportError(code) : undefined
}
