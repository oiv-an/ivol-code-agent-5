// kilocode_change - new file
import type { ProviderSettings } from "@roo-code/types"

import { buildReport, inspectError, makeReportSanitizer } from "../report"

const configuration: ProviderSettings = {
	apiProvider: "openai",
	openAiModelId: "safe-model",
	openAiApiKey: "secret-key-12345",
	openAiBaseUrl: "https://urluser:urlpassword@test.example/private-path-secret/v1?token=query-secret#fragment-secret",
	openAiHeaders: { "X-Innocent-Looking": "arbitrary-header-secret", Authorization: "Bearer bearer-secret" },
}

describe("provider diagnostic report privacy", () => {
	it.each([
		"secret-key-12345",
		"arbitrary-header-secret",
		"Bearer bearer-secret",
		"bearer-secret",
		"urluser",
		"urlpassword",
		"private-path-secret",
		"query-secret",
		"fragment-secret",
	])("redacts known secret %s before truncating", (secret) => {
		const sanitize = makeReportSanitizer(configuration)
		expect(sanitize(`safe: ${secret} trailing`, 12)).not.toContain(secret)
		expect(sanitize(secret)).toBe("[redacted]")
		expect(sanitize(encodeURIComponent(secret))).toBe("[redacted]")
	})

	it("omits every raw error/body/stack/account field and malicious provider output identifier", () => {
		const sanitize = makeReportSanitizer(configuration)
		const error = {
			status: 401,
			code: "secret-key-12345",
			request_id: "arbitrary-header-secret",
			message: "unknown-oauth-secret user@example.com /Users/private/account.json Cookie: session-value",
			stack: "stack with /private/key.pem",
			headers: { authorization: "unknown-secret", "set-cookie": "session-cookie" },
			response: { data: { email: "hidden-account@example.com", error: { message: "unknown-oauth-secret" } } },
		}
		const facts = inspectError(error, sanitize)
		expect(facts).toEqual({ status: 401, category: "authentication" })
		const report = buildReport({
			configuration,
			requestId: "check-id-123",
			extensionVersion: "5.16.239",
			vscodeVersion: "1.105.0",
			startedAt: "2026-09-09T00:00:00.000Z",
			elapsedMs: 1,
			status: "error",
			category: facts.category,
			facts,
			sanitize,
		})
		for (const privateText of [
			"secret-key-12345",
			"arbitrary-header-secret",
			"urluser",
			"urlpassword",
			"private-path-secret",
			"query-secret",
			"fragment-secret",
			"unknown-oauth-secret",
			"user@example.com",
			"/Users/private",
			"Cookie",
			"/private/key.pem",
			"unknown-secret",
			"session-cookie",
			"hidden-account@example.com",
		]) {
			expect(report).not.toContain(privateText)
		}
		expect(report).toContain("https://test.example/[path omitted]?[query omitted]")
		expect(report).toContain("HTTP status: 401")
	})

	it("does not execute error getters, toString, or toJSON, and safely terminates cycles", () => {
		const access = vi.fn(() => {
			throw new Error("must not execute")
		})
		const error: Record<string, unknown> = { status: 502, toString: access, toJSON: access }
		Object.defineProperty(error, "message", { get: access })
		Object.defineProperty(error, "headers", { get: access })
		error.cause = error
		error.error = { response: { data: error } }
		expect(inspectError(error, makeReportSanitizer(configuration))).toEqual({
			status: 502,
			category: "server_error",
		})
		expect(access).not.toHaveBeenCalled()
	})

	it("excludes unknown codes and unsafe account/token/path-shaped request identifiers", () => {
		const sanitize = makeReportSanitizer(configuration)
		for (const requestId of [
			"user@example.com",
			"/Users/private/request",
			"Bearer unknown-token",
			"sk-unknown-token",
			"eyJabc.eyJdef.sig",
			"id\nInjected",
		]) {
			expect(inspectError({ code: "unrecognized-private-payload", request_id: requestId }, sanitize)).toEqual({
				category: "provider_error",
			})
		}
	})

	it("reports only actual numeric HTTP status fields and safe request headers", () => {
		const sanitize = makeReportSanitizer(configuration)
		expect(
			inspectError(
				{
					message: "HTTP 503",
					status: "503",
					headers: { "x-request-id": "req_safe123456", "set-cookie": "private" },
				},
				sanitize,
			),
		).toEqual({ category: "provider_error", requestId: "req_safe123456" })
	})

	it("redacts percent-encoded URL components and arbitrary short header values", () => {
		const sanitize = makeReportSanitizer({
			...configuration,
			openAiBaseUrl: "https://test.example/private%20route?q=private%20query",
			openAiHeaders: { "X-Anything": "xyz" },
		})
		for (const value of ["private route", "private%20route", "private query", "private%20query", "xyz"])
			expect(sanitize(value)).toBe("[redacted]")
	})

	it.each([
		String.raw`\\server\share\private-model.bin`,
		String.raw`\\server\private share\private-model.bin`,
		String.raw`\\?\C:\Users\Person Name\private-model.bin`,
		String.raw`\\?\UNC\server\private share\private-model.bin`,
		String.raw`\\.\pipe\private-pipe`,
		String.raw`\??\C:\Users\Person Name\private-model.bin`,
	])("redacts complete UNC and extended Windows paths: %s", (modelPath) => {
		const profile = { ...configuration, openAiModelId: modelPath }
		const sanitize = makeReportSanitizer(profile)
		expect(sanitize(modelPath)).toBe("[redacted]")
		const report = buildReport({
			configuration: profile,
			requestId: "check-id",
			extensionVersion: "5.16.240",
			vscodeVersion: "1.105.0",
			startedAt: "2026-09-09T00:00:00.000Z",
			elapsedMs: 1,
			status: "success",
			category: "success",
			sanitize,
		})
		expect(report).toContain("Model: [redacted]")
		expect(report).not.toContain("private-model")
		expect(report).not.toContain("Person Name")
		expect(report).not.toContain("private share")
	})

	it("bounds multibyte metadata without leaking a secret at the truncation boundary", () => {
		const malicious = { ...configuration, openAiModelId: `safe${configuration.openAiApiKey}${"界".repeat(10_000)}` }
		const report = buildReport({
			configuration: malicious,
			requestId: "check-id",
			extensionVersion: "5.16.239",
			vscodeVersion: "1.105.0",
			startedAt: "2026-09-09T00:00:00.000Z",
			elapsedMs: 1,
			status: "success",
			category: "success",
			sanitize: makeReportSanitizer(malicious),
		})
		expect(Buffer.byteLength(report)).toBeLessThanOrEqual(8192)
		expect(report).not.toContain(configuration.openAiApiKey)
		expect(report).not.toContain("secret-key")
	})
})
