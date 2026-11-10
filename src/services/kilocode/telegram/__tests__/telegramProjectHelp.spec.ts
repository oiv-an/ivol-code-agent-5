import { telegramProjectHelp } from "../TelegramProjectControl"

describe("telegramProjectHelp", () => {
	it("lists tappable /taskN shortcuts for the three most recent tasks", () => {
		const help = telegramProjectHelp("proj", ["a", "b", "c", "d"])
		expect(help).toContain("/task1 — a")
		expect(help).toContain("/task3 — c")
		expect(help).not.toContain("/task4")
		expect(telegramProjectHelp("proj")).not.toContain("/task1")
	})
})
