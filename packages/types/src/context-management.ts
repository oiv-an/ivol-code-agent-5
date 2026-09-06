/**
 * Context Management Types
 *
 * This module provides type definitions for context management events.
 * These events are used to handle different strategies for managing conversation context
 * when approaching token limits.
 *
 * Event Types:
 * - `condense_context`: Context was condensed using AI summarization
 * - `condense_context_error`: An error occurred during context condensation
 * - `sliding_window_truncation`: Context was truncated using sliding window strategy
 */

/**
 * Array of all context management event types.
 * Used for runtime type checking.
 */
export const CONTEXT_MANAGEMENT_EVENTS = [
	"condense_context",
	"condense_context_error",
	"sliding_window_truncation",
] as const

/**
 * Union type representing all possible context management event types.
 */
export type ContextManagementEvent = (typeof CONTEXT_MANAGEMENT_EVENTS)[number]

export const DEFAULT_INTELLIGENT_CONTEXT_RESET_ENABLED = true

export const DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT = `Create a large, complete working-state snapshot that lets another model continue the current task immediately after the context reset. Completeness and operational continuity are more important than brevity.

Include all of the following when applicable:
1. The current task goal and the user's exact intent.
2. Explicit requirements, constraints, non-goals, permissions, and user preferences that still apply.
3. What has already been completed, including observed outcomes rather than assumptions.
4. The current state of the workspace, application, task, and any relevant external systems.
5. Important decisions and their practical reasons or tradeoffs.
6. Relevant files, paths, code symbols, APIs, data structures, and concrete changes already made.
7. Commands, tests, checks, results, exact errors, failed approaches, and unresolved diagnostics.
8. All unfinished work, blockers, open questions, and the exact next action to take.

Preserve concrete names, paths, versions, values, identifiers, and exact error messages whenever they are needed to continue safely. Clearly distinguish verified facts from hypotheses. Do not include hidden chain-of-thought, private reasoning, reasoning tokens, or thought signatures. Include only useful working conclusions and concise user-visible rationale. Never include credentials, API keys, tokens, cookies, or other secrets.

Output only the snapshot body.`

/** Treat an unset persisted value as enabled for both existing and new installations. */
export function isIntelligentContextResetEnabled(value: boolean | undefined): boolean {
	return value ?? DEFAULT_INTELLIGENT_CONTEXT_RESET_ENABLED
}

/** Resolve an unset or blank override to the complete built-in snapshot prompt. */
export function getIntelligentContextResetPrompt(value: string | undefined): string {
	return value?.trim() || DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT
}

/**
 * Type guard function to check if a value is a valid context management event.
 */
export function isContextManagementEvent(value: unknown): value is ContextManagementEvent {
	return typeof value === "string" && (CONTEXT_MANAGEMENT_EVENTS as readonly string[]).includes(value)
}
