// kilocode_change - new file
import { ToolArgs } from "../types"

export function getFreezeMessagesDescription(_args: ToolArgs): string {
	return `## freeze_messages
Description: Keeps specific messages in your context permanently.

Every message you receive starts with its number, like \`[#42]\`. Context condensing still runs
normally over the whole conversation, but a frozen message is delivered to you again in every
request that follows, until it is unfrozen. Use it for the things you must not forget as the task
grows long: the user's actual requirement, an explicit decision or correction, a constraint that
would be expensive to rediscover.

Freeze deliberately and sparingly - frozen messages occupy context that would otherwise hold recent
work. Long tool output and file dumps are usually a poor choice; the decision you drew from them is
a good one. Unfreeze what is no longer relevant, and unfreeze whatever the user asks you to, then
report what you released.

Parameters:
- messages: (required) The message numbers, for example \`42\` or \`42, 47, 51\`. \`#\` is optional.
- action: (optional) \`freeze\` (default) or \`unfreeze\`.

Usage:
<freeze_messages>
<messages>Message numbers here</messages>
<action>freeze or unfreeze</action>
</freeze_messages>

Example: keeping the user's requirement available for the rest of a long task

<freeze_messages>
<messages>12, 18</messages>
<action>freeze</action>
</freeze_messages>

Example: releasing a message the user asked you to unfreeze

<freeze_messages>
<messages>20</messages>
<action>unfreeze</action>
</freeze_messages>`
}
