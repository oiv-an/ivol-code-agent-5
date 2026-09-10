// kilocode_change - new file
import {
	claudeCodeModels,
	isPersonalProvider,
	normalizeClaudeCodeModelId,
	type ProviderConnectionTestResult,
	type ProviderSettings,
} from "@roo-code/types"

import { buildApiHandler } from "../../api"
import type { ApiStream } from "../../api/transform/stream"
import {
	buildReport,
	endpointDetails,
	inspectError,
	makeReportSanitizer,
	selectedModel,
	type ErrorFacts,
} from "./report"

const PROMPT = "Reply with IVOL_CONNECTION_OK only."
const MAX_OUTPUT_BYTES = 8 * 1024
const DEFAULT_TIMEOUT_MS = 60_000

class DiagnosticStop extends Error {
	constructor(readonly category: "timeout" | "cancelled") {
		super(category)
	}
}

function validEndpoint(config: ProviderSettings): boolean {
	try {
		const url = new URL(endpointDetails(config).endpoint)
		return url.protocol === "http:" || url.protocol === "https:"
	} catch {
		return false
	}
}

export async function runProviderConnectionTest(
	configuration: ProviderSettings,
	options: {
		requestId: string
		signal: AbortSignal
		extensionVersion: string
		vscodeVersion: string
		timeoutMs?: number
	},
): Promise<ProviderConnectionTestResult> {
	const started = Date.now()
	const startedAt = new Date(started).toISOString()
	const sanitize = makeReportSanitizer(configuration)
	const finish = (
		status: ProviderConnectionTestResult["status"],
		category: string,
		facts?: ErrorFacts,
	): ProviderConnectionTestResult => {
		const elapsedMs = Math.max(0, Date.now() - started)
		return {
			requestId: options.requestId,
			status,
			category,
			elapsedMs,
			report: buildReport({ ...options, configuration, startedAt, elapsedMs, status, category, facts, sanitize }),
		}
	}
	if (options.signal.aborted) return finish("cancelled", "cancelled")
	if (!isPersonalProvider(configuration.apiProvider)) return finish("error", "unsupported_provider")
	if (!selectedModel(configuration)?.trim()) return finish("error", "missing_model")
	if (!validEndpoint(configuration)) return finish("error", "invalid_endpoint")
	if (
		configuration.apiProvider === "openai" &&
		!configuration.openAiApiKey?.trim() &&
		!Object.entries(configuration.openAiHeaders ?? {}).some(
			([name, value]) => /^(?:authorization|api-key|x-api-key)$/i.test(name) && value.trim(),
		)
	)
		return finish("error", "missing_key")

	let snapshot: ProviderSettings
	try {
		snapshot = structuredClone(configuration)
	} catch {
		return finish("error", "invalid_configuration")
	}
	// Request-local changes only; keep transport, credentials, model, and reasoning settings intact.
	snapshot.openAiWebSearchEnabled = false
	snapshot.enableGrounding = false
	snapshot.enableUrlContext = false
	const controller = new AbortController()
	let iterator: ApiStream | undefined
	let finishedStream = false
	let stop: DiagnosticStop | undefined
	let rejectStop: (reason: DiagnosticStop) => void = () => undefined
	const interruption = new Promise<never>((_resolve, reject) => {
		rejectStop = reject
	})
	const interrupt = (category: "cancelled" | "timeout") => {
		if (stop) return
		stop = new DiagnosticStop(category)
		rejectStop(stop)
		controller.abort() // Never forward a caller-provided abort reason (it may contain private data).
	}
	const cancel = () => interrupt("cancelled")
	options.signal.addEventListener("abort", cancel, { once: true })
	const timeoutMs =
		typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
			? Math.max(1, Math.min(DEFAULT_TIMEOUT_MS, options.timeoutMs))
			: DEFAULT_TIMEOUT_MS
	const timer = setTimeout(() => interrupt("timeout"), timeoutMs)
	try {
		const generation = async (): Promise<string> => {
			if (options.signal.aborted) throw new DiagnosticStop("cancelled")
			const handler = buildApiHandler(snapshot, { connectionTest: true })
			const selected = selectedModel(snapshot)!
			const expected =
				snapshot.apiProvider === "claude-code" ? normalizeClaudeCodeModelId(selected.trim()) : selected
			if (
				handler.getModel().id !== expected ||
				(snapshot.apiProvider === "claude-code" && !Object.hasOwn(claudeCodeModels, expected))
			) {
				return "invalid_model"
			}
			iterator = handler.createMessage("", [{ role: "user", content: PROMPT }], {
				taskId: "provider-connection-test",
				signal: controller.signal,
				tools: [],
				tool_choice: "none",
				toolProtocol: snapshot.toolProtocol,
				allowedFunctionNames: [],
				parallelToolCalls: false,
				forceWebSearch: false,
				store: false,
				suppressPreviousResponseId: true,
			})
			let outputBytes = 0
			let nonemptyText = false
			let chunks = 0
			while (true) {
				if (stop) throw stop
				const item = await iterator.next()
				if (stop) throw stop
				if (item.done) {
					finishedStream = true
					return nonemptyText ? "success" : "empty_response"
				}
				const chunk = item.value
				if (chunk.type === "error") throw chunk
				if (chunk.type === "text" && chunk.text.trim()) nonemptyText = true
				// Count but never retain the contents, including reasoning and unexpected tool output.
				for (const [key, value] of Object.entries(chunk)) {
					if (key !== "type" && typeof value === "string") outputBytes += Buffer.byteLength(value, "utf8")
				}
				if (outputBytes >= MAX_OUTPUT_BYTES) return nonemptyText ? "output_limit_success" : "output_limit"
				// A rapidly yielding provider must not starve the timer or external cancellation.
				if (++chunks % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
			}
		}
		const category = await Promise.race([generation(), interruption])
		return finish(category === "success" || category === "output_limit_success" ? "success" : "error", category)
	} catch (error) {
		if (stop || error instanceof DiagnosticStop) {
			const category = stop?.category ?? (error as DiagnosticStop).category
			return finish(category === "cancelled" ? "cancelled" : "error", category)
		}
		const facts = inspectError(error, sanitize)
		return finish("error", facts.category, facts)
	} finally {
		clearTimeout(timer)
		options.signal.removeEventListener("abort", cancel)
		controller.abort()
		if (iterator && !finishedStream) {
			// Async generator return() queues behind pending next(); transport shutdown may still be delayed after abort.
			// Handle both synchronous throws and late rejection without logging the raw SDK error.
			try {
				void Promise.resolve(iterator.return(undefined)).catch(() => undefined)
			} catch {
				// Local cleanup is complete; upstream cleanup cannot be forced through this adapter interface.
			}
		}
	}
}
