// kilocode_change - new file
/**
 * Context pinning
 *
 * A pinned message is an explicit "keep this" mark. Context condensing and sliding-window
 * truncation both skip pinned messages, so an important decision or requirement stays visible to
 * the model no matter how old it becomes. Retention stops being a question of recency.
 *
 * Pinning a message that was already hidden brings it back: condensing and truncation are
 * non-destructive, they only tag a message with `condenseParent` / `truncationParent` and
 * `getEffectiveApiHistory()` filters it out because of that tag. Clearing the tag restores the
 * message in the very next request.
 *
 * Tool blocks are the one hard constraint. Every `tool_use` requires a matching `tool_result`, so a
 * restore always covers the whole pair - never one half of it.
 */

import type Anthropic from "@anthropic-ai/sdk"

import type { ApiMessage } from "../../task-persistence/apiMessages"

/** Share of the context window that pinned messages may occupy before pinning is refused. */
export const DEFAULT_PINNED_BUDGET_PERCENT = 50

/** Upper bound on marks per task. Prevents a runaway loop from pinning the whole conversation. */
export const MAX_PINNED_MESSAGES = 100

export type PinnedBy = "model" | "user"

export type PinTarget = {
	/** Timestamp of the message as shown in the chat. */
	ts: number
	note?: string
}

export type PinChange = {
	ts: number
	/** The message had been hidden by condensing or truncation and is now back in the context. */
	restored: boolean
	/** Timestamps of tool-pair partners that had to be restored together with the target. */
	restoredPartners: number[]
}

export type PinResult = {
	messages: ApiMessage[]
	changes: PinChange[]
	/** Targets that matched no message, or were already in the requested state. */
	skipped: Array<{ ts: number; reason: "not-found" | "already-pinned" | "not-pinned" }>
}

function contentBlocks(message: ApiMessage): Anthropic.Messages.ContentBlockParam[] {
	return typeof message.content === "string" ? [] : (message.content ?? [])
}

function toolUseIds(message: ApiMessage): string[] {
	return contentBlocks(message)
		.filter((block): block is Anthropic.Messages.ToolUseBlockParam => block.type === "tool_use")
		.map((block) => block.id)
}

