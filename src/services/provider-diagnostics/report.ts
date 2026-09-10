// kilocode_change - new file
import * as os from "os"

import type { ProviderConnectionTestResult, ProviderSettings } from "@roo-code/types"

const REDACTED = "[redacted]"
const MAX_REPORT_BYTES = 8 * 1024
const SAFE_PATH_PARTS = new Set(["v1", "v2", "api", "openai", "chat", "completions", "responses", "messages"])

/** Read data properties only: an SDK error can contain cycles, getters, or raw requests. */
function ownValue(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object") return undefined
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		return descriptor && "value" in descriptor ? descriptor.value : undefined
	} catch {
		return undefined // Uninspectable objects contribute no diagnostic details.
	}
}

function stringsIn(value: unknown, output: string[], seen = new Set<unknown>(), depth = 0): void {
	if (typeof value === "string") {
		if (value) output.push(value)
		return
	}
	if (!value || typeof value !== "object" || seen.has(value) || depth > 8) return
	seen.add(value)
	for (const key of Object.keys(value)) stringsIn(ownValue(value, key), output, seen, depth + 1)
}

export function makeReportSanitizer(configuration: ProviderSettings): (value: string, limit?: number) => string {
	const secrets: string[] = []
	for (const key of Object.keys(configuration)) {
		const value = ownValue(configuration, key)
		// Header names are arbitrary. Every value is sensitive, even when its name looks harmless.
		if (/key|token|secret|password|authorization|cookie|headers|account|email|hostheader/i.test(key)) {
			stringsIn(value, secrets)
		}
		if (/url/i.test(key) && typeof value === "string") {
			try {
				const url = new URL(value)
				secrets.push(url.username, url.password, ...url.searchParams.values(), url.hash.slice(1))
				for (const part of url.pathname.split("/")) {
					if (part && !SAFE_PATH_PARTS.has(part)) secrets.push(part)
				}
			} catch {
				secrets.push(value) // Never echo malformed endpoints.
			}
		}
	}
	const variants = new Set<string>()
	for (const secret of secrets) {
		if (!secret) continue
		variants.add(secret)
		try {
			variants.add(encodeURIComponent(secret))
		} catch {
			// A lone surrogate cannot be URI-encoded; the original secret is still redacted.
		}
		try {
			variants.add(decodeURIComponent(secret))
		} catch {
			// The original value and its encoded variant already cover malformed percent encoding.
		}
		const bearer = secret.match(/^(?:Bearer|Basic)\s+(.+)$/i)
		if (bearer) variants.add(bearer[1])
	}
	const orderedSecrets = [...variants].filter(Boolean).sort((a, b) => b.length - a.length)
	return (value, limit = 256) => {
		let sanitized = value
		for (const secret of orderedSecrets) sanitized = sanitized.split(secret).join(REDACTED)
		// Only allowlisted scalar values use this function; arbitrary provider messages never reach the report.
		sanitized = sanitized
			.replace(/\bhttps?:\/\/[^\s]+/gi, (value) => {
				try {
					return new URL(value).origin
				} catch {
					return REDACTED
				}
			})
			.replace(/(?:Bearer|Basic)\s+[^\s,;]+/gi, REDACTED)
			.replace(/\b(?:sk-|sess-|oauth_)[A-Za-z0-9_\-.]+/g, REDACTED)
			.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, REDACTED)
			.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED)
			// UNC/device paths may contain spaces; omit the rest of this scalar, not only its first word.
			.replace(/(?:\\\\|\\\?\?\\)[^\r\n]*/g, REDACTED)
			.replace(/(?:file:\/\/[^\s]*|\b[A-Za-z]:[\\/][^\s]*|(?:^|\s)(?:\/|~\/|\.\.?[\\/])[^\s]*)/g, REDACTED)
			.split("")
			.map((character) => {
				const code = character.charCodeAt(0)
				return code <= 31 ||
					(code >= 127 && code <= 159) ||
					(code >= 0x202a && code <= 0x202e) ||
					(code >= 0x2066 && code <= 0x2069)
					? " "
					: character
			})
			.join("")
		return sanitized.length > limit ? `${sanitized.slice(0, limit)} [truncated]` : sanitized
	}
}

