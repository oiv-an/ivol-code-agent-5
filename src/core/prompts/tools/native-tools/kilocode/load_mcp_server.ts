import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "load_mcp_server",
		description:
			"Load the tools of one connected MCP server listed under MCP SERVERS. MCP tool schemas are not sent until their server is loaded, to keep requests small. Call this once before using a server; its tools (named mcp--{server}--{tool}) become available from your next request and stay loaded for the rest of the task. Returns the server's instructions and tool list.",
		parameters: {
			type: "object",
			properties: {
				server_name: { type: "string", description: "Exact MCP server name from the MCP SERVERS list." },
			},
			required: ["server_name"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
