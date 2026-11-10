import { taskLabel, telegramProjectHelp } from "../TelegramProjectControl"

describe("telegramProjectHelp", () => {
	it("lists tappable /taskN shortcuts for the three most recent tasks", () => {
		const help = telegramProjectHelp("proj", ["a", "b", "c", "d"])
		expect(help).toContain("/task1 — a")
		expect(help).toContain("/task3 — c")
		expect(help).not.toContain("/task4")
		expect(telegramProjectHelp("proj")).not.toContain("/task1")
	})

	it("prefers the user's task name over the first request", () => {
		expect(taskLabel({ task: "long request", title: " Release " })).toBe("Release")
		expect(taskLabel({ task: "long request", title: " " })).toBe("long request")
		expect(taskLabel({ task: "long request" })).toBe("long request")
	})
})
