// kilocode_change - new file

import type * as vscode from "vscode"

import { IdleCompletionReminder, IDLE_COMPLETION_REMINDER_DELAY_MS } from "../idleCompletionReminder"

describe("IdleCompletionReminder", () => {
	let notify: ReturnType<typeof vi.fn>
	let windowStateListeners: Array<(focused: boolean) => void>
	let disposeCalls: number

	const createReminder = (focused: boolean) => {
		const isWindowFocused = vi.fn(() => focused)

		const reminder = new IdleCompletionReminder({
			isWindowFocused,
			onWindowStateChange: (listener) => {
				windowStateListeners.push(listener)

				return {
					dispose: () => {
						disposeCalls += 1
						windowStateListeners = windowStateListeners.filter((entry) => entry !== listener)
					},
				} as vscode.Disposable
			},
			notify,
		})

		return { reminder, isWindowFocused }
	}

	beforeEach(() => {
		vi.useFakeTimers()
		notify = vi.fn()
		windowStateListeners = []
		disposeCalls = 0
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("stays quiet immediately after the task finishes", () => {
		const { reminder } = createReminder(false)

		reminder.scheduleReminder("All done")

		expect(notify).not.toHaveBeenCalled()

		// Even shortly before the delay expires nothing should be shown.
		vi.advanceTimersByTime(IDLE_COMPLETION_REMINDER_DELAY_MS - 1)
		expect(notify).not.toHaveBeenCalled()
	})

	it("notifies once the delay passes and the window is still unfocused", () => {
		const { reminder } = createReminder(false)

		reminder.scheduleReminder("All done")
		vi.advanceTimersByTime(IDLE_COMPLETION_REMINDER_DELAY_MS)

		expect(notify).toHaveBeenCalledTimes(1)
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: "All done" }))
	})

	it("says nothing when the user is looking at the editor", () => {
		const { reminder } = createReminder(true)

		reminder.scheduleReminder("All done")
		vi.advanceTimersByTime(IDLE_COMPLETION_REMINDER_DELAY_MS)

		expect(notify).not.toHaveBeenCalled()
	})

	it("drops the reminder when the user comes back on their own", () => {
		const { reminder } = createReminder(false)

		reminder.scheduleReminder("All done")
		windowStateListeners.forEach((listener) => listener(true))
		vi.advanceTimersByTime(IDLE_COMPLETION_REMINDER_DELAY_MS)

		expect(notify).not.toHaveBeenCalled()
	})

	it("keeps waiting while the window merely loses and regains nothing", () => {
		const { reminder } = createReminder(false)

		reminder.scheduleReminder("All done")
		windowStateListeners.forEach((listener) => listener(false))
		vi.advanceTimersByTime(IDLE_COMPLETION_REMINDER_DELAY_MS)

		expect(notify).toHaveBeenCalledTimes(1)
	})

	it("reports only the newest result when tasks finish one after another", () => {
		const { reminder } = createReminder(false)

		reminder.scheduleReminder("Old result")
		vi.advanceTimersByTime(IDLE_COMPLETION_REMINDER_DELAY_MS - 1000)
		reminder.scheduleReminder("Fresh result")
		vi.advanceTimersByTime(IDLE_COMPLETION_REMINDER_DELAY_MS)

		expect(notify).toHaveBeenCalledTimes(1)
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: "Fresh result" }))
	})

	it("cancels a pending reminder when the task continues", () => {
		const { reminder } = createReminder(false)

		reminder.scheduleReminder("All done")
		reminder.cancel()
		vi.advanceTimersByTime(IDLE_COMPLETION_REMINDER_DELAY_MS)

		expect(notify).not.toHaveBeenCalled()
	})

	it("releases its window listener so nothing leaks", () => {
		const { reminder } = createReminder(false)

		reminder.scheduleReminder("All done")
		vi.advanceTimersByTime(IDLE_COMPLETION_REMINDER_DELAY_MS)

		expect(disposeCalls).toBe(1)
		expect(windowStateListeners).toHaveLength(0)
	})

	it("keeps working on a host without a window focus API", () => {
		// Some hosts, such as the JetBrains bridge, only mirror part of the API.
		const reminder = new IdleCompletionReminder({ notify })

		expect(() => {
			reminder.scheduleReminder("All done")
			vi.advanceTimersByTime(IDLE_COMPLETION_REMINDER_DELAY_MS)
		}).not.toThrow()
	})

	it("survives a notification that fails", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		notify.mockRejectedValue(new Error("no notification daemon"))

		const { reminder } = createReminder(false)
		reminder.scheduleReminder("All done")
		await vi.advanceTimersByTimeAsync(IDLE_COMPLETION_REMINDER_DELAY_MS)

		expect(consoleError).toHaveBeenCalled()
		consoleError.mockRestore()
	})
})
