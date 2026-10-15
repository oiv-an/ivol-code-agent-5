// kilocode_change - new file
import type { ClineMessage } from "@roo-code/types"

// File edits always stay visible: the toggle only concerns actions that are not edits.
const EDIT_TOOLS = new Set([
	"editedExistingFile",
	"appliedDiff",
	"newFileCreated",
	"insertContent",
	"searchAndReplace",
	"generateImage",
])

/** True for chat rows that show a non-edit agent action: commands, read/search tools, MCP and browser calls. */
export function isAgentActionRow(message: ClineMessage): boolean {
	const type = message.type === "ask" ? message.ask : message.say
	if (type === "command" || type === "use_mcp_server" || type === "browser_action") return true
	if (type !== "tool") return false
	try {
		const tool = JSON.parse(message.text || "{}")?.tool
		return typeof tool === "string" && !EDIT_TOOLS.has(tool)
	} catch {
		return false
	}
}

/**
 * Hides non-edit action rows when the user turned the action toggle off.
 * The last row is never hidden, because it may be an approval waiting for the user.
 */
export function filterAgentActionRows(messages: ClineMessage[], showActions: boolean): ClineMessage[] {
	if (showActions) return messages
	const last = messages.at(-1)
	return messages.filter((message) => message === last || !isAgentActionRow(message))
}
