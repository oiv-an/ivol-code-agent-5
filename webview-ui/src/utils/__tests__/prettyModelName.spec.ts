// kilocode_change - new file
import { prettyModelName } from "../prettyModelName"

describe("prettyModelName", () => {
	it("formats a simple provider/model id", () => {
		expect(prettyModelName("openai/gpt-4").trim()).toBe("Openai / Gpt 4")
	})

	it("keeps every path segment so nested ids stay distinguishable", () => {
		const a = prettyModelName("#apinex_bond/free/claude-opus-4.6").trim()
		const b = prettyModelName("#apinex_bond/free/gpt-5").trim()
		expect(a).toBe("#apinex_bond / Free / Claude Opus 4.6")
		expect(b).toBe("#apinex_bond / Free / Gpt 5")
		expect(a).not.toBe(b)
	})

	it("keeps the full tag after the first colon", () => {
		expect(prettyModelName("vendor/model:free:beta")).toBe("Vendor / Model (Free:beta)")
	})

	it("formats an id without a provider prefix", () => {
		expect(prettyModelName("1-gpt-sol").trim()).toBe("1 Gpt Sol")
	})
})