const NETWORK_CODES = new Set([
	"ENOTFOUND",
	"EAI_AGAIN",
	"ECONNREFUSED",
	"ECONNRESET",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"EPIPE",
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_SOCKET",
	"OPENAI_CONNECTION_ERROR",
	"OPENAI_REQUEST_TIMEOUT",
	"OPENAI_STREAM_TERMINATED",
	"ERR_NETWORK",
	"CERT_HAS_EXPIRED",
	"CERT_NOT_YET_VALID",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"ERR_SSL_WRONG_VERSION_NUMBER",
	"ERR_TLS_HANDSHAKE_TIMEOUT",
	"ABORT_ERR",
	"ERR_CANCELED",
])
const PROVIDER_CODES = new Set([
	"invalid_api_key",
	"invalid_request_error",
	"authentication_error",
	"permission_denied",
	"permission_error",
	"insufficient_quota",
	"rate_limit_exceeded",
	"rate_limit_error",
	"model_not_found",
	"not_found_error",
	"context_length_exceeded",
	"unsupported_parameter",
	"server_error",
	"internal_server_error",
	"overloaded_error",
])

export interface ErrorFacts {
	status?: number
	code?: string
	requestId?: string
	category: string
}

export function inspectError(error: unknown, sanitize: (value: string, limit?: number) => string): ErrorFacts {
	const queue: unknown[] = [error]
	const seen = new Set<unknown>()
	const facts: ErrorFacts = { category: "provider_error" }
	const messages: string[] = []
	const codes: string[] = []
	while (queue.length && seen.size < 24) {
		const current = queue.shift()
		if (typeof current === "string") {
			messages.push(current.slice(0, 16_384)) // Used for classification only; never included in output.
			continue
		}
		if (!current || typeof current !== "object" || seen.has(current)) continue
		seen.add(current)
		for (const key of ["status", "statusCode"]) {
			const status = ownValue(current, key)
			if (
				facts.status === undefined &&
				typeof status === "number" &&
				Number.isInteger(status) &&
				status >= 100 &&
				status <= 599
			) {
				facts.status = status
			}
		}
		for (const key of ["code", "type", "name"]) {
			const code = ownValue(current, key)
			if (typeof code === "string" && (NETWORK_CODES.has(code) || PROVIDER_CODES.has(code))) {
				codes.push(code)
				if (!facts.code && sanitize(code) === code) facts.code = code
			}
		}
		for (const key of ["request_id", "requestId", "requestID", "_request_id"]) {
			const id = ownValue(current, key)
			if (typeof id === "string" && /^[A-Za-z0-9_.:-]{6,128}$/.test(id) && sanitize(id) === id) {
				facts.requestId ??= id
			}
		}
		const headers = ownValue(current, "headers")
		for (const key of ["x-request-id", "request-id", "cf-ray"]) {
			const id = ownValue(headers, key)
			if (typeof id === "string" && /^[A-Za-z0-9_.:-]{6,128}$/.test(id) && sanitize(id) === id)
				facts.requestId ??= id
		}
		const message = ownValue(current, "message")
		if (typeof message === "string") messages.push(message.slice(0, 16_384))
		// Do not walk request/config/header objects, stack traces, or arbitrary response fields.
		for (const key of ["cause", "error", "response", "data"]) {
			const child = ownValue(current, key)
			if (child !== undefined) queue.push(child)
		}
	}
	const evidence = `${codes.join(" ")} ${messages.join(" ")}`
	if (facts.status === 401) facts.category = "authentication"
	else if (facts.status === 403) facts.category = "permission"
	else if (facts.status === 404) facts.category = "not_found"
	else if (facts.status === 429) facts.category = "rate_limit"
	else if (facts.status !== undefined && facts.status >= 500) facts.category = "server_error"
	else if (facts.status !== undefined && facts.status >= 400) facts.category = "request_error"
	else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|name resolution|resolve host/i.test(evidence)) facts.category = "dns"
	else if (
		/CERT_|SELF_SIGNED_CERT|ISSUER_CERT|ERR_TLS|ERR_SSL|certificate|TLS handshake|SSL handshake/i.test(evidence)
	)
		facts.category = "tls"
	else if (/TIMEOUT|ETIMEDOUT|timed? ?out/i.test(evidence)) facts.category = "timeout"
	else if (
		/ECONN|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_SOCKET|OPENAI_CONNECTION_ERROR|OPENAI_STREAM_TERMINATED|ERR_NETWORK|connection error|fetch failed|socket hang up/i.test(
			evidence,
		)
	)
		facts.category = "connection"
	else if (/invalid_api_key|authentication_error|not authenticated|unauthorized|invalid (?:api )?key/i.test(evidence))
		facts.category = "authentication"
	else if (/permission_denied|permission_error/i.test(evidence)) facts.category = "permission"
	else if (/model_not_found|not_found_error|model .{0,160}not found/i.test(evidence)) facts.category = "not_found"
	else if (/rate_limit|insufficient_quota/i.test(evidence)) facts.category = "rate_limit"
	return facts
}

