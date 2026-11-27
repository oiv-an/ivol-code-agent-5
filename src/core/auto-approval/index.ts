import {
	type ClineAsk,
	type ClineSayTool,
	type McpServerUse,
	type FollowUpData,
	type ExtensionState,
	isNonBlockingAsk,
} from "@roo-code/types"

import { ClineAskResponse } from "../../shared/WebviewMessage"

import { isWriteToolAction, isReadOnlyToolAction } from "./tools"
import { isMcpToolAlwaysAllowed, isMcpServerAlwaysAllowed } from "./mcp" // kilocode_change
import { getCommandDecision } from "./commands"

// We have 11 different actions that can be auto-approved. // kilocode_change
export type AutoApprovalState =
	| "alwaysAllowReadOnly"
	| "alwaysAllowWrite"
	| "alwaysAllowDelete" // kilocode_change
	| "alwaysAllowBrowser"
	| "alwaysAllowMcp"
	| "alwaysAllowModeSwitch"
	| "alwaysAllowSubtasks"
	| "alwaysAllowExecute"
	| "alwaysAllowFollowupQuestions"

// Some of these actions have additional settings associated with them.
export type AutoApprovalStateOptions =
	| "autoApprovalEnabled"
	| "alwaysAllowReadOnlyOutsideWorkspace" // For `alwaysAllowReadOnly`.
	| "alwaysAllowWriteOutsideWorkspace" // For `alwaysAllowWrite`.
	| "alwaysAllowWriteProtected"
	| "blockReadOutsideWorkspace" // kilocode_change
	| "blockWriteOutsideWorkspace" // kilocode_change
	| "alwaysAllowAllCommands" // kilocode_change
	| "followupAutoApproveTimeoutMs" // For `alwaysAllowFollowupQuestions`.
	| "mcpServers" // For `alwaysAllowMcp`.
	| "allowedCommands" // For `alwaysAllowExecute`.
	| "deniedCommands"

export type CheckAutoApprovalResult =
	| { decision: "approve" }
	| { decision: "deny"; reason?: string } // kilocode_change: reason is returned to the model
	| { decision: "ask" }
	| {
			decision: "timeout"
			timeout: number
			fn: () => { askResponse: ClineAskResponse; text?: string; images?: string[] }
	  }

