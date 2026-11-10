import { DiffStrategy } from "../../../shared/tools"
import { McpHub } from "../../../services/mcp/McpHub"

// kilocode_change start: lazy MCP — short, load-state-independent server summary (keeps prompt cache stable)
const LAZY_SUMMARY_MAX = 240

function summarizeInstructions(instructions?: string): string {
	const text = (instructions ?? "")
		.replace(/^#+\s*/gm, "")
		.replace(/\s+/g, " ")
		.trim()
	if (!text) return ""
	const sentence = text.match(/^(.{20,}?[.!?])(\s|$)/)?.[1] ?? text
	return sentence.length > LAZY_SUMMARY_MAX ? `${sentence.slice(0, LAZY_SUMMARY_MAX)}…` : sentence
}

function getLazyMcpServerList(mcpHub: McpHub): string {
	const servers = mcpHub.getServers().filter((server) => server.status === "connected")
	if (servers.length === 0) return "(No MCP servers currently connected)"
	return servers
		.map((server) => {
			const toolCount = (server.tools ?? []).filter((tool) => tool.enabledForPrompt !== false).length
			const summary = summarizeInstructions(server.instructions)
			return `- ${server.name} (${toolCount} tools)${summary ? `: ${summary}` : ""}`
		})
		.join("\n")
}
// kilocode_change end

export async function getMcpServersSection(
	mcpHub?: McpHub,
	diffStrategy?: DiffStrategy,
	enableMcpServerCreation?: boolean,
	includeToolDescriptions: boolean = true,
	lazyTools: boolean = false, // kilocode_change
): Promise<string> {
	if (!mcpHub) {
		return ""
	}

	// kilocode_change start
	if (lazyTools && !includeToolDescriptions) {
		const lazySection = `MCP SERVERS

MCP servers provide additional tools and resources. To save context, their tool schemas are not sent by default.

# Connected MCP Servers

Before using a server, call \`load_mcp_server\` with its exact name once. It returns the server's instructions and tool list, and its tools become available as native tools named \`mcp--{server_name}--{tool_name}\` from your next request, staying loaded for the rest of the task. Load only the servers the task needs. You can also access server resources using the \`access_mcp_resource\` tool.

${getLazyMcpServerList(mcpHub)}`
		return enableMcpServerCreation
			? `${lazySection}\n\n## Creating an MCP Server\n\nIf the user asks to "add a tool" by creating an MCP server, obtain detailed instructions with fetch_instructions (task: create_mcp_server).`
			: lazySection
	}
	// kilocode_change end

	const connectedServers =
		mcpHub.getServers().length > 0
			? `${mcpHub
					.getServers()
					.filter((server) => server.status === "connected")
					.map((server) => {
						// Only include tool descriptions when using XML protocol
						const tools = includeToolDescriptions
							? server.tools
									?.filter((tool) => tool.enabledForPrompt !== false)
									?.map((tool) => {
										const schemaStr = tool.inputSchema
											? `    Input Schema:
		${JSON.stringify(tool.inputSchema, null, 2).split("\n").join("\n    ")}`
											: ""

										return `- ${tool.name}: ${tool.description}\n${schemaStr}`
									})
									.join("\n\n")
							: undefined

						const templates = server.resourceTemplates
							?.map((template) => `- ${template.uriTemplate} (${template.name}): ${template.description}`)
							.join("\n")

						const resources = server.resources
							?.map((resource) => `- ${resource.uri} (${resource.name}): ${resource.description}`)
							.join("\n")

						const config = JSON.parse(server.config)

						return (
							`## ${server.name}${config.command ? ` (\`${config.command}${config.args && Array.isArray(config.args) ? ` ${config.args.join(" ")}` : ""}\`)` : ""}` +
							(server.instructions ? `\n\n### Instructions\n${server.instructions}` : "") +
							(tools ? `\n\n### Available Tools\n${tools}` : "") +
							(templates ? `\n\n### Resource Templates\n${templates}` : "") +
							(resources ? `\n\n### Direct Resources\n${resources}` : "")
						)
					})
					.join("\n\n")}`
			: "(No MCP servers currently connected)"

	// Different instructions based on protocol
	const toolAccessInstructions = includeToolDescriptions
		? `When a server is connected, you can use the server's tools via the \`use_mcp_tool\` tool, and access the server's resources via the \`access_mcp_resource\` tool.`
		: `When a server is connected, each server's tools are available as native tools with the naming pattern \`mcp_{server_name}_{tool_name}\`. For example, a tool named 'get_forecast' from a server named 'weather' would be available as \`mcp_weather_get_forecast\`. You can also access server resources using the \`access_mcp_resource\` tool.`

	const baseSection = `MCP SERVERS

The Model Context Protocol (MCP) enables communication between the system and MCP servers that provide additional tools and resources to extend your capabilities. MCP servers can be one of two types:

1. Local (Stdio-based) servers: These run locally on the user's machine and communicate via standard input/output
2. Remote (SSE-based) servers: These run on remote machines and communicate via Server-Sent Events (SSE) over HTTP/HTTPS

# Connected MCP Servers

${toolAccessInstructions}

${connectedServers}`

	if (!enableMcpServerCreation) {
		return baseSection
	}

	return (
		baseSection +
		`
## Creating an MCP Server

The user may ask you something along the lines of "add a tool" that does some function, in other words to create an MCP server that provides tools and resources that may connect to external APIs for example. If they do, you should obtain detailed instructions on this topic using the fetch_instructions tool, like this:
<fetch_instructions>
<task>create_mcp_server</task>
</fetch_instructions>`
	)
}