const EXPLANATIONS: Record<string, string> = {
	success: "Nonempty model output was received. The minimal generation request completed.",
	output_limit_success:
		"Nonempty model output was received. Reading stopped at the local 8 KiB limit; full stream completion was not verified.",
	output_limit:
		"The local 8 KiB limit was reached without nonempty final text. Generation success was not established.",
	empty_response:
		"The stream ended without nonempty final text. Usage, reasoning, and tool calls alone do not confirm a working text response.",
	unsupported_provider:
		"This provider is not supported by the personal build's connection check. No request was sent.",
	missing_model: "Choose a model in this profile before testing. No default model or other profile was substituted.",
	missing_key:
		"This OpenAI-compatible profile has no API key or authentication header. Enter its credentials before testing.",
	invalid_endpoint: "The configured endpoint is not a valid HTTP(S) URL. No request was sent.",
	invalid_model:
		"The adapter would substitute or reject the selected model. Choose a supported model; no generation request was sent.",
	invalid_configuration: "The profile could not be copied safely. No request was sent.",
	cancelled:
		"The connection check was cancelled locally. The provider may continue processing if its adapter does not support request cancellation.",
	authentication:
		"Authentication was rejected or unavailable. Check this profile's key or existing provider sign-in; no other profile was tried.",
	permission:
		"Access was refused. Check the account/model permissions and the provider's access policy; this does not identify the network cause.",
	not_found:
		"The requested route or model was not found. Check the endpoint, API protocol, and exact model ID with the provider.",
	rate_limit:
		"The provider reported a usage, quota, or rate limit. Check its limits and account status before retrying.",
	server_error:
		"The provider or an intermediary returned a server error. Give support the recorded status and request ID when available.",
	request_error:
		"The provider rejected the request. Check the selected model, protocol, and profile options with support.",
	dns: "The error indicates a hostname lookup failure. Check the configured host and DNS connectivity; the check does not detect VPN usage.",
	tls: "The error indicates a TLS/certificate or handshake failure. Ask the provider to check the certificate chain and endpoint.",
	connection:
		"The connection could not be established or was interrupted. The error alone does not identify which network component caused it.",
	timeout:
		"The check timed out before a complete text response was confirmed. A slow model, provider, or connection can cause this; the cause is not established.",
	provider_error:
		"The provider adapter failed without a more specific safe diagnostic. Raw error bodies are omitted to protect credentials and account data.",
}

export function selectedModel(config: ProviderSettings): string | undefined {
	switch (config.apiProvider) {
		case "openai":
			return config.openAiModelId
		case "ollama":
			return config.ollamaModelId
		case "lmstudio":
			return config.lmStudioModelId
		case "openai-codex":
		case "claude-code":
			return config.apiModelId
		default:
			return undefined
	}
}

