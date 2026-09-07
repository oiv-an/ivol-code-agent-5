import { describe, it, expect } from "vitest"
import {
	CONTEXT_MANAGEMENT_EVENTS,
	DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT,
	getIntelligentContextResetPrompt,
	isContextManagementEvent,
	isIntelligentContextResetEnabled,
} from "../context-management.js"

describe("context-management", () => {
	describe("CONTEXT_MANAGEMENT_EVENTS", () => {
		it("should contain all expected event types", () => {
			expect(CONTEXT_MANAGEMENT_EVENTS).toContain("condense_context")
			expect(CONTEXT_MANAGEMENT_EVENTS).toContain("condense_context_error")
			expect(CONTEXT_MANAGEMENT_EVENTS).toContain("sliding_window_truncation")
			expect(CONTEXT_MANAGEMENT_EVENTS).toHaveLength(3)
		})
	})

	describe("isContextManagementEvent", () => {
		it("should return true for valid context management events", () => {
			expect(isContextManagementEvent("condense_context")).toBe(true)
			expect(isContextManagementEvent("condense_context_error")).toBe(true)
			expect(isContextManagementEvent("sliding_window_truncation")).toBe(true)
		})

		it("should return false for non-context-management events", () => {
			expect(isContextManagementEvent("text")).toBe(false)
			expect(isContextManagementEvent("error")).toBe(false)
			expect(isContextManagementEvent(null)).toBe(false)
			expect(isContextManagementEvent(undefined)).toBe(false)
		})
	})

	describe("intelligent context reset defaults", () => {
		it("defaults an unset enablement setting to true while preserving an explicit false", () => {
			expect(isIntelligentContextResetEnabled(undefined)).toBe(true)
			expect(isIntelligentContextResetEnabled(true)).toBe(true)
			expect(isIntelligentContextResetEnabled(false)).toBe(false)
		})

		// kilocode_change start
		it("uses the task handoff prompt for unset or blank overrides", () => {
			expect(getIntelligentContextResetPrompt(undefined)).toBe(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT)
			expect(getIntelligentContextResetPrompt("   ")).toBe(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT)
			expect(getIntelligentContextResetPrompt("Custom snapshot prompt")).toBe("Custom snapshot prompt")
			expect(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT).toContain("Write or update `CONTEXT_RESTART.md`")
			expect(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT.match(/^# .+$/gm)).toEqual([
				"# Task",
				"# Current progress",
				"# Relevant files",
				"# Remaining work",
				"# Resume here",
			])
			expect(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT).toContain(
				"This file is a task handoff, not a conversation summary",
			)
			expect(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT).toContain(
				"Do not reproduce source code or summarize entire files.",
			)
			expect(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT).toContain(
				"Distinguish changes made from changes verified.",
			)
			expect(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT).toContain("Include outstanding requested deliverables")
			expect(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT).toContain(
				"require checking its outcome before repeating it.",
			)
			expect(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT).toContain(
				"preserve still-unfinished obligations and replace outdated state.",
			)
			expect(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT).toContain("Do not include secrets or private reasoning.")
			expect(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT).toContain("Use the user's working language")
			expect(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT).toContain(
				"Do not continue the underlying task or modify project code",
			)
			expect(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT).not.toContain(
				"Completeness and operational continuity are more important than brevity",
			)
		})

		it("refreshes only an unchanged saved legacy default, never a customized prompt", () => {
			const legacyPrompt = `Create a large, complete working-state snapshot that lets another model continue the current task immediately after the context reset. Completeness and operational continuity are more important than brevity.

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
			expect(getIntelligentContextResetPrompt(legacyPrompt)).toBe(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT)
			expect(getIntelligentContextResetPrompt(`\n${legacyPrompt.replace(/\n/g, "\r\n")}\n`)).toBe(
				DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT,
			)
			const customizedPrompt = `${legacyPrompt}\nAlso preserve the user's custom deployment checklist.`
			expect(getIntelligentContextResetPrompt(customizedPrompt)).toBe(customizedPrompt)
		})
		// kilocode_change end
	})
})