function toolResultIds(message: ApiMessage): string[] {
	return contentBlocks(message)
		.filter((block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result")
		.map((block) => block.tool_use_id)
}

/** True when the message is currently hidden from the API by condensing or truncation. */
export function isHidden(message: ApiMessage): boolean {
	return Boolean(message.condenseParent || message.truncationParent)
}

/**
 * Collects every index that must be restored together with `startIndex` so that no tool_use is left
 * without its tool_result and no tool_result without its tool_use.
 */
export function collectToolPairIndices(messages: ApiMessage[], startIndex: number): Set<number> {
	const selected = new Set<number>([startIndex])
	const queue = [startIndex]

	while (queue.length > 0) {
		const index = queue.pop()!
		const message = messages[index]
		if (!message) continue

		const wantedUseIds = new Set(toolResultIds(message))
		const wantedResultIds = new Set(toolUseIds(message))
		if (wantedUseIds.size === 0 && wantedResultIds.size === 0) continue

		for (let i = 0; i < messages.length; i++) {
			if (selected.has(i)) continue
			const candidate = messages[i]
			const matchesUse = toolUseIds(candidate).some((id) => wantedUseIds.has(id))
			const matchesResult = toolResultIds(candidate).some((id) => wantedResultIds.has(id))
			if (matchesUse || matchesResult) {
				selected.add(i)
				queue.push(i)
			}
		}
	}

	return selected
}

function clearHiddenTags(message: ApiMessage): ApiMessage {
	const { condenseParent: _condenseParent, truncationParent: _truncationParent, ...rest } = message
	return { ...rest, pinRestored: true } as ApiMessage
}

/**
 * Applies a keep mark to the given targets.
 *
 * A target that is currently hidden is brought back into the effective history together with its
 * tool-pair partners. The partners are restored but not marked themselves: removing the mark from
 * the target must not leave orphaned halves behind, and they are still ordinary messages.
 */
export function pinMessages(messages: ApiMessage[], targets: PinTarget[], by: PinnedBy): PinResult {
	const result = [...messages]
	const changes: PinChange[] = []
	const skipped: PinResult["skipped"] = []

	for (const target of targets) {
		const index = result.findIndex((message) => message.ts === target.ts)
		if (index === -1) {
			skipped.push({ ts: target.ts, reason: "not-found" })
			continue
		}
		if (result[index].pinned) {
			skipped.push({ ts: target.ts, reason: "already-pinned" })
			continue
		}

		const wasHidden = isHidden(result[index])
		const restoredPartners: number[] = []

		if (wasHidden) {
			for (const partnerIndex of collectToolPairIndices(result, index)) {
				if (!isHidden(result[partnerIndex])) continue
				result[partnerIndex] = clearHiddenTags(result[partnerIndex])
				if (partnerIndex !== index) {
					restoredPartners.push(result[partnerIndex].ts ?? partnerIndex)
				}
			}
		}

		result[index] = {
			...result[index],
			pinned: true,
			pinnedBy: by,
			pinnedAt: Date.now(),
			...(target.note ? { pinnedNote: target.note } : {}),
		}

		changes.push({ ts: target.ts, restored: wasHidden, restoredPartners })
	}

	return { messages: result, changes, skipped }
}

/**
 * Removes keep marks. Unpinning never re-hides a restored message: the model would have no way to
 * predict which request suddenly loses content, and the user can always condense again.
 */
export function unpinMessages(messages: ApiMessage[], targets: number[]): PinResult {
	const result = [...messages]
	const changes: PinChange[] = []
	const skipped: PinResult["skipped"] = []

	for (const ts of targets) {
		const index = result.findIndex((message) => message.ts === ts)
		if (index === -1) {
			skipped.push({ ts, reason: "not-found" })
			continue
		}
		if (!result[index].pinned) {
			skipped.push({ ts, reason: "not-pinned" })
			continue
		}

		const {
			pinned: _pinned,
			pinnedBy: _pinnedBy,
			pinnedNote: _pinnedNote,
			pinnedAt: _pinnedAt,
			...rest
		} = result[index]
		result[index] = rest as ApiMessage
		changes.push({ ts, restored: false, restoredPartners: [] })
	}

	return { messages: result, changes, skipped }
}

/** All currently pinned messages, oldest first. */
export function getPinnedMessages(messages: ApiMessage[]): ApiMessage[] {
	return messages.filter((message) => message.pinned)
}

export type PinBudgetCheck = {
	withinBudget: boolean
	pinnedTokens: number
	allowedTokens: number
	/** Oldest marks first - what the user or model should release to make room. */
	oldestPinned: Array<{ ts: number; note?: string }>
}

/**
 * Checks the pinned budget. Exceeding it must refuse the operation with a usable explanation;
 * silently dropping a mark or overflowing the window is not acceptable.
 */
export async function checkPinnedBudget(
	messages: ApiMessage[],
	contextWindow: number,
	budgetPercent: number,
	countTokens: (blocks: Anthropic.Messages.ContentBlockParam[]) => Promise<number>,
): Promise<PinBudgetCheck> {
	const pinned = getPinnedMessages(messages)
	const allowedTokens = Math.floor((contextWindow * budgetPercent) / 100)

	let pinnedTokens = 0
	for (const message of pinned) {
		const blocks: Anthropic.Messages.ContentBlockParam[] =
			typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? [])
		if (blocks.length > 0) {
			pinnedTokens += await countTokens(blocks)
		}
	}

	return {
		withinBudget: pinnedTokens <= allowedTokens,
		pinnedTokens,
		allowedTokens,
		oldestPinned: pinned
			.slice()
			.sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0))
			.slice(0, 5)
			.map((message) => ({ ts: message.ts ?? 0, ...(message.pinnedNote ? { note: message.pinnedNote } : {}) })),
	}
}

export function normalizePinnedBudgetPercent(value?: number | null): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_PINNED_BUDGET_PERCENT
	}
	return Math.min(Math.max(Math.round(value), 5), 90)
}
