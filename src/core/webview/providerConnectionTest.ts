// kilocode_change - new file: settings diagnostics never mutate an active Task or stored profile.
import * as vscode from "vscode"
import {
	providerSettingsSchema,
	type ExtensionMessage,
	type WebviewMessage,
	type ProviderConnectionTestResult,
} from "@roo-code/types"
import { Package } from "../../shared/package"
import { runProviderConnectionTest } from "../../services/provider-diagnostics"

type Host = { postMessageToWebview: (message: ExtensionMessage) => Promise<unknown> }
type Operation = { requestId: string; controller: AbortController }
const operations = new WeakMap<Host, Operation>()
const reports = new WeakMap<Host, ProviderConnectionTestResult>()
const validRequestId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id)

async function deliverResult(host: Host, message: ExtensionMessage): Promise<void> {
	if (message.providerConnectionTestResult) reports.set(host, message.providerConnectionTestResult)
	try {
		await host.postMessageToWebview(message)
	} catch {
		// A disposed/restarted webview cannot receive a report. Do not retry delivery or log its raw error.
		return
	}
}

/** Only copy the last sanitized report generated for this view, never arbitrary webview text. */
export async function copyProviderConnectionReport(host: Host, requestId: string | undefined): Promise<void> {
	if (!validRequestId(requestId)) return
	const report = reports.get(host)
	let success = false
	if (report?.requestId === requestId) {
		try {
			await vscode.env.clipboard.writeText(report.report)
			success = true
		} catch {
			// Report failure without exposing clipboard contents or platform exception details.
			success = false
		}
	}
	await deliverResult(host, {
		type: "providerConnectionReportCopyResult",
		providerConnectionReportCopyResult: { requestId, success },
	})
}

/** A delayed cancel from a previous form must not cancel the current form's check. */
export function cancelProviderConnectionTest(host: Host, requestId: string | undefined): void {
	const operation = operations.get(host)
	if (operation && operation.requestId === requestId) operation.controller.abort()
}

/** Dispose only the request owned by this view, not requests or tasks from another window. */
export function disposeProviderConnectionTest(host: Host): void {
	const operation = operations.get(host)
	operations.delete(host)
	reports.delete(host)
	operation?.controller.abort()
}

export async function handleProviderConnectionTest(host: Host, message: WebviewMessage): Promise<void> {
	if (!validRequestId(message.requestId)) return
	const previous = operations.get(host)
	if (previous?.requestId === message.requestId) return
	previous?.controller.abort()
	reports.delete(host)
	const operation: Operation = { requestId: message.requestId, controller: new AbortController() }
	operations.set(host, operation)
	const start = Date.now()
	try {
		const parsed = providerSettingsSchema.safeParse(message.apiConfiguration)
		const result = parsed.success
			? await runProviderConnectionTest(parsed.data, {
					requestId: operation.requestId,
					signal: operation.controller.signal,
					extensionVersion: Package.version,
					vscodeVersion: vscode.version,
				})
			: {
					requestId: operation.requestId,
					status: "error" as const,
					category: "configuration",
					report: "IVOL provider connection check: invalid settings draft. No request was sent. Check the fields and try again.",
					elapsedMs: Date.now() - start,
				}
		if (operations.get(host) === operation) {
			await deliverResult(host, {
				type: "providerConnectionTestResult",
				providerConnectionTestResult: result,
			})
		}
	} catch {
		// Never expose an unexpected raw exception: SDK objects may contain credentials or request headers.
		if (operations.get(host) === operation) {
			await deliverResult(host, {
				type: "providerConnectionTestResult",
				providerConnectionTestResult: {
					requestId: operation.requestId,
					status: operation.controller.signal.aborted ? "cancelled" : "error",
					category: operation.controller.signal.aborted ? "cancelled" : "internal",
					report: "IVOL provider connection check could not finish. No task history or profile was changed.",
					elapsedMs: Date.now() - start,
				},
			})
		}
	} finally {
		if (operations.get(host) === operation) operations.delete(host)
	}
}
