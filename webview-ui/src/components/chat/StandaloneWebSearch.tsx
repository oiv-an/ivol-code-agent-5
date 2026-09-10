// kilocode_change - new file
import { useCallback, useEffect, useRef, useState } from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { DEFAULT_OPENAI_WEB_SEARCH_MODEL_ID, type ProviderSettings } from "@roo-code/types"
import type { ExtensionMessage, StandaloneWebSearchResult } from "@roo/ExtensionMessage"

import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"

interface StandaloneWebSearchProps {
	apiConfiguration?: ProviderSettings
	currentApiConfigName?: string
}

interface SearchSession {
	requestId: string
	configurationKey: string
	status: "running" | "success" | "error" | "cancelled"
	result?: StandaloneWebSearchResult
	errorCode?: string
	timeout?: ReturnType<typeof setTimeout>
}

const MAX_QUERY_LENGTH = 8_000
const UI_TIMEOUT_MS = 185_000
const SEARCH_ERRORS = new Set([
	"invalid_query",
	"query_too_long",
	"unsupported_provider",
	"invalid_configuration",
	"timeout",
	"connection",
	"authentication",
	"rate_limit",
	"provider",
	"empty_response",
	"internal",
])
const SAVE_ERRORS = new Set(["missing_result", "unsupported_location", "file_exists", "save_failed"])
let requestCounter = 0

function cancelHostSearch(requestId: string) {
	try {
		vscode.postMessage({ type: "cancelStandaloneWebSearch", requestId })
	} catch {
		// Local state is still invalidated when an IDE host has already disconnected.
		console.warn("Standalone web search: could not deliver cancellation to the extension host.")
	}
}

