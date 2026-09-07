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

// kilocode_change start: task-focused handoff; recognize an unchanged saved legacy default.
const LEGACY_INTELLIGENT_CONTEXT_RESET_PROMPT = `Create a large, complete working-state snapshot that lets another model continue the current task immediately after the context reset. Completeness and operational continuity are more important than brevity.

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

export const DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT = `You are handing off the current task before context compaction.

Write or update \`CONTEXT_RESTART.md\` so that another model can read it after compaction and continue the work from the point where you stopped.

This file is a task handoff, not a conversation summary or a description of the codebase.

The project files remain available. Do not copy or retell their contents. Record only what the next model needs to understand the task, locate the relevant code, and continue execution.

Use this structure:

# Task

Describe the outcome the user requested.
Preserve the requirements, constraints, and explicit corrections that still apply.
Include outstanding requested deliverables, even if the conversation temporarily moved to a different subtask.

# Current progress

State what has actually been completed and what is currently in progress.
Distinguish changes made from changes verified.
Identify any partial implementation or unfinished edit.

# Relevant files

List only files relevant to continuing this task.

For each file, provide:

- Its exact path.
- A brief description of its role in this task.
- The relevant symbol or section, when useful.
- What still needs to change there, if anything.

Do not reproduce source code or summarize entire files.
Do not list unrelated files merely because they were inspected.

# Remaining work

List the specific unfinished actions in a useful execution order.
Preserve unresolved requirements rather than replacing them with vague instructions such as "finish the feature."

Include blockers or unanswered questions only when they affect continuation.

# Resume here

State exactly where work stopped and the first concrete action to take next.
Include the immediate verification needed, if applicable.
If an operation was started but its result is unknown, say so and require checking its outcome before repeating it.

Rules:

- Preserve important task information that exists only in the conversation.
- For information already saved in accessible project files, prefer precise references over duplication.
- Keep only decisions and failed approaches that materially affect the remaining work.
- Include exact commands or errors only when needed for the next steps; omit long logs.
- Do not invent completed work, successful checks, file contents, or user decisions.
- When updating an existing handoff, preserve still-unfinished obligations and replace outdated state.
- Be concise without omitting information necessary to continue.
- Use the user's working language; preserve paths, symbols, and commands exactly.
- Do not include secrets or private reasoning.
- Do not continue the underlying task or modify project code during this step. Only save the handoff file.`
// kilocode_change end

/** Treat an unset persisted value as enabled for both existing and new installations. */
export function isIntelligentContextResetEnabled(value: boolean | undefined): boolean {
	return value ?? DEFAULT_INTELLIGENT_CONTEXT_RESET_ENABLED
}

// kilocode_change start
/** Refresh an unchanged legacy default while preserving deliberate custom instructions. */
export function getIntelligentContextResetPrompt(value: string | undefined): string {
	const prompt = value?.trim()
	if (!prompt || prompt.replace(/\r\n/g, "\n") === LEGACY_INTELLIGENT_CONTEXT_RESET_PROMPT) {
		return DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT
	}
	return prompt
}
// kilocode_change end

/**
 * Type guard function to check if a value is a valid context management event.
 */
export function isContextManagementEvent(value: unknown): value is ContextManagementEvent {
	return typeof value === "string" && (CONTEXT_MANAGEMENT_EVENTS as readonly string[]).includes(value)
}
