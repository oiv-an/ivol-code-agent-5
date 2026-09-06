import { describe, expect, it } from "vitest"

import { reasoningEffortsSchema, resolveReasoningEffortForModel, supportsOpenAiMaxReasoningEffort } from "../model.js" // kilocode_change

// kilocode_change start: OpenAI API-level "max" reasoning effort model gating
describe("supportsOpenAiMaxReasoningEffort", () => {
	it.each([
		"1-gpt-sol",
		"gpt-5.6",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"gpt-5.6-2026-09-03",
		"gpt-5.6-sol-2026-09-03",
		"gpt-5.6-terra-2026-09-03",
		"gpt-5.6-luna-2026-09-03",
		"  GPT-5.6-SOL  ",
	])("recognizes %s", (modelId) => {
		expect(supportsOpenAiMaxReasoningEffort(modelId)).toBe(true)
	})

	it.each([
		undefined,
		"",
		"my-gpt-sol-old",
		"gpt-5.6-preview",
		"gpt-5.6-solar",
		"gpt-5.6-sol-extra",
		"gpt-5.6-sol-2026-9-03",
		"gpt-5.6-sol-2026-13-03",
	])("rejects non-matching model ID %s", (modelId) => {
		expect(supportsOpenAiMaxReasoningEffort(modelId)).toBe(false)
	})

	it("accepts an explicit max capability for an otherwise unknown model", () => {
		expect(
			supportsOpenAiMaxReasoningEffort("custom-reasoning-model", {
				supportsReasoningEffort: ["low", "medium", "high", "max"],
			}),
		).toBe(true)
	})

	it("does not infer max support from a boolean or an array without max", () => {
		expect(supportsOpenAiMaxReasoningEffort("custom-reasoning-model", { supportsReasoningEffort: true })).toBe(
			false,
		)
		expect(
			supportsOpenAiMaxReasoningEffort("custom-reasoning-model", {
				supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
			}),
		).toBe(false)
	})

	it("accepts the API value max and rejects the non-API label ultra", () => {
		expect(reasoningEffortsSchema.safeParse("max").success).toBe(true)
		expect(reasoningEffortsSchema.safeParse("ultra").success).toBe(false)
	})
})
// kilocode_change end

// kilocode_change start: stable maximum preference with model-aware fallback
describe("resolveReasoningEffortForModel", () => {
	it("keeps max for a capable GPT model", () => {
		expect(resolveReasoningEffortForModel("max", "gpt-5.6-sol")).toBe("max")
		expect(resolveReasoningEffortForModel("max", "openai/gpt-5.6-terra")).toBe("max")
		expect(resolveReasoningEffortForModel("max", "gpt-5.6-sol-void")).toBe("max")
	})

	it("falls back from max to xhigh when available", () => {
		expect(
			resolveReasoningEffortForModel("max", "gpt-5.5", {
				supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
			}),
		).toBe("xhigh")
	})

	it("falls back to the strongest declared previous level", () => {
		expect(
			resolveReasoningEffortForModel("max", "claude", {
				supportsReasoningEffort: ["disable", "low", "medium", "high"],
			}),
		).toBe("high")
		expect(
			resolveReasoningEffortForModel("max", "medium-only", {
				supportsReasoningEffort: ["disable", "medium"],
			}),
		).toBe("medium")
	})

	it("uses xhigh for an imprecise boolean capability", () => {
		expect(
			resolveReasoningEffortForModel("max", "custom-model", {
				supportsReasoningEffort: true,
			}),
		).toBe("xhigh")
	})

	it("leaves normal efforts unchanged and omits disable", () => {
		expect(resolveReasoningEffortForModel("high", "custom-model")).toBe("high")
		expect(resolveReasoningEffortForModel("disable", "custom-model")).toBeUndefined()
	})

	it("omits max when a model explicitly declares no usable effort", () => {
		expect(
			resolveReasoningEffortForModel("max", "custom-model", {
				supportsReasoningEffort: false,
			}),
		).toBeUndefined()
		expect(
			resolveReasoningEffortForModel("max", "custom-model", {
				supportsReasoningEffort: ["disable"],
			}),
		).toBeUndefined()
	})
})
// kilocode_change end
