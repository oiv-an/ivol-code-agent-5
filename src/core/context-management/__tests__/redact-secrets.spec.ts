// kilocode_change - new file
import { describe, expect, it } from "vitest"

import { redactPotentialSecrets } from "../redact-secrets"

describe("redactPotentialSecrets", () => {
	it("removes exact known values and common credential shapes", () => {
		const knownSecret = "custom:proxy/credential+with=punctuation"
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature_value"
		const privateKey = "-----BEGIN PRIVATE KEY-----\nvery-secret-key-material\n-----END PRIVATE KEY-----"
		const opaqueBearer = "opaque-token-that-does-not-match-a-provider-prefix"
		const opaqueBasic = "dXNlcjpwYXNzd29yZA=="
		const githubToken = "github_pat_11AA22BB33CC44DD55EE66FF77GG88HH"
		const npmToken = "npm_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8"
		const awsTemporaryAccessKey = "ASIA1234567890ABCDEF"

		const redacted = redactPotentialSecrets(
			[
				"Configured ivol-managed-0000000000000000000000000000000000000000.",
				'JSON: "password": "quoted-password-value"',
				"OPENAI_API_KEY=opaque-proxy-value",
				"refresh_token='refresh-token-value'",
				"Cookie: session=session-cookie-value; csrf=csrf-value",
				`Authorization: Bearer ${opaqueBearer}`,
				`Authorization: Basic ${opaqueBasic}`,
				`GitHub: ${githubToken}`,
				`npm: ${npmToken}`,
				`AWS: ${awsTemporaryAccessKey}`,
				`JWT: ${jwt}`,
				privateKey,
				`Known: ${knownSecret}`,
				"Database: postgres://user:database-password@localhost:5432/app",
			].join("\n"),
			[knownSecret],
		)

		for (const value of [
			"ivol-managed-0000000000000000000000000000000000000000",
			"quoted-password-value",
			"opaque-proxy-value",
			"refresh-token-value",
			"session-cookie-value",
			"database-password",
			"very-secret-key-material",
			opaqueBearer,
			opaqueBasic,
			githubToken,
			npmToken,
			awsTemporaryAccessKey,
			jwt,
			knownSecret,
		]) {
			expect(redacted).not.toContain(value)
		}
		expect(redacted).toContain("[redacted]")
	})

	it("does not treat very short known values as secrets", () => {
		expect(redactPotentialSecrets("a valid continuation", ["a"])).toBe("a valid continuation")
	})

	it("leaves ordinary prose untouched", () => {
		const text = "Refactored the parser and updated two call sites."
		expect(redactPotentialSecrets(text)).toBe(text)
	})
})
