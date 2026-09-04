import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const oauthMocks = vi.hoisted(() => ({
	getAccessToken: vi.fn(),
	forceRefreshAccessToken: vi.fn(),
	getAccountId: vi.fn(),
}))

vi.mock("../../../../integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: oauthMocks,
}))

import { getOpenAiCodexModels, normalizeOpenAiCodexCatalog } from "../openai-codex"

describe("normalizeOpenAiCodexCatalog", () => {
	it("keeps visible account models, preserves priority, and enforces the personal defaults", () => {
		const models = normalizeOpenAiCodexCatalog({
			models: [
				{
					slug: "hidden-model",
					visibility: "hide",
					priority: 1,
				},
				{
					slug: "gpt-5.6-sol",
					display_name: "GPT-5.6-Sol",
					description: "Current model",
					default_reasoning_level: "low",
					supported_reasoning_levels: [
						{ effort: "low" },
						{ effort: "medium" },
						{ effort: "max" },
						{ effort: "ultra" },
					],
					visibility: "list",
					priority: 6,
					context_window: 272_000,
				},
				{
					slug: "gpt-5.3-codex-spark",
					display_name: "GPT-5.3-Codex-Spark",
					default_reasoning_level: "high",
					supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
					visibility: "list",
					supported_in_api: false,
					priority: 26,
				},
			],
		})

		expect(Object.keys(models)).toEqual(["gpt-5.6-sol", "gpt-5.3-codex-spark"])
		expect(models["gpt-5.6-sol"]).toMatchObject({
			contextWindow: 370_000,
			supportsPromptCache: true,
			reasoningEffort: "low",
			supportsReasoningEffort: ["low", "medium", "max"],
			displayName: "GPT-5.6-Sol",
			preferredIndex: 6,
		})
		expect(models["gpt-5.3-codex-spark"].reasoningEffort).toBe("high")
	})

	it("returns an empty record for malformed payloads", () => {
		expect(normalizeOpenAiCodexCatalog(null)).toEqual({})
		expect(normalizeOpenAiCodexCatalog({ models: "invalid" })).toEqual({})
	})
})

describe("getOpenAiCodexModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		oauthMocks.getAccessToken.mockResolvedValue("access-token")
		oauthMocks.forceRefreshAccessToken.mockResolvedValue("refreshed-token")
		oauthMocks.getAccountId.mockResolvedValue("account-id")
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("loads the signed-in account catalog with the Codex OAuth headers", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					models: [
						{
							slug: "gpt-5.6-sol",
							visibility: "list",
							default_reasoning_level: "low",
							supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		)
		vi.stubGlobal("fetch", fetchMock)

		const models = await getOpenAiCodexModels()
		expect(models["gpt-5.6-sol"].contextWindow).toBe(370_000)

		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [url, options] = fetchMock.mock.calls[0]
		expect(String(url)).toMatch(/^https:\/\/chatgpt\.com\/backend-api\/codex\/models\?client_version=\d+\.\d+\.\d+/)
		expect(options).toMatchObject({
			method: "GET",
			headers: {
				Authorization: "Bearer access-token",
				originator: "kilo-code",
				"ChatGPT-Account-Id": "account-id",
			},
		})
	})

	it("refreshes an expired access token once", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ models: [{ slug: "future-model", visibility: "list" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
		vi.stubGlobal("fetch", fetchMock)

		await expect(getOpenAiCodexModels()).resolves.toHaveProperty("future-model")

		expect(oauthMocks.forceRefreshAccessToken).toHaveBeenCalledTimes(1)
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			expect.any(URL),
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "Bearer refreshed-token" }),
			}),
		)
	})

	it("does not make a request without a subscription login", async () => {
		oauthMocks.getAccessToken.mockResolvedValue(null)
		const fetchMock = vi.fn()
		vi.stubGlobal("fetch", fetchMock)

		await expect(getOpenAiCodexModels()).rejects.toThrow("not authenticated")
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("rejects an empty catalog so the last-known-good cache is retained", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		)

		await expect(getOpenAiCodexModels()).rejects.toThrow("empty model catalog")
	})
})
