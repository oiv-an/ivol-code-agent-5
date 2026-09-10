// kilocode_change - new file
import { ClipboardList, FileCheck2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { contextHandoffProgressSchema } from "@roo-code/types"
import { safeJsonParse } from "@roo/core"

import { ProgressIndicator } from "../ProgressIndicator"

interface ContextHandoffRowProps {
	text?: string
	isInProgress?: boolean
}

/** Persist the actual service instruction and verified file, separately from live progress. */
export function ContextHandoffRow({ text, isInProgress = false }: ContextHandoffRowProps) {
	const { t } = useTranslation()
	const parsed = contextHandoffProgressSchema.safeParse(safeJsonParse<unknown>(text))
	const isTaskDocument = parsed.success && parsed.data.path === "CURRENT_TASK.md"
	const translationPrefix = isTaskDocument ? "chat:intelligentTaskProgress" : "chat:contextHandoff"

	if (isInProgress) {
		return (
			<div className="flex items-center gap-2" role="status">
				<ProgressIndicator />
				<span className="font-bold text-vscode-foreground">{t(`${translationPrefix}.inProgress`)}</span>
			</div>
		)
	}

	if (!parsed.success) {
		return <div className="text-vscode-descriptionForeground">{t("chat:contextHandoff.invalidDetails")}</div>
	}

	const data = parsed.data
	const isPreparing = data.phase === "preparing"
	const Icon = isPreparing ? ClipboardList : FileCheck2
	const details = isPreparing ? data.prompt : data.content

	return (
		<div className="mb-2 min-w-0">
			<div className="flex items-center gap-2 font-bold text-vscode-foreground">
				<Icon size={16} className="shrink-0" />
				<span>{t(`${translationPrefix}.${isPreparing ? "preparingTitle" : "savedTitle"}`)}</span>
			</div>
			<p className="mt-2 mb-1 text-sm text-vscode-descriptionForeground">
				{t(`${translationPrefix}.${isPreparing ? "preparingDescription" : "savedDescription"}`)}
			</p>
			<div className="font-mono text-sm break-all text-vscode-foreground">{data.path}</div>
			{details && (
				<details className="mt-2" open={isPreparing}>
					<summary className="cursor-pointer select-none text-vscode-foreground">
						{t(isPreparing ? "chat:contextHandoff.promptLabel" : "chat:contextHandoff.contentLabel")}
					</summary>
					{/* Plain text preserves the complete saved content without executing HTML or links. */}
					<pre className="mt-2 mb-0 max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded bg-vscode-editor-background p-3 text-sm text-vscode-foreground">
						{details}
					</pre>
				</details>
			)}
		</div>
	)
}
