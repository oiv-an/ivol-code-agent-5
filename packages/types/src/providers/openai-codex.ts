import type { ModelInfo } from "../model.js"

/**
 * OpenAI Codex Provider
 *
 * This provider uses OAuth authentication via ChatGPT Plus/Pro subscription
 * instead of direct API keys. Requests are routed to the Codex backend at
 * https://chatgpt.com/backend-api/codex/responses
 *
 * Key differences from openai-native:
 * - Uses OAuth Bearer tokens instead of API keys
 * - Subscription-based pricing (no per-token costs)
 * - Limited model subset available
 * - Custom routing to Codex backend
 */

// kilocode_change start: the model list comes only from the signed-in account catalog
// (https://chatgpt.com/backend-api/codex/models). No hardcoded model list is bundled.
export type OpenAiCodexModelId = string

// Fixed context budget for every Plus/Pro model, independent of the remote catalog.
export const OPENAI_CODEX_CONTEXT_WINDOW = 370_000

// Preferred default when the account catalog offers it; otherwise the first catalog model is used.
export const openAiCodexDefaultModelId: OpenAiCodexModelId = "gpt-5.6-sol"

/** Capabilities applied to a selected model before the account catalog has loaded. */
export const openAiCodexFallbackModelInfo: ModelInfo = {
	maxTokens: 128000,
	contextWindow: OPENAI_CODEX_CONTEXT_WINDOW,
	supportsNativeTools: true,
	defaultToolProtocol: "native",
	includedTools: ["apply_patch"],
	excludedTools: ["apply_diff", "write_to_file"],
	supportsImages: true,
	supportsPromptCache: true,
	inputPrice: 0,
	outputPrice: 0,
	supportsTemperature: false,
	description: "Model via ChatGPT subscription",
}

/** Intentionally empty: models are loaded from the account catalog at runtime. */
export const openAiCodexModels: Record<string, ModelInfo> = {}

/** Pick the default model id from a loaded catalog. */
export const getOpenAiCodexDefaultModelId = (models?: Record<string, ModelInfo>): string =>
	models && models[openAiCodexDefaultModelId]
		? openAiCodexDefaultModelId
		: (models && Object.keys(models)[0]) || openAiCodexDefaultModelId
// kilocode_change end
