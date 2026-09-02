// npx vitest run src/__tests__/kilocode.test.ts

import { describe, it, expect } from "vitest"
import {
	autocompleteServiceSettingsSchema,
	DISABLED_KILOCODE_URL,
	getAppUrl,
	getApiUrl,
	getKiloBaseUriFromToken,
	getKiloUrlFromToken,
	getExtensionConfigUrl,
} from "../kilocode/kilocode.js"

describe("autocompleteServiceSettingsSchema", () => {
	it("should accept all boolean settings", () => {
		const result = autocompleteServiceSettingsSchema.safeParse({
			enableAutoTrigger: true,
			enableQuickInlineTaskKeybinding: false,
			enableSmartInlineTaskKeybinding: true,
		})
		expect(result.success).toBe(true)
	})

	it("should accept combined settings", () => {
		const result = autocompleteServiceSettingsSchema.safeParse({
			enableAutoTrigger: true,
			enableQuickInlineTaskKeybinding: true,
			enableSmartInlineTaskKeybinding: true,
		})
		expect(result.success).toBe(true)
	})

	it("should be optional", () => {
		const result = autocompleteServiceSettingsSchema.safeParse({
			enableAutoTrigger: true,
		})
		expect(result.success).toBe(true)
	})
})

describe("URL functions", () => {
	it("always returns the disabled base regardless of token contents", () => {
		expect(getKiloBaseUriFromToken()).toBe(DISABLED_KILOCODE_URL)
		expect(getKiloBaseUriFromToken("header.payload.signature")).toBe(DISABLED_KILOCODE_URL)
	})

	it("maps app and API paths to the disabled scheme", () => {
		expect(getAppUrl()).toBe("ivol-disabled://kilo/")
		expect(getAppUrl("/profile?source=vscode")).toBe("ivol-disabled://kilo/profile?source=vscode")
		expect(getApiUrl("/api/profile")).toBe("ivol-disabled://kilo/api/profile")
		expect(getExtensionConfigUrl()).toBe("ivol-disabled://kilo/extension-config.json")
	})

	it("ignores environment overrides", () => {
		const previous = process.env.KILOCODE_BACKEND_BASE_URL
		process.env.KILOCODE_BACKEND_BASE_URL = "https://example.com"
		try {
			expect(getApiUrl("/api/profile")).toBe("ivol-disabled://kilo/api/profile")
		} finally {
			if (previous === undefined) delete process.env.KILOCODE_BACKEND_BASE_URL
			else process.env.KILOCODE_BACKEND_BASE_URL = previous
		}
	})

	it("never preserves the origin supplied by a legacy caller", () => {
		expect(getKiloUrlFromToken("https://example.com/api/profile?q=1", "unused-token")).toBe(
			"ivol-disabled://kilo/api/profile?q=1",
		)
		expect(getKiloUrlFromToken("/api/profile", "unused-token")).toBe("ivol-disabled://kilo/api/profile")
	})
})
