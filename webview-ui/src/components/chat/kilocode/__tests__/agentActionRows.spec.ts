// kilocode_change - new file
import type { ClineMessage } from "@roo-code/types"
import { filterAgentActionRows, isAgentActionRow } from "../agentActionRows"

const row = (ts: number, extra: Partial<ClineMessage>): ClineMessage => ({ ts, type: "say", ...extra }) as ClineMessage

const text = row(1, { say: "text", text: "hello" })
const command = row(2, { type: "ask", ask: "command", text: "ls -la" })
const read = row(3, { type: "ask", ask: "tool", text: JSON.stringify({ tool: "readFile", path: "a.ts" }) })
const edit = row(4, { type: "ask", ask: "tool", text: JSON.stringify({ tool: "appliedDiff", path: "a.ts" }) })
const mcp = row(5, { type: "ask", ask: "use_mcp_server", text: "{}" })

describe("agentActionRows", () => {
	it("classifies commands, read tools and MCP calls as actions, but not edits or text", () => {
		expect([text, command, read, edit, mcp].map(isAgentActionRow)).toEqual([false, true, true, false, true])
	})

	it("keeps every row when actions are shown", () => {
		const all = [text, command, read, edit, mcp]
		expect(filterAgentActionRows(all, true)).toBe(all)
	})

	it("hides actions when the toggle is off but keeps edits and the pending last row", () => {
		expect(filterAgentActionRows([text, command, read, edit, mcp], false)).toEqual([text, edit, mcp])
	})
})
