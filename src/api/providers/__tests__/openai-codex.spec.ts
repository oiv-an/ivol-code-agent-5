// npx vitest run api/providers/__tests__/openai-codex.spec.ts

import { OpenAiCodexHandler } from "../openai-codex"

const { getModelsFromCacheMock } = vi.hoisted(() => ({
	getModelsFromCacheMock: vi.fn(),
}))

vi.mock("../fetchers/modelCache", () => ({
	getModelsFromCache: (...args: unknown[]) => getModelsFromCacheMock(...args),
}))

// kilocode_change start: models come only from the account catalog (mocked here)
const accountCatalog = {
	"gpt-6.1-sol": {
		contextWindow: 500_000,
		supportsPromptCache: true,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max", "ultra"],
		reasoningEffort: "low",
	},
	"gpt-5.6-sol": {
		contextWindow: 370_000,
		supportsPromptCache: true,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
		reasoningEffort: "low",
	},
	"gpt-5.5": {
		contextWindow: 370_000,
		supportsPromptCache: true,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
		reasoningEffort: "medium",
	},
}
// kilocode_change end

describe("OpenAiCodexHandler.getModel", () => {
	beforeEach(() => {
		getModelsFromCacheMock.mockReset()
		getModelsFromCacheMock.mockReturnValue(accountCatalog) // kilocode_change
	})

	// kilocode_change start
	it.each([
		["gpt-6.1-sol", "low"],
		["gpt-5.6-sol", "low"],
		["gpt-5.5", "medium"],
	] as const)("returns catalog model %s", (apiModelId, expectedEffort) => {
		const model = new OpenAiCodexHandler({ apiModelId }).getModel()

		expect(model.id).toBe(apiModelId)
		expect(model.info.reasoningEffort).toBe(expectedEffort)
		expect(model.info.contextWindow).toBe(370_000)
		expect(model.info.supportsPromptCache).toBe(true)
	})

	it("falls back to the catalog default for a model the subscription no longer offers", () => {
		const model = new OpenAiCodexHandler({ apiModelId: "gpt-5.1-codex-max" }).getModel()
		expect(model.id).toBe("gpt-5.6-sol")
	})

	it("uses the first catalog model when the preferred default is absent", () => {
		getModelsFromCacheMock.mockReturnValue({ "gpt-6.1-sol": accountCatalog["gpt-6.1-sol"] })
		expect(new OpenAiCodexHandler({ apiModelId: "old-model" }).getModel().id).toBe("gpt-6.1-sol")
	})

	it("keeps the saved model id before the catalog is loaded", () => {
		getModelsFromCacheMock.mockReturnValue(undefined)
		const model = new OpenAiCodexHandler({ apiModelId: "gpt-6-astra" }).getModel()
		expect(model.id).toBe("gpt-6-astra")
		expect(model.info.contextWindow).toBe(370_000)
		expect(model.info.supportsPromptCache).toBe(true)
	})
	// kilocode_change end

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

	// kilocode_change start: preserve max while retaining legacy stale-setting fallback
	it.each([true, false])("preserves literal ultra in the request only when enabled: %s", (enabled) => {
		const handler = new OpenAiCodexHandler({
			apiModelId: "gpt-5.5",
			reasoningEffort: "ultra",
			enableReasoningEffort: enabled,
		})
		const model = handler.getModel()
		const effort = (handler as any).getReasoningEffort(model)
		const body = (handler as any).buildRequestBody(model, [], "system", effort, { taskId: "ultra-test" })
		expect(effort).toBe(enabled ? "ultra" : undefined)
		expect(body.reasoning?.effort).toBe(enabled ? "ultra" : undefined)
	})

	it("falls back from max to xhigh for GPT-5.5", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.5", reasoningEffort: "max" })
		const model = handler.getModel()

		expect((handler as any).getReasoningEffort(model)).toBe("xhigh")
	})

	it("keeps max for GPT-5.6", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.6-sol", reasoningEffort: "max" })
		expect((handler as any).getReasoningEffort(handler.getModel())).toBe("max")
	})

	it("falls back to the strongest declared level for an account model", () => {
		getModelsFromCacheMock.mockReturnValue({
			"future-codex-model": {
				contextWindow: 999_999,
				supportsPromptCache: false,
				supportsReasoningEffort: ["low", "medium"],
				reasoningEffort: "low",
			},
		})
		const handler = new OpenAiCodexHandler({ apiModelId: "future-codex-model", reasoningEffort: "max" })

		expect((handler as any).getReasoningEffort(handler.getModel())).toBe("medium")
	})

	it("retains the model default for an unsupported older saved effort", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.5", reasoningEffort: "minimal" })
		expect((handler as any).getReasoningEffort(handler.getModel())).toBe("medium")
	})

	it("omits reasoning when the setting is disabled", () => {
		const handler = new OpenAiCodexHandler({
			apiModelId: "gpt-5.6-sol",
			reasoningEffort: "max",
			enableReasoningEffort: false,
		})
		expect((handler as any).getReasoningEffort(handler.getModel())).toBeUndefined()
	})
	// kilocode_change end
})
