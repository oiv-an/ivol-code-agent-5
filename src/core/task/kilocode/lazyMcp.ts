// kilocode_change - new file
import { normalizeMcpToolName, parseMcpToolName } from "../../../utils/mcp-name"

interface ServerResolver {
	getServers(): Array<{ name: string }>
	findServerNameBySanitizedName(sanitizedName: string): string | null | undefined
}

type HistoryMessage = { role?: string; content?: unknown }

/**
 * Lazy MCP: collects the servers already used in this task (native MCP tool calls or
 * load_mcp_server calls) so their schemas stay loaded after resume or condensation.
 * The set is append-only, which keeps the tools array stable for prompt caching.
 */
export function collectLoadedMcpServers(
	history: readonly HistoryMessage[],
	resolver: ServerResolver | undefined,
	into: Set<string> = new Set(),
): Set<string> {
	if (!resolver) return into
	const serverNames = new Set(resolver.getServers().map((server) => server.name))
	const resolve = (name: string | undefined): string | undefined => {
		if (!name) return undefined
		if (serverNames.has(name)) return name
		const lower = name.toLowerCase()
		for (const serverName of serverNames) if (serverName.toLowerCase() === lower) return serverName
		return resolver.findServerNameBySanitizedName(name) ?? undefined
	}

	for (const message of history) {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue
		for (const block of message.content as Array<Record<string, any>>) {
			if (block?.type !== "tool_use" || typeof block.name !== "string") continue
			let server: string | undefined
			if (block.name === "load_mcp_server" || block.name === "use_mcp_tool") {
				server = resolve(block.input?.server_name)
			} else {
				const parsed = parseMcpToolName(normalizeMcpToolName(block.name))
				server = resolve(parsed?.serverName)
			}
			if (server) into.add(server)
		}
	}
	return into
}
