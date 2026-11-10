// kilocode_change - new file
import type { ClineMessage } from "@roo-code/types"

import { correctInflatedPromptTokens, findPreviousPromptTokens } from "../usageSanity"

describe("correctInflatedPromptTokens", () => {
	it("removes a cache read that the gateway added on top of the prompt", () => {
		// Observed: misses around 173k, then a hit reported as 270k with 119k read.
		expect(
			correctInflatedPromptTokens({
				inputTokens: 270466,
				cacheReadTokens: 119572,
				cacheWriteTokens: 11556,
				previousInputTokens: 173009,
			}),
		).toBe(173009)
	})

	it("keeps a sane cache hit unchanged", () => {
		expect(
			correctInflatedPromptTokens({
				inputTokens: 182174,
				cacheReadTokens: 88961,
				cacheWriteTokens: 2573,
				previousInputTokens: 180852,
			}),
		).toBe(182174)
	})

	it("keeps genuine growth that was written to the cache", () => {
		expect(
			correctInflatedPromptTokens({
				inputTokens: 240000,
				cacheReadTokens: 170000,
				cacheWriteTokens: 65000,
				previousInputTokens: 175000,
			}),
		).toBe(240000)
	})

	it("does nothing without a cache read or a previous request", () => {
		expect(
			correctInflatedPromptTokens({
				inputTokens: 300000,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				previousInputTokens: 100000,
			}),
		).toBe(300000)
		expect(correctInflatedPromptTokens({ inputTokens: 300000, cacheReadTokens: 150000, cacheWriteTokens: 0 })).toBe(
			300000,
		)
	})
})

describe("findPreviousPromptTokens", () => {
	const req = (tokensIn?: number): ClineMessage =>
		({
			type: "say",
			say: "api_req_started",
			ts: 1,
			text: JSON.stringify(tokensIn ? { tokensIn } : {}),
		}) as ClineMessage

	it("returns the last request with token data before the index", () => {
		const messages = [req(1000), req(2000), req()]
		expect(findPreviousPromptTokens(messages, 2)).toBe(2000)
	})

	it("stops at a condense and uses the new context size", () => {
		const messages = [
			req(390000),
			{
				type: "say",
				say: "condense_context",
				ts: 2,
				contextCondense: { newContextTokens: 110000 },
			} as ClineMessage,
			req(),
		]
		expect(findPreviousPromptTokens(messages, 2)).toBe(110000)
	})
})
