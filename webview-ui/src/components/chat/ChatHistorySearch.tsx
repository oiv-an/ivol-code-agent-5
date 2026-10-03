// kilocode_change - new file
import { useEffect, useRef, useState } from "react"
import type { ExtensionMessage } from "@roo-code/types"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"
import HistoryIconButton from "./HistoryIconButton"

type Result = NonNullable<ExtensionMessage["chatSearchResult"]>

export default function ChatHistorySearch({ taskId }: { taskId: string }) {
	const { t } = useAppTranslation()
	const [query, setQuery] = useState("")
	const [result, setResult] = useState<Result>()
	const [busy, setBusy] = useState(false)
	const [selected, setSelected] = useState<number>()
	const pending = useRef("")
	const serial = useRef(0)
	useEffect(() => {
		const receive = (event: MessageEvent<ExtensionMessage>) => {
			const data = event.data.chatSearchResult
			if (
				event.data.type !== "chatSearchResult" ||
				!data ||
				data.taskId !== taskId ||
				data.requestId !== pending.current
			)
				return
			setResult(data)
			setBusy(false)
		}
		window.addEventListener("message", receive)
		return () => {
			pending.current = ""
			window.removeEventListener("message", receive)
		}
	}, [taskId])
	const [timedOut, setTimedOut] = useState(false)
	useEffect(() => {
		if (!busy) return
		const timer = setTimeout(() => {
			pending.current = ""
			setBusy(false)
			setTimedOut(true)
		}, 15000)
		return () => clearTimeout(timer)
	}, [busy])
	const highlight = (text: string) => {
		const term = query.trim()
		const index = term ? text.toLowerCase().indexOf(term.toLowerCase()) : -1
		return index < 0 ? (
			text
		) : (
			<>
				{text.slice(0, index)}
				<mark>{text.slice(index, index + term.length)}</mark>
				{text.slice(index + term.length)}
			</>
		)
	}
	const search = (messageTs?: number, before?: number) => {
		setTimedOut(false)
		if (!query.trim()) return
		pending.current = `history-${Date.now()}-${++serial.current}`
		setBusy(true)
		setSelected(messageTs)
		setResult(undefined)
		vscode.postMessage({
			type: "searchChatHistory",
			chatSearchRequest: { taskId, requestId: pending.current, query: query.trim(), messageTs, before },
		})
	}
	return (
		<section className="flex flex-col min-h-0 border-b border-vscode-panel-border px-4 py-2">
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault()
					search()
				}}>
				<input
					className="min-w-0 flex-1 bg-vscode-input-background text-vscode-input-foreground px-2 py-1"
					aria-label={t("chat:historySearch.query")}
					placeholder={t("chat:historySearch.query")}
					maxLength={200}
					value={query}
					onChange={(event) => {
						pending.current = ""
						setBusy(false)
						setResult(undefined)
						setQuery(event.target.value)
					}}
				/>
				<HistoryIconButton
					type="submit"
					icon="search"
					label={t("chat:historySearch.search")}
					disabled={!query.trim() || busy}
				/>
			</form>
			<div className="max-h-96 overflow-y-auto" aria-live="polite">
				{busy && <p>{t("chat:historySearch.loading")}</p>}
				{timedOut && <p>{t("chat:historySearch.timeout")}</p>}
				{result && !result.messages && result.hits.length === 0 && <p>{t("chat:historySearch.empty")}</p>}
				{result?.hits.map((hit) => (
					<button
						key={hit.ts}
						className="block w-full text-left whitespace-pre-wrap break-words border-b border-vscode-panel-border py-2"
						onClick={() => search(hit.ts)}>
						{highlight(hit.snippet)}
					</button>
				))}
				{result?.nextBefore !== undefined && (
					<HistoryIconButton
						icon="chevron-down"
						label={t("chat:historySearch.more")}
						onClick={() => search(undefined, result.nextBefore)}
					/>
				)}
				{result?.messages?.map((row) => (
					<div
						key={row.ts}
						className={`whitespace-pre-wrap break-words py-2 ${row.ts === selected ? "border-l-2 border-vscode-focusBorder pl-2" : ""}`}>
						<pre className="whitespace-pre-wrap break-words text-xs">{highlight(row.text ?? "")}</pre>
						<HistoryIconButton
							icon="go-to-file"
							label={t("chat:historyWindow.openFull")}
							onClick={() =>
								vscode.postMessage({
									type: "openChatMessage",
									chatMessageRequest: { taskId, ts: row.ts },
								})
							}
						/>
					</div>
				))}
			</div>
		</section>
	)
}
