import { memo, useState } from "react" // kilocode_change
import { Button, Input } from "@/components/ui" // kilocode_change
import { useAppTranslation } from "@/i18n/TranslationContext" // kilocode_change
import type { HistoryItem } from "@roo-code/types"

import { vscode } from "@/utils/vscode"
import { cn } from "@/lib/utils"
import { Checkbox } from "@/components/ui/checkbox"

import TaskItemFooter from "./TaskItemFooter"

interface DisplayHistoryItem extends HistoryItem {
	highlight?: string
}

interface TaskItemProps {
	item: DisplayHistoryItem
	variant: "compact" | "full"
	showWorkspace?: boolean
	isSelectionMode?: boolean
	isSelected?: boolean
	onToggleSelection?: (taskId: string, isSelected: boolean) => void
	onDelete?: (taskId: string) => void
	className?: string
}

const TaskItem = ({
	item,
	variant,
	showWorkspace = false,
	isSelectionMode = false,
	isSelected = false,
	onToggleSelection,
	onDelete,
	className,
}: TaskItemProps) => {
	// kilocode_change start: keep the draft local until explicitly saved.
	const { t } = useAppTranslation()
	const [isRenaming, setIsRenaming] = useState(false)
	const [titleDraft, setTitleDraft] = useState("")
	const startRename = () => {
		// Untitled tasks start from an editable short excerpt of the prompt: a placeholder
		// with a huge prompt looked like editable text but could not be changed.
		setTitleDraft(item.title || defaultTitleDraft(item.task))
		setIsRenaming(true)
	}
	const saveTitle = () => {
		vscode.postMessage({ type: "renameTaskWithId", taskId: item.id, text: titleDraft.trim() })
		setIsRenaming(false)
	}
	// kilocode_change end
	const handleClick = () => {
		if (isRenaming) return // kilocode_change
		if (isSelectionMode && onToggleSelection) {
			onToggleSelection(item.id, !isSelected)
		} else {
			vscode.postMessage({ type: "showTaskWithId", text: item.id })
		}
	}

	const isCompact = variant === "compact"

	return (
		<div
			key={item.id}
			data-testid={`task-item-${item.id}`}
			className={cn(
				"cursor-pointer group bg-vscode-editor-background rounded relative overflow-hidden border border-transparent hover:bg-vscode-list-hoverBackground transition-colors", // kilocode_change: no rounded borders
				className,
			)}
			onClick={handleClick}>
			<div className={(!isCompact && isSelectionMode ? "pl-3 pb-3" : "pl-4") + " flex gap-3 px-3 pt-3 pb-1"}>
				{/* Selection checkbox - only in full variant */}
				{!isCompact && isSelectionMode && (
					<div
						className="task-checkbox mt-1"
						onClick={(e) => {
							e.stopPropagation()
						}}>
						<Checkbox
							checked={isSelected}
							onCheckedChange={(checked: boolean) => onToggleSelection?.(item.id, checked === true)}
							variant="description"
						/>
					</div>
				)}

				<div className="flex-1 min-w-0">
					{/* kilocode_change start: separate title editor, never an edit to the prompt. */}
					{isRenaming ? (
						<form
							onClick={(event) => event.stopPropagation()}
							onSubmit={(event) => {
								event.preventDefault()
								saveTitle()
							}}
							className="flex flex-col gap-2 mb-2">
							<Input
								autoFocus
								onFocus={(event) => event.currentTarget.select()}
								aria-label={t("history:renameTask")}
								placeholder={defaultTitleDraft(item.task)}
								value={titleDraft}
								onChange={(event) => setTitleDraft(event.target.value)}
								onKeyDown={(event) => {
									event.stopPropagation()
									if (event.key === "Escape") {
										event.preventDefault()
										setIsRenaming(false)
									}
									if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault()
								}}
							/>
							<div className="flex gap-2">
								<Button type="submit" size="sm">
									{t("settings:common.save")}
								</Button>
								<Button
									type="button"
									variant="secondary"
									size="sm"
									onClick={() => setIsRenaming(false)}>
									{t("history:cancel")}
								</Button>
							</div>
						</form>
					) : (
						<div
							className={cn(
								"overflow-hidden whitespace-pre-wrap font-light text-vscode-foreground text-ellipsis line-clamp-3",
								{
									"text-base": !isCompact,
								},
								!isCompact && isSelectionMode ? "mb-1" : "",
							)}
							data-testid="task-content"
							{...(item.highlight ? { dangerouslySetInnerHTML: { __html: item.highlight } } : {})}>
							{item.highlight ? undefined : item.title || item.task}
						</div>
					)}
					{/* kilocode_change end */}

					<TaskItemFooter
						item={item}
						variant={variant}
						isSelectionMode={isSelectionMode}
						onDelete={onDelete}
						onRename={startRename} // kilocode_change
					/>

					{showWorkspace && item.workspace && (
						<div className="flex flex-row gap-1 text-vscode-descriptionForeground text-xs mt-1">
							<span className="codicon codicon-folder scale-80" />
							<span>{item.workspace}</span>
						</div>
					)}
				</div>
			</div>
		</div>
	)
}

// kilocode_change start
const TITLE_DRAFT_MAX_LENGTH = 200

/** First non-empty line of the prompt, bounded so a huge prompt stays editable in a one-line field. */
export function defaultTitleDraft(task: string): string {
	const line =
		task
			.split(/\r?\n/)
			.map((part) => part.trim())
			.find(Boolean) ?? ""
	return Array.from(line).slice(0, TITLE_DRAFT_MAX_LENGTH).join("")
}
// kilocode_change end

export default memo(TaskItem)
