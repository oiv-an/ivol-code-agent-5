import { telegramFailure } from "./startupFailure"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { TelegramMcpTransport } from "./TelegramMcpTransport"
import { JsonLineConnection } from "./JsonLineConnection"
import { telegramCoordinatorRequestSchema, type TelegramCoordinatorRequest } from "./protocol"

/** Private plugin control plane. Not registered in the agent's model-visible MCP hub. */
export async function connectTelegramMcpServer(
	peer: JsonLineConnection,
	execute: (request: TelegramCoordinatorRequest) => Promise<unknown>,
): Promise<Server> {
	const server = new Server({ name: "ivol-telegram", version: "1.0.0" }, { capabilities: { tools: {} } })
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: "telegram_control",
				description:
					"Control the plugin's explicitly activated Telegram task connection. No task creation or opening is supported.",
				inputSchema: {
					type: "object",
					properties: {
						operation: {
							type: "string",
							enum: [
								"activate",
								"activateProject",
								"deactivateProject",
								"projectSend",
								"deactivate",
								"heartbeat",
								"publish",
								"publishImage",
								"invalidateApproval",
							],
						},
					},
					required: ["operation"],
				},
			},
		],
	}))
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		if (request.params.name !== "telegram_control") throw new Error("Unknown Telegram control tool")
		const parsed = telegramCoordinatorRequestSchema.safeParse(request.params.arguments)
		if (!parsed.success) throw new Error("Invalid Telegram control request")
		try {
			const result = await execute(parsed.data)
			return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null) }] }
		} catch (error) {
			const failure = telegramFailure(error, "operation")
			return {
				isError: true,
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ reason: failure.reason, stage: failure.stage, code: failure.code }),
					},
				],
			}
		}
	})
	await server.connect(new TelegramMcpTransport(peer))
	return server
}
