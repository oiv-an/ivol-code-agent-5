import { BaseTool, type ToolCallbacks } from "../BaseTool"
import type { Task } from "../../task/Task"

interface Params {
	server_name: string
}

const MAX_TOOL_DESCRIPTION = 300

/**
 * Lazy MCP: marks one connected MCP server as loaded for this task. Its tool schemas are
 * included from the next request on (append-only, so the prompt cache stays stable).
 */
export class LoadMcpServerTool extends BaseTool<"load_mcp_server"> {
	readonly name = "load_mcp_server" as const

	parseLegacy(params: Partial<Record<string, string>>): Params {
		return { server_name: params.server_name ?? "" }
	}

	async execute(params: Params, task: Task, { pushToolResult }: ToolCallbacks): Promise<void> {
		const requested = typeof params.server_name === "string" ? params.server_name.trim() : ""
		const mcpHub = task.providerRef.deref()?.getMcpHub()
		const servers = mcpHub?.getServers().filter((server) => server.status === "connected") ?? []
		const server =
			servers.find((s) => s.name === requested) ??
			servers.find((s) => s.name.toLowerCase() === requested.toLowerCase()) ??
			(mcpHub ? servers.find((s) => s.name === mcpHub.findServerNameBySanitizedName(requested)) : undefined)

		if (!server) {
			task.consecutiveMistakeCount++
			pushToolResult(
				`MCP server "${requested}" is not connected. Connected servers: ${servers.map((s) => s.name).join(", ") || "(none)"}.`,
			)
			return
		}

		task.consecutiveMistakeCount = 0
		const alreadyLoaded = task.loadedMcpServers.has(server.name)
		task.loadedMcpServers.add(server.name)

		const tools = (server.tools ?? []).filter((tool) => tool.enabledForPrompt !== false)
		const toolList = tools
			.map((tool) => {
				const description = (tool.description ?? "").replace(/\s+/g, " ").trim()
				return `- ${tool.name}${description ? `: ${description.slice(0, MAX_TOOL_DESCRIPTION)}${description.length > MAX_TOOL_DESCRIPTION ? "…" : ""}` : ""}`
			})
			.join("\n")

		pushToolResult(
			`MCP server "${server.name}" ${alreadyLoaded ? "was already loaded" : "is now loaded"}. ` +
				`Its tools are callable as native tools named mcp--{server}--{tool} from your next request and stay loaded for this task.` +
				(server.instructions ? `\n\n### Instructions\n${server.instructions}` : "") +
				`\n\n### Tools (${tools.length})\n${toolList || "(no tools)"}`,
		)
	}
}

export const loadMcpServerTool = new LoadMcpServerTool()
