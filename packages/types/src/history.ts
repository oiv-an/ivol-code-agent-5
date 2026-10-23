import { z } from "zod"
import { taskModelSelectionSchema } from "./provider-settings.js" // kilocode_change

// kilocode_change start: a per-task reminder that re-sends text to this task while it is open.
export const taskScheduleSchema = z.object({
	mode: z.enum(["interval", "delay", "at"]),
	text: z.string(),
	intervalMinutes: z.number().optional(),
	nextRunAt: z.number(),
	allowBrowser: z.boolean().optional(), // auto-confirm the browser control prompt for this task
})

export type TaskSchedule = z.infer<typeof taskScheduleSchema>
// kilocode_change end

/**
 * HistoryItem
 */

export const historyItemSchema = z.object({
	id: z.string(),
	rootTaskId: z.string().optional(),
	parentTaskId: z.string().optional(),
	number: z.number(),
	ts: z.number(),
	task: z.string(),
	tokensIn: z.number(),
	tokensOut: z.number(),
	cacheWrites: z.number().optional(),
	cacheReads: z.number().optional(),
	totalCost: z.number(),
	size: z.number().optional(),
	workspace: z.string().optional(),
	isFavorited: z.boolean().optional(), // kilocode_change
	mode: z.string().optional(),
	/**
	 * The tool protocol used by this task. Once a task uses tools with a specific
	 * protocol (XML or Native), it is permanently locked to that protocol.
	 *
	 * - "xml": Tool calls are parsed from XML text (no tool IDs)
	 * - "native": Tool calls come as tool_call chunks with IDs
	 *
	 * This ensures task resumption works correctly even when NTC settings change.
	 */
	toolProtocol: z.enum(["xml", "native"]).optional(),
	apiConfigName: z.string().optional(), // Provider profile name for sticky profile feature
	// kilocode_change: chat-footer model/reasoning/preset choice made inside this task (no credentials)
	modelSelection: taskModelSelectionSchema.optional(),
	schedule: taskScheduleSchema.optional(), // kilocode_change
	status: z.enum(["active", "completed", "delegated"]).optional(),
	delegatedToId: z.string().optional(), // Last child this parent delegated to
	childIds: z.array(z.string()).optional(), // All children spawned by this task
	awaitingChildId: z.string().optional(), // Child currently awaited (set when delegated)
	completedByChildId: z.string().optional(), // Child that completed and resumed this parent
	completionResultSummary: z.string().optional(), // Summary from completed child
})

export type HistoryItem = z.infer<typeof historyItemSchema>
