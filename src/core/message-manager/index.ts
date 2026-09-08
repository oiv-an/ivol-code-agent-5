import { Task } from "../task/Task"
import { ClineMessage } from "@roo-code/types"
import { ApiMessage } from "../task-persistence/apiMessages"
import { cleanupAfterTruncation, getEffectiveApiHistory } from "../condense"
// kilocode_change start: keep the restart handoff consistent with rewound history
import { deleteContextHandoffFileIfOwned, hydratePendingContextHandoff } from "../context-management/context-handoff"
// kilocode_change end

export interface RewindOptions {
	/** Whether to include the target message in deletion (edit=true, delete=false) */
	includeTargetMessage?: boolean
	/** Skip cleanup for special cases (default: false) */
	skipCleanup?: boolean
}

interface ContextEventIds {
	condenseIds: Set<string>
	truncationIds: Set<string>
}

// kilocode_change start: identify the exact message that consumed a handoff.
// Direct assistant text completes it immediately, while a tool call completes
// only after its successful user tool_result is durable (matching Task behavior).
function messageCompletesContextHandoff(message: ApiMessage, handoffId?: string): boolean {
	if (message.isSummary) {
		return false
	}
	if (
		handoffId &&
		(message as ApiMessage & { contextHandoffContinuationForId?: string }).contextHandoffContinuationForId ===
			handoffId
	) {
		// Task records the exact durable message that completed a physical XML or
		// native handoff read (and accepted embedded-only completions).
		return true
	}

	if (typeof message.content === "string") {
		return (
			message.role === "assistant" &&
			message.content.trim().length > 0 &&
			!/^Failure: I did not provide a response\.?$/i.test(message.content.trim())
		)
	}

	if (message.role === "user") {
		return message.content.some((block) => {
			const candidate = block as unknown as { type?: string; is_error?: boolean }
			return candidate.type === "tool_result" && candidate.is_error !== true
		})
	}

	const hasToolCall = message.content.some((block) => {
		const type = (block as unknown as { type?: string }).type
		return type === "tool_use" || type === "mcp_tool_use"
	})
	if (hasToolCall) {
		return false
	}

	return message.content.some(
		(block) =>
			block.type === "text" &&
			block.text.trim().length > 0 &&
			!/^Failure: I did not provide a response\.?$/i.test(block.text.trim()),
	)
}

function findConsumingContinuationMessage(messages: ApiMessage[], summary: ApiMessage): ApiMessage | undefined {
	if (!summary.contextHandoffConsumedAt) {
		return undefined
	}

	const summaryIndex = messages.findIndex((message) => message === summary)
	if (summaryIndex === -1) {
		return undefined
	}

	const createdAt = summary.contextHandoffCreatedAt ?? Number.NEGATIVE_INFINITY
	const consumedAt = summary.contextHandoffConsumedAt
	let consumingMessage: ApiMessage | undefined

	for (let index = summaryIndex + 1; index < messages.length; index++) {
		const message = messages[index]
		if (!messageCompletesContextHandoff(message, summary.contextHandoffId)) {
			continue
		}

		if (message.ts === undefined || (message.ts >= createdAt && message.ts <= consumedAt)) {
			// The consumed marker is saved immediately after this continuation.
			// Choosing the last bounded candidate also handles equal-ms timestamps
			// from messages that already existed when condensation ran.
			consumingMessage = message
		}
	}

	return consumingMessage
}
// kilocode_change end

/**
 * MessageManager provides centralized handling for all conversation rewind operations.
 *
 * This ensures that whenever UI chat history is rewound (delete, edit, checkpoint restore, etc.),
 * the API conversation history is properly maintained, including:
 * - Removing orphaned Summary messages when their condense_context is removed
 * - Removing orphaned truncation markers when their sliding_window_truncation is removed
 * - Cleaning up orphaned condenseParent/truncationParent tags
 *
 * Usage (always access via Task.messageManager getter):
 * ```typescript
 * await task.messageManager.rewindToTimestamp(messageTs, { includeTargetMessage: false })
 * ```
 *
 * @see Task.messageManager - The getter that provides lazy-initialized access to this manager
 */
export class MessageManager {
	constructor(private task: Task) {}

	/**
	 * Rewind conversation to a specific timestamp.
	 * This is the SINGLE entry point for all message deletion operations.
	 *
	 * @param ts - The timestamp to rewind to
	 * @param options - Rewind options
	 * @throws Error if timestamp not found in clineMessages
	 */
	async rewindToTimestamp(ts: number, options: RewindOptions = {}): Promise<void> {
		const { includeTargetMessage = false, skipCleanup = false } = options

		// Find the index in clineMessages
		const clineIndex = this.task.clineMessages.findIndex((m) => m.ts === ts)
		if (clineIndex === -1) {
			throw new Error(`Message with timestamp ${ts} not found in clineMessages`)
		}

		// Calculate the actual cutoff index
		const cutoffIndex = includeTargetMessage ? clineIndex + 1 : clineIndex

		await this.performRewind(cutoffIndex, ts, { skipCleanup })
	}

