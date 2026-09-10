// kilocode_change - new file: explicit web searches stay outside coding tasks and project storage.
import * as vscode from "vscode"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
	DEFAULT_OPENAI_WEB_SEARCH_MODEL_ID,
	providerSettingsSchema,
	type ExtensionMessage,
	type ProviderSettings,
	type StandaloneWebSearchErrorCode,
	type StandaloneWebSearchResult,
	type StandaloneWebSearchSaveResult,
	type StandaloneWebSearchUpdate,
	type WebviewMessage,
} from "@roo-code/types"
import { OpenAiCompatibleResponsesHandler } from "../../api/providers/openai-responses"

type Host = {
	getState: () => Promise<{ apiConfiguration: ProviderSettings }>
	postMessageToWebview: (message: ExtensionMessage) => Promise<unknown>
}
type Operation = {
	requestId: string
	controller: AbortController
	running: boolean
	saving: boolean
	result?: StandaloneWebSearchResult
}

const MAX_QUERY_CHARS = 8_000
const MAX_ANSWER_CHARS = 48_000
const MAX_SOURCES = 32
const DEADLINE_MS = 180_000
const operations = new WeakMap<Host, Operation>()
const validRequestId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id)

/** Never inspect arbitrary error getters, raw requests, headers, or nested provider payloads. */
function ownValue(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object") return undefined
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		return descriptor && "value" in descriptor ? descriptor.value : undefined
	} catch {
		return undefined // Uninspectable errors receive only the generic category.
	}
}

function errorCategory(error: unknown): StandaloneWebSearchErrorCode {
	const status = ownValue(error, "status")
	const code = ownValue(error, "code") ?? ownValue(ownValue(error, "cause"), "code")
	const message = ownValue(error, "message")
	if (status === 401 || status === 403) return "authentication"
	if (status === 429) return "rate_limit"
	if (typeof code === "string" && /^(ETIMEDOUT|UND_ERR_.*TIMEOUT|OPENAI_REQUEST_TIMEOUT)$/.test(code))
		return "timeout"
	if (typeof code === "string" && /^(E(CONNRESET|CONNREFUSED|NOTFOUND|AI_AGAIN|PIPE)|UND_ERR_SOCKET)$/.test(code)) {
		return "connection"
	}
	// Match only fixed adapter prefixes; the raw message is never returned or logged.
	if (typeof message === "string") {
		if (/^(Authentication failed\.|Access denied\.)/.test(message)) return "authentication"
		if (message.startsWith("Rate limit exceeded.")) return "rate_limit"
		if (message.startsWith("Responses API web search timed out")) return "timeout"
		if (message.startsWith("Failed to connect to Responses API:")) return "connection"
		if (/^Responses API (web search returned no answer|returned no text or function call)/.test(message)) {
			return "empty_response"
		}
	}
	return "provider"
}

async function send(host: Host, operation: Operation, message: ExtensionMessage): Promise<void> {
	if (operations.get(host) !== operation) return
	try {
		await host.postMessageToWebview(message)
	} catch {
		// A closed webview cannot receive the result. Release its private search state.
		if (operations.get(host) === operation) disposeStandaloneWebSearch(host)
	}
}

async function update(host: Host, operation: Operation, payload: StandaloneWebSearchUpdate): Promise<void> {
	await send(host, operation, { type: "standaloneWebSearchUpdate", standaloneWebSearchUpdate: payload })
}

/** A deadline covers configuration loading and transport, even if an adapter ignores cancellation. */
async function abortable<T>(operation: Operation, action: () => Promise<T>): Promise<T> {
	const signal = operation.controller.signal
	if (signal.aborted) throw new Error("cancelled")
	let onAbort: () => void = () => undefined
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new Error("cancelled"))
		signal.addEventListener("abort", onAbort, { once: true })
	})
	try {
		return await Promise.race([action(), aborted])
	} finally {
		signal.removeEventListener("abort", onAbort)
	}
}

function safeSources(raw: Array<{ url: string; title: string }>): Array<{ url: string; title: string }> {
	const sources = new Map<string, { url: string; title: string }>()
	for (const source of raw) {
		if (sources.size >= MAX_SOURCES) break
		if (typeof source?.url !== "string" || source.url.length > 2_048) continue
		try {
			const url = new URL(source.url)
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue
			const href = url.href
			if (href.length > 2_048) continue
			if (!sources.has(href)) {
				sources.set(href, {
					url: href,
					title: typeof source.title === "string" ? source.title.slice(0, 512) : href,
				})
			}
		} catch {
			continue // Invalid provider links never become clickable or enter the saved report.
		}
	}
	return [...sources.values()]
}

/** Cancel/close clears the cached answer too; a delayed cancel cannot affect a later request. */
export function cancelStandaloneWebSearch(host: Host, requestId: string | undefined): void {
	const operation = operations.get(host)
	if (!operation || operation.requestId !== requestId) return
	operation.result = undefined
	operation.controller.abort()
	if (!operation.running) void update(host, operation, { requestId: operation.requestId, status: "cancelled" })
}

export function disposeStandaloneWebSearch(host: Host): void {
	const operation = operations.get(host)
	operations.delete(host)
	operation?.controller.abort()
}

