// npx vitest run api/providers/__tests__/openai-codex.spec.ts

import { OpenAiCodexHandler } from "../openai-codex"

const { getModelsFromCacheMock } = vi.hoisted(() => ({
	getModelsFromCacheMock: vi.fn(),
}))

vi.mock("../fetchers/modelCache", () => ({
	getModelsFromCache: (...args: unknown[]) => getModelsFromCacheMock(...args),
}))

describe("OpenAiCodexHandler.getModel", () => {
	beforeEach(() => {
		getModelsFromCacheMock.mockReset()
		getModelsFromCacheMock.mockReturnValue(undefined)
	})

	it.each([
		["gpt-5.6-sol", "low"],
		["gpt-5.6-terra", "medium"],
		["gpt-5.6-luna", "medium"],
		["gpt-5.5", "medium"],
		["gpt-5.4-mini", "medium"],
		["gpt-5.3-codex-spark", "high"],
		["gpt-5.1", "medium"],
		["gpt-5", "medium"],
		["gpt-5.1-codex", "medium"],
		["gpt-5-codex", "medium"],
		["gpt-5-codex-mini", "medium"],
	] as const)("returns registered model %s", (apiModelId, expectedEffort) => {
		const handler = new OpenAiCodexHandler({ apiModelId })
		const model = handler.getModel()

		expect(model.id).toBe(apiModelId)
		expect(model.info.reasoningEffort).toBe(expectedEffort)
		expect(model.info.contextWindow).toBe(370_000)
		expect(model.info.supportsPromptCache).toBe(true)
	})

	it("should fall back to default model when an invalid model id is provided", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "not-a-real-model" })
		const model = handler.getModel()

		expect(model.id).toBe("gpt-5.6-sol")
		expect(model.info).toBeDefined()
	})

	it("accepts an account-discovered model and enforces the fixed subscription capabilities", () => {
		getModelsFromCacheMock.mockReturnValue({
			"future-codex-model": {
				contextWindow: 999_999,
				supportsPromptCache: false,
				supportsReasoningEffort: ["low", "medium"],
				reasoningEffort: "low",
			},
		})

		const model = new OpenAiCodexHandler({ apiModelId: "future-codex-model" }).getModel()

		expect(model.id).toBe("future-codex-model")
		expect(model.info.contextWindow).toBe(370_000)
		expect(model.info.supportsPromptCache).toBe(true)
	})

	it("uses a stable per-task prompt cache key", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.6-sol" })
		const model = handler.getModel()
		const body = (handler as any).buildRequestBody(model, [], "system", "max", { taskId: "task-123" })

		expect(body.prompt_cache_key).toBe("task-123")
	})

	it("does not send a stale max effort to GPT-5.5", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.5", reasoningEffort: "max" })
		const model = handler.getModel()

		expect((handler as any).getReasoningEffort(model)).toBe("medium")
	})
})