export async function checkAutoApproval({
	state,
	ask,
	text,
	isProtected,
}: {
	state?: Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>
	ask: ClineAsk
	text?: string
	isProtected?: boolean
}): Promise<CheckAutoApprovalResult> {
	if (isNonBlockingAsk(ask)) {
		return { decision: "approve" }
	}

	// kilocode_change: project bans apply regardless of auto-approval, YOLO or manual approval.
	const blocked = getOutsideWorkspaceBlock(state, ask, text)
	if (blocked) return { decision: "deny", reason: blocked }

	// kilocode_change start: per-project consent to every command; only explicitly denied commands still stop
	if (ask === "command" && text && state?.alwaysAllowAllCommands === true) {
		return getCommandDecision(text, ["*"], state.deniedCommands || []) === "auto_deny"
			? { decision: "deny" }
			: { decision: "approve" }
	}
	// kilocode_change end

	if (!state || !state.autoApprovalEnabled) {
		return { decision: "ask" }
	}

	if (ask === "followup") {
		if (state.alwaysAllowFollowupQuestions === true) {
			try {
				const suggestion = (JSON.parse(text || "{}") as FollowUpData).suggest?.[0]

				if (
					suggestion &&
					typeof state.followupAutoApproveTimeoutMs === "number" &&
					state.followupAutoApproveTimeoutMs > 0
				) {
					return {
						decision: "timeout",
						timeout: state.followupAutoApproveTimeoutMs,
						fn: () => ({ askResponse: "messageResponse", text: suggestion.answer }),
					}
				} else {
					return { decision: "ask" }
				}
			} catch (error) {
				return { decision: "ask" }
			}
		} else {
			return { decision: "ask" }
		}
	}

	if (ask === "browser_action_launch") {
		return state.alwaysAllowBrowser === true ? { decision: "approve" } : { decision: "ask" }
	}

	if (ask === "use_mcp_server") {
		if (!text) {
			return { decision: "ask" }
		}
		// kilocode_change: protected MCP calls (BrowserOS scripts) always need a manual decision.
		if (isProtected) {
			return { decision: "ask" }
		}

		try {
			const mcpServerUse = JSON.parse(text) as McpServerUse

			// kilocode_change start: explicit server trust needs only the master switch, checked above.
			if (
				(mcpServerUse.type === "use_mcp_tool" && mcpServerUse.toolName) ||
				(mcpServerUse.type === "access_mcp_resource" && mcpServerUse.uri)
			) {
				if (isMcpServerAlwaysAllowed(mcpServerUse, state.mcpServers)) return { decision: "approve" }
			}
			// kilocode_change end
			if (mcpServerUse.type === "use_mcp_tool") {
				return state.alwaysAllowMcp === true && isMcpToolAlwaysAllowed(mcpServerUse, state.mcpServers)
					? { decision: "approve" }
					: { decision: "ask" }
			} else if (mcpServerUse.type === "access_mcp_resource") {
				return state.alwaysAllowMcp === true ? { decision: "approve" } : { decision: "ask" }
			}
		} catch (error) {
			return { decision: "ask" }
		}

		return { decision: "ask" }
	}

	if (ask === "command") {
		if (!text) {
			return { decision: "ask" }
		}

		if (state.alwaysAllowExecute === true) {
			const decision = getCommandDecision(text, state.allowedCommands || [], state.deniedCommands || [])

			if (decision === "auto_approve") {
				return { decision: "approve" }
			} else if (decision === "auto_deny") {
				return { decision: "deny" }
			} else {
				return { decision: "ask" }
			}
		}
	}

	if (ask === "tool") {
		let tool: ClineSayTool | undefined

		try {
			tool = JSON.parse(text || "{}")
		} catch (error) {
			console.error("Failed to parse tool:", error)
		}

		if (!tool) {
			return { decision: "ask" }
		}

		if (tool.tool === "updateTodoList") {
			return { decision: "approve" }
		}

		if (tool?.tool === "fetchInstructions") {
			if (tool.content === "create_mode") {
				return state.alwaysAllowModeSwitch === true ? { decision: "approve" } : { decision: "ask" }
			}

			if (tool.content === "create_mcp_server") {
				return state.alwaysAllowMcp === true ? { decision: "approve" } : { decision: "ask" }
			}
		}

		if (tool?.tool === "switchMode") {
			return state.alwaysAllowModeSwitch === true ? { decision: "approve" } : { decision: "ask" }
		}

		if (["newTask", "finishTask"].includes(tool?.tool)) {
			return state.alwaysAllowSubtasks === true ? { decision: "approve" } : { decision: "ask" }
		}

		const isOutsideWorkspace = !!tool.isOutsideWorkspace

		if (isReadOnlyToolAction(tool)) {
			return state.alwaysAllowReadOnly === true &&
				(!isOutsideWorkspace || state.alwaysAllowReadOnlyOutsideWorkspace === true)
				? { decision: "approve" }
				: { decision: "ask" }
		}

		if (isWriteToolAction(tool)) {
			return state.alwaysAllowWrite === true &&
				(!isOutsideWorkspace || state.alwaysAllowWriteOutsideWorkspace === true) &&
				(!isProtected || state.alwaysAllowWriteProtected === true)
				? { decision: "approve" }
				: { decision: "ask" }
		}

		// kilocode_change start
		if (tool.tool === "deleteFile") {
			return state.alwaysAllowDelete === true ? { decision: "approve" } : { decision: "ask" }
		}
		// kilocode_change end
	}

	return { decision: "ask" }
}

// kilocode_change start
export const OUTSIDE_WORKSPACE_READ_BLOCKED =
	"Access denied: reading files outside the current project is disabled for this project. Work only with files inside the project folder."
export const OUTSIDE_WORKSPACE_WRITE_BLOCKED =
	"Access denied: changing files outside the current project is disabled for this project. Write only inside the project folder."

/** Returns the denial text when a file tool targets a path outside the project that the project bans. */
export function getOutsideWorkspaceBlock(
	state: Pick<ExtensionState, "blockReadOutsideWorkspace" | "blockWriteOutsideWorkspace"> | undefined,
	ask: ClineAsk,
	text?: string,
): string | undefined {
	if (ask !== "tool" || !text || (!state?.blockReadOutsideWorkspace && !state?.blockWriteOutsideWorkspace)) return
	let tool: ClineSayTool
	try {
		tool = JSON.parse(text)
	} catch {
		return
	}
	const outside = !!tool.isOutsideWorkspace || !!tool.batchFiles?.some((file) => file.isOutsideWorkspace)
	if (!outside) return
	if (state.blockReadOutsideWorkspace && isReadOnlyToolAction(tool)) return OUTSIDE_WORKSPACE_READ_BLOCKED
	if (state.blockWriteOutsideWorkspace && (isWriteToolAction(tool) || tool.tool === "deleteFile"))
		return OUTSIDE_WORKSPACE_WRITE_BLOCKED
	return
}
// kilocode_change end

export { AutoApprovalHandler } from "./AutoApprovalHandler"