export async function handleStandaloneWebSearch(host: Host, message: WebviewMessage): Promise<void> {
	if (!validRequestId(message.requestId)) return
	const previous = operations.get(host)
	if (previous?.requestId === message.requestId) return
	previous?.controller.abort()
	const operation: Operation = {
		requestId: message.requestId,
		controller: new AbortController(),
		running: true,
		saving: false,
	}
	operations.set(host, operation)
	const query = typeof message.text === "string" ? message.text.trim() : ""
	let timedOut = false
	let providerStarted = false
	const timer = setTimeout(() => {
		timedOut = true
		operation.controller.abort()
	}, DEADLINE_MS)
	try {
		const fail = async (errorCode: StandaloneWebSearchErrorCode) =>
			update(host, operation, { requestId: operation.requestId, status: "error", errorCode })
		if (!query) return await fail("invalid_query")
		if ((message.text?.length ?? 0) > MAX_QUERY_CHARS) return await fail("query_too_long")
		await update(host, operation, { requestId: operation.requestId, status: "running" })
		const state = await abortable(operation, () => host.getState())
		const parsed = providerSettingsSchema.safeParse(state.apiConfiguration)
		if (!parsed.success) return await fail("invalid_configuration")
		if (parsed.data.apiProvider !== "openai") return await fail("unsupported_provider")
		if (!parsed.data.openAiApiKey?.trim()) return await fail("invalid_configuration")
		if (parsed.data.openAiBaseUrl) {
			try {
				if (!["http:", "https:"].includes(new URL(parsed.data.openAiBaseUrl).protocol)) {
					return await fail("invalid_configuration")
				}
			} catch {
				return await fail("invalid_configuration")
			}
		}
		// Zod clones the saved profile. Search options never leak into the active task/profile.
		const configuration = { ...parsed.data, openAiWebSearchEnabled: true }
		const handler = new OpenAiCompatibleResponsesHandler(configuration)
		providerStarted = true
		const response = await abortable(operation, () =>
			handler.searchWeb(query, `standalone-web-search-${operation.requestId}`, operation.controller.signal, {
				maxTextChars: MAX_ANSWER_CHARS,
				maxSources: MAX_SOURCES,
			}),
		)
		if (operations.get(host) !== operation || operation.controller.signal.aborted) return
		if (typeof response.text !== "string" || !response.text.trim()) return await fail("empty_response")
		const rawSources = Array.isArray(response.sources) ? response.sources : []
		const sources = safeSources(rawSources)
		operation.result = {
			requestId: operation.requestId,
			query,
			answer: response.text.slice(0, MAX_ANSWER_CHARS).trim(),
			sources,
			model: (configuration.openAiWebSearchModelId?.trim() || DEFAULT_OPENAI_WEB_SEARCH_MODEL_ID).slice(0, 256),
			createdAt: new Date().toISOString(),
			truncated:
				response.truncated === true ||
				response.text.length > MAX_ANSWER_CHARS ||
				rawSources.length > MAX_SOURCES,
		}
		await update(host, operation, { requestId: operation.requestId, status: "success", result: operation.result })
	} catch (error) {
		await update(host, operation, {
			requestId: operation.requestId,
			status: operation.controller.signal.aborted && !timedOut ? "cancelled" : "error",
			...(timedOut
				? { errorCode: "timeout" as const }
				: operation.controller.signal.aborted
					? {}
					: { errorCode: providerStarted ? errorCategory(error) : "internal" }),
		})
	} finally {
		clearTimeout(timer)
		operation.running = false
	}
}

function toMarkdown(result: StandaloneWebSearchResult): string {
	const quote = (text: string) =>
		text
			.split(/\r?\n/)
			.map((line) => `> ${line}`)
			.join("\n")
	return [
		"# IVOL Code — Web search",
		"",
		`${result.createdAt} · ${result.model}`,
		"",
		quote(result.query),
		"",
		result.answer,
		"",
		...result.sources.flatMap((source) => [source.title.replace(/[\r\n]/g, " "), source.url, ""]),
		...(result.truncated ? ["[Result truncated to the search dialog limit.]", ""] : []),
	].join("\n")
}

/** Only the backend's last result can be saved. No arbitrary path or content is accepted from the UI. */
export async function saveStandaloneWebSearch(host: Host, requestId: string | undefined): Promise<void> {
	if (!validRequestId(requestId)) return
	const operation = operations.get(host)
	if (!operation || operation.requestId !== requestId || operation.saving) return
	const notify = (payload: StandaloneWebSearchSaveResult) =>
		send(host, operation, { type: "standaloneWebSearchSaveResult", standaloneWebSearchSaveResult: payload })
	const result = operation.result
	if (!result) return await notify({ requestId, status: "error", errorCode: "missing_result" })
	operation.saving = true
	try {
		const uri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(
				path.join(os.homedir(), "Downloads", `IVOL-web-search-${result.createdAt.replace(/[:.]/g, "-")}.md`),
			),
			filters: { Markdown: ["md"] },
		})
		// Cancel, close, replacement and disposal revoke a pending save before it can touch disk.
		if (operations.get(host) !== operation || operation.result !== result || operation.controller.signal.aborted)
			return
		if (!uri) return await notify({ requestId, status: "cancelled" })
		if (uri.scheme !== "file")
			return await notify({ requestId, status: "error", errorCode: "unsupported_location" })
		await fs.writeFile(uri.fsPath, toMarkdown(result), { encoding: "utf8", flag: "wx" })
		await notify({ requestId, status: "saved" })
	} catch (error) {
		await notify({
			requestId,
			status: "error",
			errorCode: ownValue(error, "code") === "EEXIST" ? "file_exists" : "save_failed",
		})
	} finally {
		operation.saving = false
	}
}
