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

		it("uses the complete default prompt for unset or blank overrides", () => {
			expect(getIntelligentContextResetPrompt(undefined)).toBe(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT)
			expect(getIntelligentContextResetPrompt("   ")).toBe(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT)
			expect(getIntelligentContextResetPrompt("Custom snapshot prompt")).toBe("Custom snapshot prompt")
			expect(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT).toContain("current task goal")
			expect(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT).toContain("exact next action")
			expect(DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT).toContain("Do not include hidden chain-of-thought")
		})
	})
})
