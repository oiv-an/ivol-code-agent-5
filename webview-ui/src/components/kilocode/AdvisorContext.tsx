import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import type { AdvisorState, ExtensionMessage, WebviewMessage } from "@roo-code/types"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { Button } from "@/components/ui"

const initialState: AdvisorState = {
	workspace: "",
	platformSupported: true,
	canScan: false,
	entries: [],
	checked: false,
}
type RequestType = "getAdvisorState" | "startAdvisorCheck" | "openAdvisorExtension"
const AdvisorContext = createContext<{
	state: AdvisorState
	busy: boolean
	checking: boolean
	timedOut: boolean
	unread: boolean
	hasStarted: boolean
	request: (type: RequestType, extra?: Partial<WebviewMessage>) => void
	ensureLoaded: () => void
	markRead: () => void
	cancel: () => void
} | null>(null)

export function AdvisorProvider({ children }: { children: ReactNode }) {
	const { t } = useAppTranslation()
	const [state, setState] = useState<AdvisorState>(initialState)
	const [busy, setBusy] = useState(true)
	const [checking, setChecking] = useState(false)
	const [timedOut, setTimedOut] = useState(false)
	const [unread, setUnread] = useState(false)
	const [notice, setNotice] = useState(false)
	const [hasStarted, setHasStarted] = useState(false)
	const loaded = useRef(false)
	const requestId = useRef<string>()
	const requestType = useRef<RequestType>()
	const timeout = useRef<ReturnType<typeof setTimeout>>()
	const cancel = useCallback(() => {
		if (requestType.current === "startAdvisorCheck" && requestId.current)
			vscode.postMessage({ type: "cancelAdvisorCheck", advisorRequestId: requestId.current })
	}, [])
	const markRead = useCallback(() => setUnread(false), [])
	const request = useCallback((type: RequestType, extra: Partial<WebviewMessage> = {}) => {
		if (requestId.current) return // Keep one correlated operation across all Advisor entry points.
		clearTimeout(timeout.current)
		const id = crypto.randomUUID()
		requestId.current = id
		requestType.current = type
		setBusy(true)
		setChecking(type === "startAdvisorCheck")
		setTimedOut(false)
		if (type === "startAdvisorCheck") {
			setHasStarted(true)
			setUnread(false)
			setNotice(false)
		}
		timeout.current = setTimeout(
			() => {
				setTimedOut(true)
				if (type === "startAdvisorCheck")
					vscode.postMessage({ type: "cancelAdvisorCheck", advisorRequestId: id })
				requestId.current = undefined
				setBusy(false)
				setChecking(false)
			},
			type === "startAdvisorCheck" ? 100000 : 30000,
		)
		vscode.postMessage({ ...extra, type, advisorRequestId: id })
	}, [])
	const ensureLoaded = useCallback(() => {
		if (loaded.current) return
		loaded.current = true
		request("getAdvisorState")
	}, [request])

	useEffect(() => {
		const listener = (event: MessageEvent<ExtensionMessage>) => {
			if (
				event.data.type !== "advisorState" ||
				!event.data.advisorState ||
				!requestId.current ||
				event.data.advisorRequestId !== requestId.current
			)
				return
			clearTimeout(timeout.current)
			const next = event.data.advisorState
			const wasScan = requestType.current === "startAdvisorCheck"
			setState((previous) => ({
				...next,
				ai: wasScan ? next.ai : previous.workspace === next.workspace ? previous.ai : undefined,
				workspaceDisabled:
					next.workspaceDisabled ??
					(previous.workspace === next.workspace ? previous.workspaceDisabled : undefined),
			}))
			requestId.current = undefined
			setBusy(false)
			setChecking(false)
			setTimedOut(false)
			if (wasScan && next.ai && !next.ai.error && !next.ai.cancelled && !next.error) {
				setUnread(true)
				setNotice(true)
			}
		}
		window.addEventListener("message", listener)
		return () => {
			clearTimeout(timeout.current)
			cancel()
			window.removeEventListener("message", listener)
		}
	}, [cancel])

	return (
		<AdvisorContext.Provider
			value={{ state, busy, checking, timedOut, unread, hasStarted, request, ensureLoaded, markRead, cancel }}>
			{children}
			{notice && (
				<div
					role="status"
					className="fixed top-2 left-2 right-2 z-50 rounded border border-vscode-panel-border bg-vscode-editor-background p-3 shadow-lg">
					<p className="m-0 mb-2">{t("common:advisor.ready")}</p>
					<div className="flex flex-wrap gap-2">
						<Button
							onClick={() => {
								setNotice(false)
								window.postMessage({ type: "action", action: "switchTab", tab: "advisor" }, "*")
							}}>
							{t("common:advisor.viewResults")}
						</Button>
						<Button variant="ghost" onClick={() => setNotice(false)}>
							{t("common:advisor.dismissNotice")}
						</Button>
					</div>
				</div>
			)}
		</AdvisorContext.Provider>
	)
}

export function useAdvisor() {
	const value = useContext(AdvisorContext)
	if (!value) throw new Error("AdvisorProvider is required")
	return value
}