	/**
	 * Rewind conversation to a specific index in clineMessages.
	 * Keeps messages [0, toIndex) and removes [toIndex, end].
	 *
	 * @param toIndex - The index to rewind to (exclusive)
	 * @param options - Rewind options
	 */
	async rewindToIndex(toIndex: number, options: RewindOptions = {}): Promise<void> {
		const cutoffTs = this.task.clineMessages[toIndex]?.ts ?? Date.now()
		await this.performRewind(toIndex, cutoffTs, options)
	}

	/**
	 * Internal method that performs the actual rewind operation.
	 */
	private async performRewind(toIndex: number, cutoffTs: number, options: RewindOptions): Promise<void> {
		const { skipCleanup = false } = options

		// Step 1: Collect context event IDs from messages being removed
		const removedIds = this.collectRemovedContextEventIds(toIndex)

		// Step 2: Truncate clineMessages
		await this.truncateClineMessages(toIndex)

		// Step 3: Truncate and clean API history (combined with cleanup for efficiency)
		await this.truncateApiHistoryWithCleanup(cutoffTs, removedIds, skipCleanup)
	}

	/**
	 * Collect condenseIds and truncationIds from context-management events
	 * that will be removed during the rewind.
	 *
	 * This is critical for maintaining the linkage between:
	 * - condense_context (clineMessage) ↔ Summary (apiMessage)
	 * - sliding_window_truncation (clineMessage) ↔ Truncation marker (apiMessage)
	 */
	private collectRemovedContextEventIds(fromIndex: number): ContextEventIds {
		const condenseIds = new Set<string>()
		const truncationIds = new Set<string>()

		for (let i = fromIndex; i < this.task.clineMessages.length; i++) {
			const msg = this.task.clineMessages[i]

			// Collect condenseIds from condense_context events
			if (msg.say === "condense_context" && msg.contextCondense?.condenseId) {
				condenseIds.add(msg.contextCondense.condenseId)
				console.log(`[MessageManager] Found condense_context to remove: ${msg.contextCondense.condenseId}`)
			}

			// Collect truncationIds from sliding_window_truncation events
			if (msg.say === "sliding_window_truncation" && msg.contextTruncation?.truncationId) {
				truncationIds.add(msg.contextTruncation.truncationId)
				console.log(
					`[MessageManager] Found sliding_window_truncation to remove: ${msg.contextTruncation.truncationId}`,
				)
			}
		}

		return { condenseIds, truncationIds }
	}

	/**
	 * Truncate clineMessages to the specified index.
	 */
	private async truncateClineMessages(toIndex: number): Promise<void> {
		await this.task.overwriteClineMessages(this.task.clineMessages.slice(0, toIndex))
	}