export function endpointDetails(config: ProviderSettings): { endpoint: string; protocol: string } {
	switch (config.apiProvider) {
		case "openai":
			return {
				endpoint: config.openAiBaseUrl ?? "https://api.openai.com/v1",
				protocol: config.openAiUseAzure
					? "OpenAI Chat Completions (Azure option enabled)"
					: "OpenAI Chat Completions",
			}
		case "openai-codex":
			return { endpoint: "https://chatgpt.com/backend-api/codex", protocol: "OpenAI Codex Responses (OAuth)" }
		case "claude-code":
			return {
				endpoint: "https://api.anthropic.com/v1/messages",
				protocol: "Anthropic Messages (Claude Code OAuth)",
			}
		case "ollama":
			return { endpoint: config.ollamaBaseUrl || "http://localhost:11434", protocol: "Ollama Chat" }
		case "lmstudio":
			return {
				endpoint: `${config.lmStudioBaseUrl || "http://localhost:1234"}/v1`,
				protocol: "OpenAI Chat Completions (LM Studio)",
			}
		default:
			return { endpoint: "", protocol: "unsupported" }
	}
}

export function buildReport(args: {
	configuration: ProviderSettings
	requestId: string
	extensionVersion: string
	vscodeVersion: string
	startedAt: string
	elapsedMs: number
	status: ProviderConnectionTestResult["status"]
	category: string
	facts?: ErrorFacts
	sanitize: (value: string, limit?: number) => string
}): string {
	const { configuration, sanitize, facts } = args
	const details = endpointDetails(configuration)
	let endpoint = "unavailable"
	try {
		const url = new URL(details.endpoint)
		if (url.protocol === "http:" || url.protocol === "https:") {
			endpoint = `${sanitize(url.origin, 300)}${url.pathname !== "/" ? "/[path omitted]" : ""}${url.search ? "?[query omitted]" : ""}`
		}
	} catch {
		endpoint = "invalid or unavailable"
	}
	const lines = [
		"IVOL provider connection diagnostic",
		`Date (UTC): ${args.startedAt}`,
		`Extension: ${sanitize(args.extensionVersion, 80)}`,
		`VS Code: ${sanitize(args.vscodeVersion, 80)}`,
		`OS/runtime: ${sanitize(`${os.platform()} ${os.release()} ${os.arch()}; Node ${process.versions.node}`, 180)}`,
		`Check ID: ${sanitize(args.requestId, 128)}`,
		`Provider: ${sanitize(configuration.apiProvider ?? "unselected", 80)}`,
		`Model: ${sanitize(selectedModel(configuration) ?? "unselected")}`,
		`Endpoint: ${endpoint}`,
		`Protocol: ${details.protocol}`,
		`Profile allowInsecureTls: ${configuration.allowInsecureTls === true}`,
		`Elapsed: ${args.elapsedMs} ms`,
		`Result: ${args.status}; category: ${args.category}`,
		`HTTP status: ${facts?.status ?? "unavailable (adapter did not expose it)"}`,
		`Error code: ${facts?.code ?? "unavailable"}`,
		`Provider request ID: ${facts?.requestId ?? "unavailable"}`,
		EXPLANATIONS[args.category] ?? EXPLANATIONS.provider_error,
		"Scope: one fixed text prompt; no task history, workspace content, or tools. Web search is disabled for this check only. This does not verify a full task or web search.",
		"Cancellation: the local wait is bounded. Upstream cancellation is requested where the adapter supports it and is not confirmed by this report.",
		"Privacy: model text, raw errors, headers, credentials, URL userinfo/path/query, and account data are omitted.",
	]
	const report = lines.join("\n")
	return Buffer.byteLength(report, "utf8") <= MAX_REPORT_BYTES
		? report
		: `${Buffer.from(report, "utf8")
				.subarray(0, MAX_REPORT_BYTES - 40)
				.toString("utf8")}\n[report truncated]`
}
