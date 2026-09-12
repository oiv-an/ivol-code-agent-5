// kilocode_change - new file
/**
 * Freezes messages in the model's own context.
 *
 * Condensing keeps working exactly as before: it runs over the whole conversation and writes the
 * summary from the complete picture. A frozen message is simply delivered again in every request
 * that follows, until the mark is removed - so a requirement or a decision stops being forgotten
 * just because it got old.
 *
 * Messages are addressed by the `[#N]` number the model sees in front of every message.
 */

import { ToolUse, AskApproval, HandleError, PushToolResult, RemoveClosingTag } from "../../../shared/tools"
import { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import {
	MAX_PINNED_MESSAGES,
	checkPinnedBudget,
	getPinnedMessages,
	normalizePinnedBudgetPercent,
} from "../../kilocode/context-pinning"
import { resolveSeqNumbers } from "../../kilocode/context-pinning/numbering"

/**
 * The opening words of a message, for confirming which one was acted on.
 *
 * A number alone is not proof: if the model and the chat ever disagree about what "#6" means, an
 * answer of "Froze #6" hides the mistake, while a quoted line makes it obvious to both the model
 * and the user reading along.
 */
export function messagePreview(content: unknown, limit = 90): string {
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter(
							(block): block is { type: "text"; text: string } =>
								typeof block === "object" &&
								block !== null &&
								(block as { type?: string }).type === "text" &&
								typeof (block as { text?: unknown }).text === "string",
						)
						.map((block) => block.text)
						.join(" ")
				: ""

	// The number prefix is added when the request is built, so strip it: quoting it back would be
	// circular and tells the reader nothing about the content.
	const cleaned = text.replace(/^\[#\d+\]\s*/, "").trim()
	if (!cleaned) return ""

	const collapsed = cleaned.replace(/\s+/g, " ")
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit).trimEnd()}…`
}

/** Accepts "12", "#12", "12, 15" and "[#12]" - models quote numbers in all of these shapes. */
export function parseMessageNumbers(raw: string | undefined): { numbers: number[]; invalid: string[] } {
	const numbers: number[] = []
	const invalid: string[] = []

	if (!raw) return { numbers, invalid }

	for (const token of raw.split(/[,\s]+/).filter(Boolean)) {
		const match = token.match(/^\[?#?(\d+)\]?$/)
		if (!match) {
			invalid.push(token)
			continue
		}
		const value = Number.parseInt(match[1], 10)
		if (Number.isFinite(value) && value > 0 && !numbers.includes(value)) {
			numbers.push(value)
		}
	}

	return { numbers, invalid }
}

export const freezeMessagesTool = async (
	cline: Task,
	block: ToolUse,
	_askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
) => {
	const rawMessages = block.params.messages
	const rawAction = block.params.action

	try {
		if (block.partial) {
			await cline.say("text", removeClosingTag("messages", rawMessages), undefined, block.partial).catch(() => {})
			return
		}

		if (!rawMessages) {
			cline.consecutiveMistakeCount++
			pushToolResult(await cline.sayAndCreateMissingParamError("freeze_messages", "messages"))
			return
		}

		const action = (rawAction ?? "freeze").trim().toLowerCase()
		if (action !== "freeze" && action !== "unfreeze") {
			cline.consecutiveMistakeCount++
			pushToolResult(formatResponse.toolError(`Unknown action '${action}'. Use "freeze" or "unfreeze".`))
			return
		}
		const freezing = action === "freeze"

		const { numbers, invalid } = parseMessageNumbers(rawMessages)
		if (numbers.length === 0) {
			cline.consecutiveMistakeCount++
			pushToolResult(
				formatResponse.toolError(
					`No message number could be read from '${rawMessages}'. Use the [#N] numbers shown in front of each message, for example "42" or "42, 47".`,
				),
			)
			return
		}

		cline.consecutiveMistakeCount = 0

		// The budget is only a concern when adding marks; releasing them always frees room.
		if (freezing) {
			const alreadyFrozen = getPinnedMessages(cline.apiConversationHistory).length
			if (alreadyFrozen + numbers.length > MAX_PINNED_MESSAGES) {
				pushToolResult(
					formatResponse.toolError(
						`This task already has ${alreadyFrozen} frozen messages and the limit is ${MAX_PINNED_MESSAGES}. Unfreeze something that is no longer relevant first.`,
					),
				)
				return
			}
		}

		const { found, missing } = resolveSeqNumbers(cline.apiConversationHistory, numbers)

		const changed: number[] = []
		const changedTs: number[] = []
		const unchanged: number[] = []
		// Quoting the message back is what lets the model - and the user reading the chat - confirm
		// that the number landed on the message they meant.
		const previews = new Map<number, string>()

		for (const { seq, ts } of found) {
			const target = cline.apiConversationHistory.find((message) => message.ts === ts)
			const preview = target ? messagePreview(target.content) : ""
			if (preview) previews.set(seq, preview)

			const change = await cline.setMessagePinned(ts, freezing, "model")
			if (change) {
				changed.push(seq)
				changedTs.push(ts)
			} else {
				// No change means it was already in the requested state.
				unchanged.push(seq)
			}
		}

		const describe = (seq: number): string => {
			const preview = previews.get(seq)
			return preview ? `#${seq} ("${preview}")` : `#${seq}`
		}

		// The token budget can only be measured once the marks are applied, so an overflow is undone
		// again. Refusing after the fact is still better than silently blowing the context window.
		let budgetRefused: string | undefined
		if (freezing && changed.length > 0 && cline.api) {
			try {
				const provider = cline.providerRef?.deref()
				const state = await provider?.getState()
				const budgetPercent = normalizePinnedBudgetPercent(state?.frozenMessagesBudgetPercent)
				const contextWindow = cline.api.contextWindow ?? cline.api.getModel().info.contextWindow

				if (Number.isFinite(contextWindow) && contextWindow > 0) {
					const budget = await checkPinnedBudget(
						cline.apiConversationHistory,
						contextWindow,
						budgetPercent,
						(blocks) => cline.api.countTokens(blocks),
					)

					if (!budget.withinBudget) {
						for (const ts of changedTs) {
							await cline.setMessagePinned(ts, false, "model")
						}
						budgetRefused = `Frozen messages would take ${budget.pinnedTokens} tokens, above the ${budget.allowedTokens} allowed (${budgetPercent}% of the context window). Nothing was frozen - unfreeze something older first.`
						changed.length = 0
					}
				}
			} catch (budgetError) {
				// Counting tokens is a provider call and may fail; that must not block freezing.
				console.warn("freeze_messages: skipping budget check", budgetError)
			}
		}

		const lines: string[] = []
		const verb = freezing ? "Froze" : "Unfroze"
		const state = freezing ? "frozen" : "not frozen"

		if (budgetRefused) {
			lines.push(budgetRefused)
		}

		if (changed.length > 0) {
			lines.push(
				freezing
					? `${verb} ${changed.map(describe).join(", ")}. These messages stay in context until unfrozen.`
					: `${verb} ${changed.map(describe).join(", ")}. They are no longer pinned to the context.`,
			)
		}
		if (unchanged.length > 0) {
			lines.push(`Already ${state}: ${unchanged.map(describe).join(", ")}.`)
		}
		if (missing.length > 0) {
			lines.push(`No message found for: ${missing.map((seq) => `#${seq}`).join(", ")}.`)
		}
		if (invalid.length > 0) {
			lines.push(`Could not read as a message number: ${invalid.join(", ")}.`)
		}

		const total = getPinnedMessages(cline.apiConversationHistory).length
		lines.push(`${total} message${total === 1 ? "" : "s"} frozen in total.`)

		pushToolResult(formatResponse.toolResult(lines.join("\n")))
	} catch (error) {
		await handleError("freezing messages", error)
	}
}
