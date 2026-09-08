// kilocode_change - new file
import {
	PERSONAL_PROVIDER_VALUES,
	PROVIDER_SETTINGS_KEYS,
	providerSettingsSchema,
	providerSettingsSchemaDiscriminated,
} from "../provider-settings.js"

describe("per-profile TLS certificate verification", () => {
	it.each(PERSONAL_PROVIDER_VALUES)("does not opt %s into insecure TLS by default", (apiProvider) => {
		expect(providerSettingsSchema.parse({ apiProvider }).allowInsecureTls).toBeUndefined()
		expect(providerSettingsSchemaDiscriminated.parse({ apiProvider })).not.toHaveProperty("allowInsecureTls")
	})
	it.each([true, false])("preserves an explicit boolean %s through both profile schemas", (allowInsecureTls) => {
		for (const apiProvider of PERSONAL_PROVIDER_VALUES) {
			expect(providerSettingsSchema.parse({ apiProvider, allowInsecureTls }).allowInsecureTls).toBe(
				allowInsecureTls,
			)
			expect(providerSettingsSchemaDiscriminated.parse({ apiProvider, allowInsecureTls })).toEqual(
				expect.objectContaining({ allowInsecureTls }),
			)
		}
	})
	it.each(["true", "false", 1, 0, null, {}])("rejects non-boolean opt-in %j", (allowInsecureTls) => {
		expect(providerSettingsSchema.safeParse({ apiProvider: "openai", allowInsecureTls }).success).toBe(false)
	})
	it("includes the flag in profile persistence keys", () => {
		expect(PROVIDER_SETTINGS_KEYS).toContain("allowInsecureTls")
	})
})
