// kilocode_change - new file
import {
	__setOpenRouterPriceCatalogForTests,
	applyOpenRouterPricing,
	matchOpenRouterModel,
	normalizeModelId,
	parseOpenRouterPriceCatalog,
} from "../openrouter-pricing"

const raw = {
	data: [
		{
			id: "anthropic/claude-opus-4.1",
			created: 1754411591,
			pricing: { prompt: "0.000015", completion: "0.000075" },
		},
		{
			id: "anthropic/claude-opus-5",
			created: 1784912544,
			pricing: { prompt: "0.000005", completion: "0.000025", input_cache_read: "0.0000005" },
		},
		{
			id: "anthropic/claude-opus-5.5",
			created: 1790094732,
			pricing: {
				prompt: "0.000004",
				completion: "0.00002",
				input_cache_read: "0.0000002",
				input_cache_write: "0.000005",
			},
		},
		{
			id: "anthropic/claude-opus-5.5:batch",
			created: 1790094732,
			pricing: { prompt: "0.000002", completion: "0.00001" },
		},
		{
			id: "~anthropic/claude-opus-latest",
			created: 1776795361,
			pricing: { prompt: "0.000004", completion: "0.00002" },
		},
		{
			id: "anthropic/claude-sonnet-5.5",
			created: 1790618686,
			pricing: { prompt: "0.000002", completion: "0.00001" },
		},
		{ id: "openai/gpt-6.1-sol", created: 1790702882, pricing: { prompt: "0.000002", completion: "0.00001" } },
		{ id: "openai/gpt-6.1-sol-pro", created: 1790702886, pricing: { prompt: "0.000002", completion: "0.00001" } },
		{ id: "openai/gpt-6-sol", created: 1790100775, pricing: { prompt: "0.000002", completion: "0.00001" } },
		{ id: "free/model", created: 1, pricing: { prompt: "0", completion: "0" } },
	],
}

const entries = parseOpenRouterPriceCatalog(raw)

describe("openrouter-pricing", () => {
	afterEach(() => __setOpenRouterPriceCatalogForTests(undefined))

	it("parses prices per 1M tokens and skips variants, aliases and free models", () => {
		const ids = entries.map((entry) => entry.id)
		expect(ids).not.toContain("anthropic/claude-opus-5.5:batch")
		expect(ids).not.toContain("~anthropic/claude-opus-latest")
		expect(ids).not.toContain("free/model")
		const opus = entries.find((entry) => entry.id === "anthropic/claude-opus-5.5")!
		expect(opus.inputPrice).toBeCloseTo(4)
		expect(opus.outputPrice).toBeCloseTo(20)
		expect(opus.cacheReadsPrice).toBeCloseTo(0.2)
		expect(opus.cacheWritesPrice).toBeCloseTo(5)
	})

	it("normalizes aliases", () => {
		expect(normalizeModelId("3-claude-opus")).toBe("claude-opus")
		expect(normalizeModelId("anthropic/claude-opus-4.5")).toBe("claude-opus-4-5")
		expect(normalizeModelId("claude-sonnet-4-20250514")).toBe("claude-sonnet-4")
	})

	it("matches an unversioned alias to the newest model of the family", () => {
		expect(matchOpenRouterModel("3-claude-opus", entries)?.id).toBe("anthropic/claude-opus-5.5")
		expect(matchOpenRouterModel("claude-opus-latest", entries)?.id).toBe("anthropic/claude-opus-5.5")
		expect(matchOpenRouterModel("1-gpt-sol", entries)?.id).toBe("openai/gpt-6.1-sol")
	})

	it("respects explicit versions", () => {
		expect(matchOpenRouterModel("claude-opus-4-1", entries)?.id).toBe("anthropic/claude-opus-4.1")
		expect(matchOpenRouterModel("claude-opus-5", entries)?.id).toBe("anthropic/claude-opus-5")
		expect(matchOpenRouterModel("claude-opus-5-5", entries)?.id).toBe("anthropic/claude-opus-5.5")
		expect(matchOpenRouterModel("anthropic/claude-sonnet-5.5", entries)?.id).toBe("anthropic/claude-sonnet-5.5")
	})

	it("returns undefined for unknown models", () => {
		expect(matchOpenRouterModel("my-local-llama", entries)).toBeUndefined()
		expect(matchOpenRouterModel("", entries)).toBeUndefined()
	})

	it("fills empty prices and keeps manual prices", () => {
		__setOpenRouterPriceCatalogForTests({ fetchedAt: Date.now(), entries })
		const empty = applyOpenRouterPricing(
			{ contextWindow: 1, supportsPromptCache: true, inputPrice: 0, outputPrice: 0 },
			"3-claude-opus",
		)
		expect(empty.inputPrice).toBeCloseTo(4)
		expect(empty.cacheReadsPrice).toBeCloseTo(0.2)

		const manual = { contextWindow: 1, supportsPromptCache: true, inputPrice: 1, outputPrice: 2 }
		expect(applyOpenRouterPricing(manual, "3-claude-opus")).toBe(manual)
	})

	it("leaves info unchanged when the catalog is not loaded", () => {
		const info = { contextWindow: 1, supportsPromptCache: true, inputPrice: 0, outputPrice: 0 }
		expect(applyOpenRouterPricing(info, "3-claude-opus")).toBe(info)
	})
})
