import type { HistoryItem } from "@roo-code/types"

import { advanceTaskSchedule, createTaskSchedule, isTaskScheduleDue } from "../taskSchedule"
import { TaskScheduleRunner, type TaskScheduleHost } from "../TaskScheduleRunner"

const NOW = 1_000_000

describe("createTaskSchedule", () => {
	it("builds interval, delay and exact-time schedules", () => {
		expect(createTaskSchedule({ mode: "interval", text: " check ", minutes: 60 }, NOW)).toEqual({
			mode: "interval",
			text: "check",
			intervalMinutes: 60,
			nextRunAt: NOW + 3_600_000,
		})
		expect(createTaskSchedule({ mode: "delay", text: "check", minutes: 5 }, NOW)).toEqual({
			mode: "delay",
			text: "check",
			intervalMinutes: 5,
			nextRunAt: NOW + 300_000,
		})
		expect(createTaskSchedule({ mode: "at", text: "check", at: NOW + 10 }, NOW)?.nextRunAt).toBe(NOW + 10)
	})

	it("keeps the running countdown when re-saved with the same duration", () => {
		const first = createTaskSchedule({ mode: "interval", text: "a", minutes: 120 }, NOW)!
		const later = NOW + 600_000
		expect(createTaskSchedule({ mode: "interval", text: "b", minutes: 120 }, later, first)).toEqual({
			...first,
			text: "b",
		})
		expect(createTaskSchedule({ mode: "interval", text: "b", minutes: 60 }, later, first)?.nextRunAt).toBe(
			later + 3_600_000,
		)
		expect(createTaskSchedule({ mode: "delay", text: "b", minutes: 120 }, later, first)?.nextRunAt).toBe(
			later + 7_200_000,
		)
	})

	it("rejects empty text, bad intervals and past times", () => {
		expect(createTaskSchedule({ mode: "interval", text: "  ", minutes: 60 }, NOW)).toBeUndefined()
		expect(createTaskSchedule({ mode: "interval", text: "x", minutes: 0 }, NOW)).toBeUndefined()
		expect(createTaskSchedule({ mode: "at", text: "x", at: NOW - 1 }, NOW)).toBeUndefined()
	})

	it("repeats only interval schedules", () => {
		const interval = createTaskSchedule({ mode: "interval", text: "x", minutes: 1 }, NOW)!
		expect(isTaskScheduleDue(interval, NOW)).toBe(false)
		expect(advanceTaskSchedule(interval, NOW + 600_000)?.nextRunAt).toBe(NOW + 660_000)
		expect(advanceTaskSchedule(createTaskSchedule({ mode: "delay", text: "x", minutes: 1 }, NOW)!)).toBeUndefined()
	})
})

describe("TaskScheduleRunner", () => {
	function setup(schedule: HistoryItem["schedule"], current = "t1") {
		let history: HistoryItem[] = [
			{ id: "t1", number: 1, ts: 0, task: "", tokensIn: 0, tokensOut: 0, totalCost: 0, schedule },
		]
		const queue: { id: string; text: string; source?: string }[] = []
		const state: { ask?: string } = { ask: "completion_result" }
		const host: TaskScheduleHost = {
			getCurrentTask: () =>
				current
					? {
							taskId: current,
							abort: false,
							taskAsk: state.ask ? { ask: state.ask } : undefined,
							messageQueueService: {
								messages: queue,
								addMessage: (text, _images, source) =>
									queue.push({ id: String(queue.length), text, source }),
								removeMessage: (id) =>
									queue.splice(
										queue.findIndex((m) => m.id === id),
										1,
									),
							},
						}
					: undefined,
			getValue: () => history,
			updateTaskHistory: async (item) => (history = history.map((h) => (h.id === item.id ? item : h))),
			postStateToWebview: async () => {},
			log: () => {},
		}
		return {
			runner: new TaskScheduleRunner(host),
			queue,
			state,
			history: () => history,
			overwriteHistory: (item: HistoryItem) => (history = [item]),
		}
	}

	it("sends due text to the idle open task and advances the interval", async () => {
		const { runner, queue, history } = setup({
			mode: "interval",
			text: "check",
			intervalMinutes: 60,
			nextRunAt: NOW,
		})
		await runner.tick(NOW)
		expect(queue.map((m) => m.text)).toEqual(["check"])
		expect(history()[0].schedule?.nextRunAt).toBe(NOW + 3_600_000)
	})

	it("skips the run while the agent is working and never queues it", async () => {
		const { runner, queue, state, history } = setup({
			mode: "interval",
			text: "check",
			intervalMinutes: 60,
			nextRunAt: NOW,
		})
		state.ask = undefined // running
		await runner.tick(NOW)
		state.ask = "command" // waiting for an approval is also busy
		await runner.tick(NOW + 3_600_000)
		expect(queue).toHaveLength(0)
		expect(history()[0].schedule?.nextRunAt).toBe(NOW + 7_200_000)
	})

	it("restores the schedule when a concurrent history save drops it", async () => {
		const schedule = { mode: "interval" as const, text: "check", intervalMinutes: 60, nextRunAt: NOW + 60_000 }
		const { runner, history, overwriteHistory } = setup(undefined)
		await runner.setSchedule("t1", schedule)
		overwriteHistory({ ...history()[0], schedule: undefined })
		expect(runner.getSchedule("t1")).toEqual(schedule)
		await runner.tick(NOW)
		expect(history()[0].schedule).toEqual(schedule)
	})

	it("stopping withdraws a pending reminder", async () => {
		const { runner, queue } = setup({ mode: "at", text: "check", nextRunAt: NOW })
		await runner.tick(NOW)
		expect(queue).toHaveLength(1)
		await runner.setSchedule("t1", undefined)
		expect(queue).toHaveLength(0)
		expect(runner.getSchedule("t1")).toBeUndefined()
	})

	it("clears one-shot schedules after running", async () => {
		const { runner, queue, history } = setup({ mode: "at", text: "check", nextRunAt: NOW })
		await runner.tick(NOW)
		expect(queue).toHaveLength(1)
		expect(history()[0].schedule).toBeUndefined()
	})

	it("does nothing when the task is not open", async () => {
		const { runner, queue, history } = setup({ mode: "at", text: "check", nextRunAt: NOW }, "")
		await runner.tick(NOW)
		expect(queue).toHaveLength(0)
		expect(history()[0].schedule).toBeDefined()
	})
})
