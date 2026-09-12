// kilocode_change - new file
import type OpenAI from "openai"

const FREEZE_MESSAGES_DESCRIPTION = `Keeps specific messages in your context permanently.

Every message you receive starts with its number, like [#42]. Context condensing still runs normally over the whole conversation, but a frozen message is delivered to you again in every request that follows, until it is unfrozen. Use it for the things you must not forget as the task grows long: the user's actual requirement, an explicit decision or correction, a constraint that would be expensive to rediscover.

Freeze deliberately and sparingly - frozen messages occupy context that would otherwise hold recent work. Long tool output and file dumps are usually a poor choice; the decision you drew from them is a good one. Unfreeze what is no longer relevant, and unfreeze whatever the user asks you to, then report what you released.

Example: keeping the user's requirement available for the rest of a long task
{ "messages": "12, 18", "action": "freeze" }

Example: releasing a message the user asked you to unfreeze
{ "messages": "20", "action": "unfreeze" }`

const freezeMessages = {
	type: "function",
	function: {
		name: "freeze_messages",
		description: FREEZE_MESSAGES_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				messages: {
					type: "string",
					description:
						'The message numbers to act on, for example "42" or "42, 47, 51". The leading # is optional.',
				},
				action: {
					type: "string",
					enum: ["freeze", "unfreeze"],
					description: 'Whether to freeze the messages or release them. Defaults to "freeze".',
				},
			},
			required: ["messages"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool

export default freezeMessages
