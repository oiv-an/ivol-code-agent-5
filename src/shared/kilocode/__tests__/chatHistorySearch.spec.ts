import type { ClineMessage } from "@roo-code/types"
import { searchChatHistory, chatHistoryContext } from "../chatHistorySearch"

const rows: ClineMessage[] = Array.from({ length: 100 }, (_, ts) => ({
	ts,
	type: "say",
	say: "text",
	text: `original ${ts} NEEDLE`,
}))

describe("current chat search", () => {
	it("returns bounded newest-first pages with no skipped matching rows", () => {
		let result = searchChatHistory(rows, "needle")
		const found = [...result.hits]
		while (result.nextBefore !== undefined) {
			result = searchChatHistory(rows, "needle", result.nextBefore)
			expect(result.hits.length).toBeLessThanOrEqual(20)
			found.push(...result.hits)
		}
		expect(found.map((hit) => hit.ts)).toEqual(rows.map((row) => row.ts).reverse())
	})
	it("finds original text beyond the UI preview and centers the context excerpt", () => {
		const text = "x".repeat(20000) + "NEEDLE" + "y".repeat(20000)
		const source: ClineMessage[] = [{ ts: 1, type: "say", text }]
		expect(searchChatHistory(source, "needle").hits[0].snippet).toContain("NEEDLE")
		const context = chatHistoryContext(source, 1, "needle")
		expect(context[0].text).toContain("NEEDLE")
		expect(context[0].text!.length).toBeLessThan(3100)
		expect(source[0].text).toBe(text)
	})
	it("returns at most seven neighbors and no result for an unknown timestamp", () => {
		expect(chatHistoryContext(rows, 50)).toHaveLength(7)
		expect(chatHistoryContext(rows, 999)).toEqual([])
	})
	it("treats regex characters literally and rejects empty or overlong queries", () => {
		expect(searchChatHistory(rows, ".*").hits).toEqual([])
		expect(searchChatHistory(rows, " ").hits).toEqual([])
		expect(searchChatHistory(rows, "x".repeat(201)).hits).toEqual([])
	})
})
