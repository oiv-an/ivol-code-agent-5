import React from "react"
import type { HistoryItem } from "@roo-code/types"
import { formatTimeAgo } from "@/utils/format"
import { formatCost } from "@/utils/costFormatting"
import { CopyButton } from "./CopyButton"
import { ExportButton } from "./ExportButton"
import { DeleteButton } from "./DeleteButton"
import { FavoriteButton } from "../kilocode/history/FavoriteButton" // kilocode_change
import { KiloShareSessionButton } from "./KiloShareSessionButton" // kilocode_change
import { StandardTooltip } from "../ui/standard-tooltip"
import { Button } from "@/components/ui" // kilocode_change
import { useAppTranslation } from "@/i18n/TranslationContext" // kilocode_change

export interface TaskItemFooterProps {
	item: HistoryItem
	variant: "compact" | "full"
	isSelectionMode?: boolean
	onDelete?: (taskId: string) => void
	onRename?: () => void // kilocode_change
}

const TaskItemFooter: React.FC<TaskItemFooterProps> = ({
	item,
	variant,
	isSelectionMode = false,
	onDelete,
	onRename,
}) => {
	// kilocode_change
	const { t } = useAppTranslation() // kilocode_change
	return (
		<div className="text-xs text-vscode-descriptionForeground flex justify-between items-center">
			<div className="flex gap-1 items-center text-vscode-descriptionForeground/60">
				{/* Datetime with time-ago format */}
				<StandardTooltip content={new Date(item.ts).toLocaleString()}>
					<span className="first-letter:uppercase">{formatTimeAgo(item.ts)}</span>
				</StandardTooltip>
				<span>·</span>
				{/* Cost */}
				{!!item.totalCost && (
					<span className="flex items-center" data-testid="cost-footer-compact">
						$${formatCost(item.totalCost)}
					</span>
				)}
			</div>

			{/* Action Buttons for non-compact view */}
			{!isSelectionMode && (
				<div className="flex flex-row gap-0 -mx-2 items-center text-vscode-descriptionForeground/60 hover:text-vscode-descriptionForeground">
					<CopyButton itemTask={item.task} />
					<FavoriteButton isFavorited={item.isFavorited ?? false} id={item.id} />
					<KiloShareSessionButton id={item.id} />
					{/* kilocode_change start */}
					{onRename && (
						<StandardTooltip content={t("history:renameTask")}>
							<Button
								variant="ghost"
								size="icon"
								aria-label={t("history:renameTask")}
								data-testid="rename-task-button"
								onClick={(event) => {
									event.stopPropagation()
									onRename()
								}}>
								<span className="codicon codicon-edit size-4 align-middle text-vscode-descriptionForeground" />
							</Button>
						</StandardTooltip>
					)}
					{/* kilocode_change end */}
					{variant === "full" && <ExportButton itemId={item.id} />}
					{onDelete && <DeleteButton itemId={item.id} onDelete={onDelete} />}
				</div>
			)}
		</div>
	)
}

export default TaskItemFooter
