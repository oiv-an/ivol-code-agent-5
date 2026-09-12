// npx vitest run src/__tests__/index.test.ts

import { GLOBAL_STATE_KEYS, GLOBAL_SETTINGS_KEYS, PROVIDER_SETTINGS_KEYS } from "../index.js"

describe("GLOBAL_STATE_KEYS", () => {
	it("should contain provider settings keys", () => {
		expect(GLOBAL_STATE_KEYS).toContain("autoApprovalEnabled")
	})

	it("should contain provider settings keys", () => {
		expect(GLOBAL_STATE_KEYS).toContain("anthropicBaseUrl")
	})

	it("should not contain secret state keys", () => {
		expect(GLOBAL_STATE_KEYS).not.toContain("openRouterApiKey")
	})

	it("should contain OpenAI Compatible base URL setting", () => {
		expect(GLOBAL_STATE_KEYS).toContain("codebaseIndexOpenAiCompatibleBaseUrl")
	})

	it("should not contain OpenAI Compatible API key (secret)", () => {
		expect(GLOBAL_STATE_KEYS).not.toContain("codebaseIndexOpenAiCompatibleApiKey")
	})

	// kilocode_change: profile enablement must survive profile filtering and switching.
	it("stores the working file opt-in with provider settings", () => {
		expect(GLOBAL_STATE_KEYS).toContain("intelligentTaskEnabled")
		expect(PROVIDER_SETTINGS_KEYS).toContain("intelligentTaskEnabled")
		expect(GLOBAL_SETTINGS_KEYS).not.toContain("intelligentTaskEnabled")
	})
})
