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
				// If no response, the user accepted the condensed version
				const { contextTokens: prevContextTokens } = cline.getTokenUsage()

				await cline.runContextPreparation(async (signal) => {
					const intelligentReset = await cline.getIntelligentContextResetConfig()
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
						intelligentReset.useNativeTools,
						{
							enabled: intelligentReset.enabled,
							signal,
							prompt: intelligentReset.prompt,
							...(intelligentReset.taskDocument
								? { taskDocument: true, taskDocumentContext: cline.getTaskDocumentPreparationContext() }
								: {}),
							...(intelligentReset.enabled
								? { onBeforeRequest: cline.notifyContextHandoffPreparing }
								: {}),
						},
					)
					// Persist and verify the restart handoff before changing history.
					await cline.commitContextCondensation(
						summarizedMessages,
						"tool",
						prevContextTokens,
						intelligentReset.enabled,
					)
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
