import type { HistoryItem, TaskSchedule } from "@roo-code/types"

import { advanceTaskSchedule, isTaskScheduleDue } from "./taskSchedule"

/** The part of ClineProvider the runner needs; kept narrow so it can be tested in isolation. */
export interface TaskScheduleHost {
	getCurrentTask():
		| {
				taskId: string
				abort: boolean
				taskAsk?: { ask?: string }
				messageQueueService: {
					messages: { id: string; source?: string }[]
					addMessage(text: string, images?: string[], source?: "schedule"): unknown
					removeMessage(id: string): unknown
				}
		  }
		| undefined
	getValue(key: "taskHistory"): HistoryItem[] | undefined
	updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]>
	postStateToWebview(): Promise<void>
	log(message: string): void
}

export const TASK_SCHEDULE_POLL_MS = 15_000

/** Questions where the agent has stopped working and is waiting for the user's next message. */
const DELIVERABLE_ASKS = new Set(["completion_result", "resume_completed_task", "resume_task", "followup"])

/**
 * Sends a task's scheduled text into that task while it is the open task of this view.
 * Nothing runs for closed or background tasks: the schedule waits in the task history
 * and resumes when the task is opened again.
 *
 * The in-memory map is the source of truth for this window. Task history is only the
 * persisted copy for reopening; concurrent history saves can carry a stale copy, so it is
 * re-synchronised from memory instead of being trusted.
 */
export class TaskScheduleRunner {
	private timer: ReturnType<typeof setInterval> | undefined
	private running = false
	/** null = explicitly stopped in this window. */
	private readonly schedules = new Map<string, TaskSchedule | null>()

	constructor(private readonly host: TaskScheduleHost) {}

	start() {
		if (this.timer) return
		this.timer = setInterval(() => void this.tick(), TASK_SCHEDULE_POLL_MS)
	}

	dispose() {
		if (this.timer) clearInterval(this.timer)
		this.timer = undefined
	}

	private historyItem(taskId: string) {
		return this.host.getValue("taskHistory")?.find((entry) => entry.id === taskId)
	}

	getSchedule(taskId: string | undefined): TaskSchedule | undefined {
		if (!taskId) return undefined
		if (this.schedules.has(taskId)) return this.schedules.get(taskId) ?? undefined
		return this.historyItem(taskId)?.schedule
	}

	/** Writes the in-memory schedule to task history when the persisted copy differs. */
	private async persist(taskId: string): Promise<void> {
		const item = this.historyItem(taskId)
		if (!item) return
		const schedule = this.getSchedule(taskId)
		if (JSON.stringify(item.schedule) === JSON.stringify(schedule)) return
		await this.host.updateTaskHistory({ ...item, schedule })
	}

	async setSchedule(taskId: string, schedule: TaskSchedule | undefined): Promise<boolean> {
		if (!this.historyItem(taskId)) return false
		this.schedules.set(taskId, schedule ?? null)
		// Stopping also withdraws a reminder that is still waiting in the queue.
		const task = this.host.getCurrentTask()
		if (!schedule && task?.taskId === taskId) {
			for (const message of task.messageQueueService.messages.filter((m) => m.source === "schedule")) {
				task.messageQueueService.removeMessage(message.id)
			}
		}
		await this.persist(taskId)
		await this.host.postStateToWebview()
		return true
	}

	async tick(now = Date.now()): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			const task = this.host.getCurrentTask()
			if (!task || task.abort) return
			const schedule = this.getSchedule(task.taskId)
			if (!schedule || !isTaskScheduleDue(schedule, now)) {
				await this.persist(task.taskId)
				return
			}

			// Deliver only when the agent has finished and waits for a reply. While it works the
			// run is skipped (never queued), so reminders cannot pile up and spam the task.
			const ask = task.taskAsk?.ask
			if (ask && DELIVERABLE_ASKS.has(ask) && task.messageQueueService.messages.length === 0) {
				task.messageQueueService.addMessage(schedule.text, [], "schedule")
			} else {
				this.host.log(`[TaskScheduleRunner] Task ${task.taskId} is busy; scheduled run skipped`)
			}
			this.schedules.set(task.taskId, advanceTaskSchedule(schedule, now) ?? null)
			await this.persist(task.taskId)
			await this.host.postStateToWebview()
		} catch (error) {
			this.host.log(
				`[TaskScheduleRunner] Scheduled run failed: ${error instanceof Error ? error.message : String(error)}`,
			)
		} finally {
			this.running = false
		}
	}
}
