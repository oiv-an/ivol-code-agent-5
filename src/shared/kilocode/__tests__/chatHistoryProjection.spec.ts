import type { ClineMessage } from "@roo-code/types"
import { projectChatMessage, projectHistoryPage, projectLiveChat } from "../chatHistoryProjection"

const history = (count: number): ClineMessage[] =>
	Array.from({ length: count }, (_, ts) => ({ ts, type: "say", say: "text", text: `Message ${ts}` }))

describe("bounded chat projections", () => {
	it("keeps the header and newest 80 rows without changing the original", () => {
		const rows = history(1000)
		const view = projectLiveChat(rows)
		expect(view).toHaveLength(81)
		expect(view[0].ts).toBe(0)
		expect(view[1].ts).toBe(920)
		expect(rows).toHaveLength(1000)
	})

	it("walks every historical row exactly once backwards and forwards", () => {
		const rows = history(251)
		let page = projectHistoryPage("task", rows)
		const seen = [...page.messages]
		while (page.before !== undefined) {
			page = projectHistoryPage("task", rows, { before: page.before })
			expect(page.messages.length).toBeLessThanOrEqual(80)
			seen.unshift(...page.messages)
		}
		expect(seen.map((row) => row.ts)).toEqual(rows.slice(1).map((row) => row.ts))
		while (page.after !== undefined) page = projectHistoryPage("task", rows, { after: page.after })
		expect(page.messages.at(-1)?.ts).toBe(250)
	})

	it("preserves full tool JSON and images without modifying stored data", () => {
		const row: ClineMessage = {
			ts: 1,
			type: "ask",
			ask: "tool",
			text: JSON.stringify({ tool: "newFileCreated", content: "x".repeat(100_000) }),
			images: ["data:image/png;base64," + "x".repeat(100_000)],
		}
		const before = JSON.stringify(row)
		const projected = projectChatMessage(row)
		expect(JSON.parse(projected.text!).tool).toBe("newFileCreated")
		expect(projected.images).toEqual(row.images)
		expect(projected.text).toBe(row.text)
		expect(projected.uiTruncated).toBeUndefined()
		expect(JSON.stringify(row)).toBe(before)
	})

	it("preserves wide nested JSON and incomplete streams", () => {
		for (const text of [
			JSON.stringify(Array.from({ length: 1000 }, () => ({ value: "x".repeat(5000) }))),
			'{"tool":"readFile","content":"' + "x".repeat(100_000),
		]) {
			const projected = projectChatMessage({ ts: 1, type: "say", say: "mcp_server_response", text })
			expect(projected.text).toBe(text)
			expect(projected.uiTruncated).toBeUndefined()
		}
	})

	it("finds pinned rows outside the live window", () => {
		const rows = history(1000)
		rows[2].pinned = true
		const page = projectHistoryPage("task", rows, { pinnedOnly: true })
		expect(page.messages.map((row) => row.ts)).toEqual([2])
	})
})