	/**
	 * Truncate API history by timestamp, remove orphaned summaries/markers,
	 * and clean up orphaned tags - all in a single write operation.
	 *
	 * This combined approach:
	 * 1. Avoids multiple writes to API history
	 * 2. Only writes if the history actually changed
	 * 3. Handles both truncation and cleanup atomically
	 *
	 * Note on timestamp handling:
	 * Due to async execution during streaming, clineMessage timestamps may not
	 * perfectly align with API message timestamps. Specifically, a "user_feedback"
	 * clineMessage can have a timestamp BEFORE the assistant API message that
	 * triggered it (because tool execution happens concurrently with stream
	 * completion). To handle this race condition, we find the first API user
	 * message at or after the cutoff and use its timestamp as the actual boundary.
	 */
	private async truncateApiHistoryWithCleanup(
		cutoffTs: number,
		removedIds: ContextEventIds,
		skipCleanup: boolean,
	): Promise<void> {
		const originalHistory = this.task.apiConversationHistory
		let apiHistory = [...originalHistory]

		// Step 1: Determine the actual cutoff timestamp
		// Check if there's an API message with an exact timestamp match
		const hasExactMatch = apiHistory.some((m) => m.ts === cutoffTs)
		// Check if there are any messages before the cutoff that would be preserved
		const hasMessageBeforeCutoff = apiHistory.some((m) => m.ts !== undefined && m.ts < cutoffTs)

		let actualCutoff: number = cutoffTs

		if (!hasExactMatch && hasMessageBeforeCutoff) {
			// No exact match but there are earlier messages means we might have a race
			// condition where the clineMessage timestamp is earlier than any API message
			// due to async execution. In this case, look for the first API user message
			// at or after the cutoff to use as the actual boundary.
			// This ensures assistant messages that preceded the user's response are preserved.
			const firstUserMsgIndexToRemove = apiHistory.findIndex(
				(m) => m.ts !== undefined && m.ts >= cutoffTs && m.role === "user",
			)

			if (firstUserMsgIndexToRemove !== -1) {
				// Use the user message's timestamp as the actual cutoff
				actualCutoff = apiHistory[firstUserMsgIndexToRemove].ts!
			}
			// else: no user message found, use original cutoffTs (fallback)
		}

		// Step 2: Filter by the actual cutoff timestamp
		apiHistory = apiHistory.filter((m) => !m.ts || m.ts < actualCutoff)

		// Step 3: Remove Summaries whose condense_context was removed
		if (removedIds.condenseIds.size > 0) {
			apiHistory = apiHistory.filter((msg) => {
				if (msg.isSummary && msg.condenseId && removedIds.condenseIds.has(msg.condenseId)) {
					console.log(`[MessageManager] Removing orphaned Summary with condenseId: ${msg.condenseId}`)
					return false
				}
				return true
			})
		}

		// Step 4: Remove truncation markers whose sliding_window_truncation was removed
		if (removedIds.truncationIds.size > 0) {
			apiHistory = apiHistory.filter((msg) => {
				if (msg.isTruncationMarker && msg.truncationId && removedIds.truncationIds.has(msg.truncationId)) {
					console.log(
						`[MessageManager] Removing orphaned truncation marker with truncationId: ${msg.truncationId}`,
					)
					return false
				}
				return true
			})
		}

		// kilocode_change start: keep CONTEXT_RESTART.md aligned with rewind state.
		// Capture pending summaries that disappeared so their file can be removed
		// after history commits. For retained consumed summaries, re-arm only when
		// the exact continuation message that consumed the handoff was removed.
		const retainedHandoffIds = new Set(
			apiHistory.flatMap((message) => (message.contextHandoffId ? [message.contextHandoffId] : [])),
		)
		const removedPendingHandoffs = new Map<string, { handoffId: string; sha256: string }>()
		for (const message of originalHistory) {
			const handoffId = message.contextHandoffId
			const sha256 = message.contextHandoffSha256
			if (
				message.isSummary &&
				handoffId &&
				sha256 &&
				/^[a-f0-9]{64}$/.test(sha256) &&
				!message.contextHandoffConsumedAt &&
				!retainedHandoffIds.has(handoffId)
			) {
				removedPendingHandoffs.set(`${handoffId}.${sha256}`, { handoffId, sha256 })
			}
		}
		// Missing or malformed hashes cannot identify the saved revision safely.
		// Preserve those files rather than deleting user edits by handoff ID alone.
		const retainedMessages = new Set(apiHistory)
		let rearmedHandoff = false
		apiHistory = apiHistory.map((message) => {
			if (!message.isSummary || !message.contextHandoffId || !message.contextHandoffConsumedAt) {
				return message
			}

			const originalSummary = originalHistory.find(
				(candidate) => candidate.contextHandoffId === message.contextHandoffId,
			)
			const consumingMessage = originalSummary
				? findConsumingContinuationMessage(originalHistory, originalSummary)
				: undefined
			if (!consumingMessage || retainedMessages.has(consumingMessage)) {
				return message
			}

			rearmedHandoff = true
			return { ...message, contextHandoffConsumedAt: undefined }
		})
		// kilocode_change end

		// Step 5: Cleanup orphaned tags (unless skipped)
		if (!skipCleanup) {
			apiHistory = cleanupAfterTruncation(apiHistory)
		}

		// Only write if the history actually changed
		const historyChanged =
			apiHistory.length !== originalHistory.length || apiHistory.some((msg, i) => msg !== originalHistory[i])

		if (historyChanged) {
			await this.task.overwriteApiConversationHistory(apiHistory)
		}

		// kilocode_change start: perform file side effects only after the rewound
		// history has been persisted. Ownership checks prevent one task from
		// deleting another task's fixed workspace handoff.
		for (const { handoffId, sha256 } of removedPendingHandoffs.values()) {
			try {
				await deleteContextHandoffFileIfOwned({ workspacePath: this.task.cwd, handoffId, sha256 })
			} catch (error) {
				console.warn(`[MessageManager] Failed to remove rewound context handoff ${handoffId}:`, error)
			}
		}

		if (rearmedHandoff) {
			await hydratePendingContextHandoff({
				messages: getEffectiveApiHistory(apiHistory),
				workspacePath: this.task.cwd,
			})
		}
		// kilocode_change end
	}
}
