// kilocode_change - new file
import { collectLoadedMcpServers } from "../lazyMcp"
import { getMcpServerTools } from "../../../prompts/tools/native-tools/mcp_server"
import { getMcpServersSection } from "../../../prompts/sections/mcp-servers"

const servers = [
	{
		name: "browseros-neo",
		status: "connected",
		config: "{}",
		instructions: "BrowserOS neo — the browser for agents. Lots of further text that must not be in the summary.",
		tools: [
			{ name: "tabs", description: "Manage tabs", inputSchema: { type: "object" } },
			{ name: "navigate", description: "Navigate", inputSchema: { type: "object" } },
		],
	},
	{
		name: "peekaboo",
		status: "connected",
		config: "{}",
		tools: [{ name: "see", description: "Screenshot", inputSchema: { type: "object" } }],
	},
]

const hub: any = {
	getServers: () => servers,
	findServerNameBySanitizedName: (name: string) =>
		servers.find((s) => s.name.replace(/-/g, "___") === name || s.name === name)?.name ?? null,
}

describe("lazy MCP", () => {
	it("collects servers from native MCP calls and load_mcp_server calls", () => {
		const history = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "1", name: "mcp--browseros___neo--tabs", input: {} }],
			},
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "2", name: "load_mcp_server", input: { server_name: "Peekaboo" } }],
			},
		]
		expect([...collectLoadedMcpServers(history, hub)].sort()).toEqual(["browseros-neo", "peekaboo"])
	})

	it("ignores unknown servers and keeps the set append-only", () => {
		const into = new Set(["peekaboo"])
		collectLoadedMcpServers(
			[{ role: "assistant", content: [{ type: "tool_use", name: "mcp--nope--x", input: {} }] }],
			hub,
			into,
		)
		expect([...into]).toEqual(["peekaboo"])
	})

	it("sends schemas only for loaded servers", () => {
		const names = (set?: Set<string>) => getMcpServerTools(hub, set).map((tool: any) => tool.function.name)
		expect(names()).toHaveLength(3)
		expect(names(new Set())).toEqual([])
		expect(names(new Set(["peekaboo"]))).toEqual(["mcp--peekaboo--see"])
	})

	it("renders a short, load-independent server list in lazy native mode", async () => {
		const section = await getMcpServersSection(hub, undefined, false, false, true)
		expect(section).toContain("load_mcp_server")
		expect(section).toContain("- browseros-neo (2 tools): BrowserOS neo — the browser for agents.")
		expect(section).toContain("- peekaboo (1 tools)")
		expect(section).not.toContain("Lots of further text")
		expect(section).not.toContain("### Instructions")
	})
})