/** Search output is untrusted: only explicit, credential-free web links may leave this dialog. */
function safeWebUrl(value: string | undefined): string | undefined {
	if (!value || !/^https?:\/\//i.test(value)) return undefined
	try {
		const url = new URL(value)
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined
		return url.href
	} catch {
		return undefined
	}
}

export function StandaloneWebSearch({ apiConfiguration, currentApiConfigName }: StandaloneWebSearchProps) {
	const { t } = useAppTranslation()
	const supported = apiConfiguration?.apiProvider === "openai"
	const configuredSearchModel = apiConfiguration?.openAiWebSearchModelId?.trim() || DEFAULT_OPENAI_WEB_SEARCH_MODEL_ID
	// Compare saved settings in memory only; credentials never enter DOM attributes or outbound UI messages.
	const configurationKey = JSON.stringify([currentApiConfigName, apiConfiguration])
	const latestConfigurationKey = useRef(configurationKey)
	latestConfigurationKey.current = configurationKey
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState("")
	const [session, setSession] = useState<SearchSession | null>(null)
	const activeSession = useRef<SearchSession | null>(null)
	const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "cancelled" | "error">("idle")
	const [saveError, setSaveError] = useState("save_failed")
	const pendingSave = useRef<string | null>(null)
	const queryInput = useRef<HTMLTextAreaElement>(null)
	const visibleSession = session?.configurationKey === configurationKey ? session : null
	const isRunning = visibleSession?.status === "running"
	const result = visibleSession?.status === "success" ? visibleSession.result : undefined

	const discardSession = useCallback(() => {
		const previous = activeSession.current
		activeSession.current = null
		pendingSave.current = null
		if (previous?.timeout) clearTimeout(previous.timeout)
		if (previous) cancelHostSearch(previous.requestId)
	}, [])

	useEffect(() => {
		setSession(null)
		setQuery("")
		setSaveStatus("idle")
		setOpen(false)
		return discardSession
	}, [configurationKey, discardSession])

	useEffect(() => {
		const onMessage = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data
			const active = activeSession.current
			if (!active || active.configurationKey !== latestConfigurationKey.current) return
			if (message?.type === "standaloneWebSearchSaveResult") {
				const reply = message.standaloneWebSearchSaveResult
				if (!reply || reply.requestId !== active.requestId || pendingSave.current !== reply.requestId) return
				if (!["saved", "cancelled", "error"].includes(reply.status)) return
				pendingSave.current = null
				setSaveStatus(reply.status)
				setSaveError(SAVE_ERRORS.has(reply.errorCode ?? "") ? reply.errorCode! : "save_failed")
				return
			}
			if (message?.type !== "standaloneWebSearchUpdate") return
			const reply = message.standaloneWebSearchUpdate
			if (!reply || reply.requestId !== active.requestId || active.status !== "running") return
			if (reply.status === "running") return
			if (!["success", "error", "cancelled"].includes(reply.status)) return
			if (active.timeout) clearTimeout(active.timeout)
			const validResult =
				reply.status === "success" &&
				reply.result?.requestId === active.requestId &&
				typeof reply.result.answer === "string" &&
				reply.result.answer.trim().length > 0 &&
				Array.isArray(reply.result.sources)
			const next: SearchSession = {
				requestId: active.requestId,
				configurationKey: active.configurationKey,
				status: reply.status === "success" && !validResult ? "error" : reply.status,
				result: validResult ? reply.result : undefined,
				errorCode:
					reply.status === "success" && !validResult
						? "empty_response"
						: SEARCH_ERRORS.has(reply.errorCode ?? "")
							? reply.errorCode
							: "internal",
			}
			activeSession.current = next
			setSession(next)
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [])

	const closeDialog = () => {
		discardSession()
		setOpen(false)
		setQuery("")
		setSession(null)
		setSaveStatus("idle")
	}

	const startSearch = () => {
		if (!supported || activeSession.current?.status === "running" || pendingSave.current) return
		const text = query.trim()
		if (!text || text.length > MAX_QUERY_LENGTH) return
		discardSession()
		const requestId = globalThis.crypto?.randomUUID?.() ?? `web-search-${Date.now()}-${++requestCounter}`
		const next: SearchSession = { requestId, configurationKey, status: "running" }
		activeSession.current = next
		setSession(next)
		setSaveStatus("idle")
		next.timeout = setTimeout(() => {
			if (activeSession.current !== next || latestConfigurationKey.current !== configurationKey) return
			const timedOut: SearchSession = { ...next, timeout: undefined, status: "error", errorCode: "timeout" }
			activeSession.current = timedOut
			setSession(timedOut)
			cancelHostSearch(requestId)
		}, UI_TIMEOUT_MS)
		try {
			vscode.postMessage({ type: "startStandaloneWebSearch", requestId, text })
		} catch {
			clearTimeout(next.timeout)
			const failed: SearchSession = { ...next, timeout: undefined, status: "error", errorCode: "internal" }
			activeSession.current = failed
			setSession(failed)
		}
	}

	const cancelSearch = () => {
		const active = activeSession.current
		if (active?.status !== "running") return
		discardSession()
		setSession({ requestId: active.requestId, configurationKey: active.configurationKey, status: "cancelled" })
	}

	const saveResult = () => {
		if (!result || activeSession.current?.result !== result || pendingSave.current) return
		pendingSave.current = result.requestId
		setSaveStatus("saving")
		try {
			vscode.postMessage({ type: "saveStandaloneWebSearch", requestId: result.requestId })
		} catch {
			pendingSave.current = null
			setSaveStatus("error")
			setSaveError("save_failed")
		}
	}

	const openLink = (url: string) => vscode.postMessage({ type: "openExternal", url })
	const sources = (result?.sources ?? []).flatMap((source) => {
		const url = safeWebUrl(source.url)
		return url ? [{ url, title: source.title || url }] : []
	})

	return (
		<Dialog open={open} onOpenChange={(nextOpen) => (nextOpen && supported ? setOpen(true) : closeDialog())}>
			<span title={t(`chat:standaloneWebSearch.${supported ? "button" : "unsupported"}`)} className="shrink-0">
				<button
					type="button"
					aria-label={t("chat:standaloneWebSearch.button")}
					aria-haspopup="dialog"
					aria-expanded={open}
					disabled={!supported}
					onClick={() => setOpen(true)}
					className="vscode-button flex items-center gap-1.5 p-0.75 rounded-sm text-vscode-foreground cursor-pointer hover:bg-vscode-list-hoverBackground disabled:opacity-50 disabled:cursor-not-allowed">
					<span className="codicon codicon-globe text-sm" aria-hidden="true" />
				</button>
			</span>
			<DialogPortal>
				<DialogOverlay />
				<DialogPrimitive.Content
					onOpenAutoFocus={(event) => {
						event.preventDefault()
						queryInput.current?.focus()
					}}
					className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-lg border bg-vscode-editor-background p-4 text-vscode-foreground shadow-lg">
					<div className="flex items-start justify-between gap-2">
						<DialogTitle>{t("chat:standaloneWebSearch.title")}</DialogTitle>
						<DialogPrimitive.Close asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								aria-label={t("chat:standaloneWebSearch.close")}>
								<span className="codicon codicon-close" aria-hidden="true" />
							</Button>
						</DialogPrimitive.Close>
					</div>
					<DialogDescription>{t("chat:standaloneWebSearch.description")}</DialogDescription>
					<p className="m-0 text-xs text-vscode-descriptionForeground">
						{t("chat:standaloneWebSearch.charges")}
					</p>
					<p className="m-0 break-words text-xs text-vscode-descriptionForeground">
						{t("chat:standaloneWebSearch.model", { model: configuredSearchModel })}
					</p>
					<label className="flex min-w-0 flex-col gap-1">
						<span>{t("chat:standaloneWebSearch.queryLabel")}</span>
						<Textarea
							ref={queryInput}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => {
								if (
									event.key === "Enter" &&
									!event.shiftKey &&
									!event.nativeEvent.isComposing &&
									event.keyCode !== 229
								) {
									event.preventDefault()
									startSearch()
								}
							}}
							maxLength={MAX_QUERY_LENGTH}
							disabled={isRunning || saveStatus === "saving"}
							rows={3}
							className="box-border min-w-0 resize-y"
							placeholder={t("chat:standaloneWebSearch.queryPlaceholder")}
						/>
					</label>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							type="button"
							onClick={startSearch}
							disabled={
								isRunning ||
								saveStatus === "saving" ||
								!query.trim() ||
								query.trim().length > MAX_QUERY_LENGTH
							}>
							{t(`chat:standaloneWebSearch.${isRunning ? "searching" : "search"}`)}
						</Button>
						{isRunning && (
							<Button type="button" variant="secondary" onClick={cancelSearch}>
								{t("chat:standaloneWebSearch.cancel")}
							</Button>
						)}
					</div>
					{isRunning && (
						<p className="m-0 text-sm" role="status">
							{t("chat:standaloneWebSearch.loading")}
						</p>
					)}
					{visibleSession?.status === "error" && (
						<p className="m-0 text-sm" role="alert">
							{t(`chat:standaloneWebSearch.errors.${visibleSession.errorCode}`)}
						</p>
					)}
					{visibleSession?.status === "cancelled" && (
						<p className="m-0 text-sm" role="status">
							{t("chat:standaloneWebSearch.cancelled")}
						</p>
					)}
					{result && (
						<section aria-label={t("chat:standaloneWebSearch.result")} className="min-w-0 border-t pt-3">
							<p className="m-0 mb-2 break-words text-sm">{result.query}</p>
							<p className="m-0 mb-2 text-xs text-vscode-descriptionForeground">
								{t("chat:standaloneWebSearch.resultModel", { model: result.model })}
							</p>
							<div className="min-w-0 break-words [overflow-wrap:anywhere] [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_table]:block [&_table]:overflow-x-auto">
								<ReactMarkdown
									skipHtml
									remarkPlugins={[remarkGfm]}
									urlTransform={(url) => safeWebUrl(url) ?? ""}
									components={{
										img: () => null,
										a: ({ href, children }) => {
											const url = safeWebUrl(href)
											return url ? (
												<a
													href={url}
													rel="noreferrer noopener"
													onClick={(event) => {
														event.preventDefault()
														openLink(url)
													}}
													onAuxClick={(event) => {
														event.preventDefault()
														if (event.button === 1) openLink(url)
													}}>
													{children}
												</a>
											) : (
												<span>{children}</span>
											)
										},
									}}>
									{result.answer}
								</ReactMarkdown>
							</div>
							{sources.length > 0 && (
								<div className="mt-3">
									<h3 className="my-1 text-sm">{t("chat:standaloneWebSearch.sources")}</h3>
									<ul className="m-0 pl-5">
										{sources.map((source, index) => (
											<li
												key={`${source.url}:${index}`}
												className="break-words [overflow-wrap:anywhere]">
												<a
													href={source.url}
													rel="noreferrer noopener"
													onClick={(event) => {
														event.preventDefault()
														openLink(source.url)
													}}
													onAuxClick={(event) => {
														event.preventDefault()
														if (event.button === 1) openLink(source.url)
													}}>
													{source.title}
												</a>
											</li>
										))}
									</ul>
								</div>
							)}
							{result.truncated && (
								<p className="text-sm" role="status">
									{t("chat:standaloneWebSearch.truncated")}
								</p>
							)}
							<Button
								type="button"
								variant="secondary"
								className="mt-3"
								onClick={saveResult}
								disabled={saveStatus === "saving"}>
								{t(`chat:standaloneWebSearch.${saveStatus === "saving" ? "saving" : "save"}`)}
							</Button>
							<p className="mb-0 text-xs text-vscode-descriptionForeground">
								{t("chat:standaloneWebSearch.saveHint")}
							</p>
							{["saved", "cancelled"].includes(saveStatus) && (
								<p className="mb-0 text-sm" role="status">
									{t(
										`chat:standaloneWebSearch.${saveStatus === "saved" ? "saved" : "saveCancelled"}`,
									)}
								</p>
							)}
							{saveStatus === "error" && (
								<p className="mb-0 text-sm" role="alert">
									{t(`chat:standaloneWebSearch.saveErrors.${saveError}`)}
								</p>
							)}
						</section>
					)}
				</DialogPrimitive.Content>
			</DialogPortal>
		</Dialog>
	)
}
