import type { TaskSchedule } from "@roo-code/types"

/** Schedule form values sent by the chat toolbar. */
export interface TaskScheduleInput {
	mode: TaskSchedule["mode"]
	text: string
	/** Interval length ("interval") or wait time ("delay") in minutes. */
	minutes?: number
	/** Exact run time in epoch milliseconds ("at"). */
	at?: number
}

const MAX_MINUTES = 60 * 24 * 365

/**
 * Validates toolbar input and returns a schedule with its run time, or undefined when invalid.
 * Re-saving with the same mode and duration keeps the running countdown (only the text may change).
 */
export function createTaskSchedule(
	input: TaskScheduleInput,
	now = Date.now(),
	previous?: TaskSchedule,
): TaskSchedule | undefined {
	const text = typeof input?.text === "string" ? input.text.trim() : ""
	if (!text) return undefined

	if (input.mode === "interval" || input.mode === "delay") {
		const minutes = Number(input.minutes)
		if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_MINUTES) return undefined
		const rounded = Math.round(minutes)
		const unchanged =
			previous?.mode === input.mode && previous.intervalMinutes === rounded && previous.nextRunAt > now
		return {
			mode: input.mode,
			text,
			intervalMinutes: rounded,
			nextRunAt: unchanged ? previous.nextRunAt : now + rounded * 60_000,
		}
	}

	if (input.mode === "at") {
		const at = Number(input.at)
		if (!Number.isFinite(at) || at <= now) return undefined
		return { mode: "at", text, nextRunAt: at }
	}

	return undefined
}

export function isTaskScheduleDue(schedule: TaskSchedule | undefined, now = Date.now()): boolean {
	return !!schedule && schedule.nextRunAt <= now
}

/**
 * Returns the schedule after a run: intervals move to the next slot after now
 * (missed slots are not replayed), one-shot schedules end.
 */
export function advanceTaskSchedule(schedule: TaskSchedule, now = Date.now()): TaskSchedule | undefined {
	if (schedule.mode !== "interval" || !schedule.intervalMinutes) return undefined
	return { ...schedule, nextRunAt: now + schedule.intervalMinutes * 60_000 }
}
