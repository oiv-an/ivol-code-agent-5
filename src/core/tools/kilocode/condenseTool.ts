import { ToolUse, AskApproval, HandleError, PushToolResult, RemoveClosingTag } from "../../../shared/tools"
import { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import { summarizeConversation } from "../../condense"

export const condenseTool = async (
	cline: Task,
	block: ToolUse,
	askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
) => {
	const context: string | undefined = block.params.message
	try {
		if (block.partial) {
			await cline.ask("condense", removeClosingTag("message", context), block.partial).catch(() => {})
			return
		} else {
			if (!context) {
				cline.consecutiveMistakeCount++
				pushToolResult(await cline.sayAndCreateMissingParamError("condense", "context"))
				return
			}
			cline.consecutiveMistakeCount = 0

			const { text, images } = await cline.ask("condense", context, false)

			// If the user provided a response, treat it as feedback
			if (text || images?.length) {
				await cline.say("user_feedback", text ?? "", images)
				pushToolResult(
					formatResponse.toolResult(
						`The user provided feedback on the condensed conversation summary:\n<feedback>\n${text}\n</feedback>`,
						images,
					),
				)
			} else {
				if ((await cline.getIntelligentContextResetConfig()).enabled) {
					await cline.queueOrdinaryContextPreparation("tool")
					pushToolResult(
						formatResponse.toolResult(
							"Context compression queued. Update CURRENT_TASK.md with ordinary file tools first; compression will run after the tool results are saved.",
						),
					)
					return
				}
				// If no response, the user accepted the condensed version
				const { contextTokens: prevContextTokens } = cline.getTokenUsage()

				await cline.runContextPreparation(async (signal) => {
					const { useNativeTools } = await cline.getIntelligentContextResetConfig()
					// Use summarizeConversation to create a condensed version of the conversation
					const summarizedMessages = await summarizeConversation(
						cline.apiConversationHistory,
						cline.api,
						await cline.getSystemPrompt(),
						cline.taskId,
						prevContextTokens,
						false,
						undefined,
						undefined,
						useNativeTools,
						{
							signal,
						},
					)
					// kilocode_change: CURRENT_TASK.md is saved and verified before history changes.
					await cline.commitContextCondensation(summarizedMessages, "tool", prevContextTokens)
					await cline.say(
						"condense_context",
						undefined,
						undefined,
						false,
						undefined,
						undefined,
						{ isNonInteractive: true },
						{
							summary: summarizedMessages.summary,
							cost: summarizedMessages.cost,
							newContextTokens: summarizedMessages.newContextTokens ?? 0,
							prevContextTokens,
							condenseId: summarizedMessages.condenseId,
						},
					)
				})
				// A failed preparation must never report a successful tool result.
				pushToolResult(formatResponse.toolResult(formatResponse.condense()))
			}
			return
		}
	} catch (error) {
		await handleError("condensing context window", error)
		return
	} finally {
		if (!block.partial) {
			await cline.finishContextCondensation()
		}
	}
}
