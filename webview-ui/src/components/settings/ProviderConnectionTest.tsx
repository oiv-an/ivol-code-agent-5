// kilocode_change - new file
import { useCallback, useEffect, useRef, useState } from "react"

import type { ProviderSettings } from "@roo-code/types"
import type { ExtensionMessage } from "@roo/ExtensionMessage"

import { Button } from "@src/components/ui/button"
import { Textarea } from "@src/components/ui/textarea"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"

type ConnectionTestResult = NonNullable<ExtensionMessage["providerConnectionTestResult"]>

interface PendingTest {
	requestId: string
	configurationKey: string
	startedAt: number
	timeout?: ReturnType<typeof setTimeout>
}

interface ProviderConnectionTestProps {
	apiConfiguration: ProviderSettings
	currentApiConfigName?: string
}

// The host normally finishes first; this also bounds waits after a host restart or a lost response.
const UI_TIMEOUT_MS = 65_000
let requestCounter = 0

export const ProviderConnectionTest = ({ apiConfiguration, currentApiConfigName }: ProviderConnectionTestProps) => {
	const { t } = useAppTranslation()
	// Keep the comparison in memory only. Never expose draft credentials in the DOM or a diagnostic report.
	const configurationKey = JSON.stringify([currentApiConfigName, apiConfiguration])
	const latestConfigurationKey = useRef(configurationKey)
	latestConfigurationKey.current = configurationKey
	const pendingTest = useRef<PendingTest | null>(null)
	const [pendingConfigurationKey, setPendingConfigurationKey] = useState<string | null>(null)
	const [completedTest, setCompletedTest] = useState<{
		configurationKey: string
		result: ConnectionTestResult
	} | null>(null)
	const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle")
	const result = completedTest?.configurationKey === configurationKey ? completedTest.result : undefined
	const latestResult = useRef(result)
	latestResult.current = result
	const pendingCopy = useRef<ConnectionTestResult | null>(null)
	const isRunning = pendingConfigurationKey === configurationKey

	const clearPendingTest = useCallback(() => {
		const pending = pendingTest.current
		pendingTest.current = null
		if (pending?.timeout) clearTimeout(pending.timeout)
		return pending
	}, [])

	useEffect(() => {
		setPendingConfigurationKey(null)
		setCompletedTest(null)
		setCopyStatus("idle")
		pendingCopy.current = null
		return () => {
			const pending = clearPendingTest()
			if (pending) {
				vscode.postMessage({ type: "cancelProviderConnectionTest", requestId: pending.requestId })
			}
		}
	}, [configurationKey, clearPendingTest])

	useEffect(() => {
		const onMessage = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data
			if (message?.type === "providerConnectionReportCopyResult") {
				const reply = message.providerConnectionReportCopyResult
				const pending = pendingCopy.current
				if (reply && pending && reply.requestId === pending.requestId && latestResult.current === pending) {
					pendingCopy.current = null
					setCopyStatus(reply.success ? "copied" : "error")
				}
				return
			}
			if (message?.type !== "providerConnectionTestResult") return
			const incoming = message.providerConnectionTestResult
			const pending = pendingTest.current
			if (
				!incoming ||
				!pending ||
				incoming.requestId !== pending.requestId ||
				pending.configurationKey !== latestConfigurationKey.current ||
				!["success", "error", "cancelled"].includes(incoming.status) ||
				typeof incoming.report !== "string"
			) {
				return
			}
			clearPendingTest()
			setPendingConfigurationKey(null)
			setCompletedTest({ configurationKey: pending.configurationKey, result: incoming })
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [clearPendingTest])

	const startTest = () => {
		// Guard synchronously: two clicks can arrive before React disables the button.
		if (pendingTest.current) return
		const requestId = globalThis.crypto?.randomUUID?.() ?? `provider-test-${Date.now()}-${++requestCounter}`
		const pending: PendingTest = { requestId, configurationKey, startedAt: Date.now() }
		pendingTest.current = pending
		setPendingConfigurationKey(configurationKey)
		setCompletedTest(null)
		setCopyStatus("idle")
		pending.timeout = setTimeout(() => {
			if (pendingTest.current !== pending || latestConfigurationKey.current !== configurationKey) return
			clearPendingTest()
			setPendingConfigurationKey(null)
			setCompletedTest({
				configurationKey,
				result: {
					requestId,
					status: "error",
					category: "host_timeout",
					report: t("settings:providers.connectionTest.timeoutReport", { requestId }),
					elapsedMs: Date.now() - pending.startedAt,
				},
			})
			vscode.postMessage({ type: "cancelProviderConnectionTest", requestId })
		}, UI_TIMEOUT_MS)
		try {
			vscode.postMessage({ type: "testProviderConnection", requestId, apiConfiguration })
		} catch {
			clearPendingTest()
			setPendingConfigurationKey(null)
			setCompletedTest({
				configurationKey,
				result: {
					requestId,
					status: "error",
					category: "host_unavailable",
					report: t("settings:providers.connectionTest.unavailableReport", { requestId }),
					elapsedMs: Date.now() - pending.startedAt,
				},
			})
		}
	}

	const cancelTest = () => {
		const pending = clearPendingTest()
		if (!pending) return
		setPendingConfigurationKey(null)
		setCompletedTest({
			configurationKey: pending.configurationKey,
			result: {
				requestId: pending.requestId,
				status: "cancelled",
				category: "cancelled",
				report: t("settings:providers.connectionTest.cancelledReport", { requestId: pending.requestId }),
				elapsedMs: Date.now() - pending.startedAt,
			},
		})
		vscode.postMessage({ type: "cancelProviderConnectionTest", requestId: pending.requestId })
	}

	const copyReport = async () => {
		if (!result) return
		try {
			await navigator.clipboard.writeText(result.report)
			if (latestConfigurationKey.current === configurationKey && latestResult.current === result) {
				setCopyStatus("copied")
			}
		} catch {
			if (latestConfigurationKey.current === configurationKey && latestResult.current === result) {
				// JCEF may not expose the browser clipboard. Use the IDE's clipboard bridge as a fallback.
				pendingCopy.current = result
				setCopyStatus("error")
				try {
					vscode.postMessage({ type: "copyProviderConnectionReport", requestId: result.requestId })
				} catch {
					// The selectable report and manual-copy hint remain available if the host is unreachable.
					pendingCopy.current = null
				}
			}
		}
	}

	return (
		<div className="flex flex-col gap-2" data-testid="provider-connection-test">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium">{t("settings:providers.connectionTest.title")}</span>
				<Button type="button" variant="secondary" disabled={isRunning} onClick={startTest}>
					{t(`settings:providers.connectionTest.${isRunning ? "running" : "button"}`)}
				</Button>
				{isRunning && (
					<Button type="button" variant="secondary" onClick={cancelTest}>
						{t("settings:providers.connectionTest.cancel")}
					</Button>
				)}
			</div>
			<p className="m-0 text-sm text-vscode-descriptionForeground">
				{t("settings:providers.connectionTest.description")}
			</p>
			<p className="m-0 text-xs text-vscode-descriptionForeground">
				{t("settings:providers.connectionTest.scope")}
			</p>
			{result && (
				<div className="flex flex-col gap-2">
					<p className="m-0 font-medium" role="status">
						{t(`settings:providers.connectionTest.${result.status}`)}
					</p>
					<Textarea
						aria-label={t("settings:providers.connectionTest.report")}
						readOnly
						value={result.report}
						rows={8}
						className="box-border resize-y font-mono text-sm"
					/>
					<Button type="button" variant="secondary" className="self-start" onClick={copyReport}>
						{t(`settings:providers.connectionTest.${copyStatus === "copied" ? "copied" : "copy"}`)}
					</Button>
					{copyStatus === "error" && (
						<p className="m-0 text-sm text-vscode-descriptionForeground" role="status">
							{t("settings:providers.connectionTest.copyFailed")}
						</p>
					)}
				</div>
			)}
		</div>
	)
}
