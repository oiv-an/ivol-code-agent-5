// kilocode_change - new file
import type { HistoryItem } from "@roo-code/types"

/**
 * Maximum length of the task title stored in history indexes.
 *
 * The title is derived from the first chat message. Users sometimes paste
 * megabytes of JSON or logs there; storing all of it in every history index
 * made each chat save re-read, compare and rewrite multi-megabyte files on the
 * extension host thread. The full first message stays in ui_messages.json.
 */
export const HISTORY_TASK_TITLE_MAX_LENGTH = 4000

export function capHistoryTaskTitle(text: string): string {
	return text.length > HISTORY_TASK_TITLE_MAX_LENGTH ? `${text.slice(0, HISTORY_TASK_TITLE_MAX_LENGTH)}…` : text
}

/** Returns the same item when its title is already short, otherwise a shallow copy with a capped title. */
export function capHistoryItemTitle<T extends Pick<HistoryItem, "task">>(item: T): T {
	if (typeof item?.task !== "string" || item.task.length <= HISTORY_TASK_TITLE_MAX_LENGTH + 1) return item
	return { ...item, task: capHistoryTaskTitle(item.task) }
}
