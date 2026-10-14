import { useEffect, useState } from "react"
import type { ExtensionState } from "@roo-code/types"
import { useAppTranslation } from "@src/i18n/TranslationContext"

export function ActiveOperation({
	operation,
	stopping,
	onStop,
}: {
	operation: ExtensionState["currentTaskOperation"]
	stopping: boolean
	onStop: () => void
}) {
	const { t } = useAppTranslation()
	const [now, setNow] = useState(Date.now())
	useEffect(() => {
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [operation?.startedAt])
	const seconds = operation ? Math.max(0, Math.floor((now - operation.startedAt) / 1000)) : null
	return (
		<section
			className="mx-[15px] mb-2 shrink-0 border border-vscode-panel-border p-2"
			data-testid="active-operation">
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 break-words text-xs">
					{operation ? operation.name : t("chat:activeOperation.working")}
					{seconds !== null && ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}
				</span>
				<button
					type="button"
					disabled={stopping}
					onClick={onStop}
					className="shrink-0 cursor-pointer border-0 bg-vscode-button-background px-3 py-1 text-vscode-button-foreground disabled:opacity-50">
					{t(stopping ? "chat:activeOperation.stopping" : "chat:activeOperation.stop")}
				</button>
			</div>
			{operation && (
				<details key={operation.startedAt} className="mt-1 text-xs">
					<summary className="cursor-pointer">{t("chat:activeOperation.details")}</summary>
					<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all select-text">
						{operation.details}
					</pre>
				</details>
			)}
			<p className="mb-0 mt-1 text-xs text-vscode-descriptionForeground">{t("chat:activeOperation.notice")}</p>
		</section>
	)
}
