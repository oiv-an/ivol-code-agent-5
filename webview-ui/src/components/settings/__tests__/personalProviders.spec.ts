import { PERSONAL_PROVIDERS, PERSONAL_PROVIDER_VALUES } from "../constants"

describe("personal provider list", () => {
	it("exposes only the supported personal providers", () => {
		expect(PERSONAL_PROVIDERS.map(({ value }) => value)).toEqual([
			"claude-code",
			"lmstudio",
			"ollama",
			"openai-codex",
			"openai",
		])
		expect(new Set(PERSONAL_PROVIDERS.map(({ value }) => value))).toEqual(new Set(PERSONAL_PROVIDER_VALUES))
	})

	it("does not expose the Kilo gateway", () => {
		expect(PERSONAL_PROVIDERS.some(({ value }) => value === "kilocode")).toBe(false)
	})
})
