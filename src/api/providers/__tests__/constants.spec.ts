// npx vitest run src/api/providers/__tests__/constants.spec.ts

import { DEFAULT_HEADERS } from "../constants"
import { Package } from "../../../shared/package"

describe("DEFAULT_HEADERS", () => {
	it("should contain all required headers", () => {
		expect(DEFAULT_HEADERS).toHaveProperty("HTTP-Referer")
		expect(DEFAULT_HEADERS).toHaveProperty("X-Title")
		expect(DEFAULT_HEADERS).toHaveProperty("User-Agent")
	})

	it("should have correct HTTP-Referer value", () => {
		expect(DEFAULT_HEADERS["HTTP-Referer"]).toBe("https://github.com/oiv-an/ivol-code-agent-5")
	})

	it("should have correct X-Title value", () => {
		expect(DEFAULT_HEADERS["X-Title"]).toBe("IVOL Code")
	})

	it("should have correct User-Agent format", () => {
		const userAgent = DEFAULT_HEADERS["User-Agent"]
		expect(userAgent).toBe(`IVOL-Code-Agent-5/${Package.version}`)

		// kilocode_change: personal builds use a valid SemVer prerelease suffix.
		expect(userAgent).toMatch(/^[a-zA-Z0-9-]+\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
	})

	it("should have User-Agent with correct tool name", () => {
		const userAgent = DEFAULT_HEADERS["User-Agent"]
		expect(userAgent.startsWith("IVOL-Code-Agent-5/")).toBe(true)
	})

	it("should have User-Agent with semantic version format", () => {
		const userAgent = DEFAULT_HEADERS["User-Agent"]
		const version = userAgent.split("/")[1]

		// kilocode_change: accept major.minor.patch and personal prerelease versions.
		expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)

		// Verify current version matches package version
		expect(version).toBe(Package.version)
	})

	it("should be an object with string values", () => {
		expect(typeof DEFAULT_HEADERS).toBe("object")
		expect(DEFAULT_HEADERS).not.toBeNull()

		Object.values(DEFAULT_HEADERS).forEach((value) => {
			expect(typeof value).toBe("string")
			expect(value.length).toBeGreaterThan(0)
		})
	})

	it("should have exactly 4 headers", () => {
		const headerKeys = Object.keys(DEFAULT_HEADERS)
		expect(headerKeys).toHaveLength(4)
		expect(headerKeys).toEqual(["HTTP-Referer", "X-Title", "X-IVOL-Code-Version", "User-Agent"])
	})
})
