import type { McpServerUse, McpServer, McpTool } from "@roo-code/types"

// kilocode_change start: match MCP routing precedence, never inherit trust from a shadowed global server.
function findServer(mcpServerUse: McpServerUse, mcpServers: McpServer[] | undefined): McpServer | undefined {
	const matches = mcpServers?.filter((server) => server.name === mcpServerUse.serverName)
	return matches?.find((server) => server.source === "project") ?? matches?.[0]
}

export function isMcpServerAlwaysAllowed(mcpServerUse: McpServerUse, mcpServers: McpServer[] | undefined): boolean {
	const server = findServer(mcpServerUse, mcpServers)
	return server?.disabled !== true && server?.alwaysAllowAll === true
}
// kilocode_change end

export function isMcpToolAlwaysAllowed(mcpServerUse: McpServerUse, mcpServers: McpServer[] | undefined): boolean {
	if (mcpServerUse.type === "use_mcp_tool" && mcpServerUse.toolName) {
		const server = findServer(mcpServerUse, mcpServers) // kilocode_change
		if (server?.disabled) return false // kilocode_change
		const tool = server?.tools?.find((t: McpTool) => t.name === mcpServerUse.toolName)
		return tool?.alwaysAllow || false
	}

	return false
}
