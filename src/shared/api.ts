import {
	type ModelInfo,
	type ModelRecord, // kilocode_change
	type RouterModels, // kilocode_change
	type ProviderSettings,
	type DynamicProvider,
	type LocalProvider,
	ANTHROPIC_DEFAULT_MAX_TOKENS,
	isDynamicProvider,
	isLocalProvider,
	ToolProtocol, // kilocode_change
	resolveReasoningEffortForModel, // kilocode_change
} from "@roo-code/types"

// Re-export for legacy imports (some providers still import ModelRecord from this module).
export type { ModelRecord } // kilocode_change

// Re-export for webview-ui legacy imports (via `@roo/api`).
export type { RouterModels } // kilocode_change

// ApiHandlerOptions
// Extend ProviderSettings (minus apiProvider) with handler-specific toggles.
export type ApiHandlerOptions = Omit<ProviderSettings, "apiProvider"> & {
	// kilocode_change: request-only diagnostics mode; never part of saved ProviderSettings.
	connectionTest?: boolean
	/**
	 * When true and using OpenAI Responses API models that support reasoning summaries,
	 * include reasoning.summary: "auto" so the API returns summaries (we already parse
	 * and surface them). Defaults to true; set to false to disable summaries.
	 */
	enableResponsesReasoningSummary?: boolean
	/**
	 * Optional override for Ollama's num_ctx parameter.
	 * When set, this value will be used in Ollama chat requests.
	 * When undefined, Ollama will use the model's default num_ctx from the Modelfile.
	 */
	ollamaNumCtx?: number
}

// RouterName

export type RouterName = DynamicProvider | LocalProvider

export const isRouterName = (value: string): value is RouterName => isDynamicProvider(value) || isLocalProvider(value)

export function toRouterName(value?: string): RouterName {
	if (value && isRouterName(value)) {
		return value
	}

	throw new Error(`Invalid router name: ${value}`)
}

// Reasoning

export const shouldUseReasoningBudget = ({
	model,
	settings,
}: {
	model: ModelInfo
	settings?: ProviderSettings
}): boolean => !!model.requiredReasoningBudget || (!!model.supportsReasoningBudget && !!settings?.enableReasoningEffort)

export const shouldUseReasoningEffort = ({
	model,
	settings,
}: {
	model: ModelInfo
	settings?: ProviderSettings
}): boolean => {
	// Explicit off switch
	if (settings?.enableReasoningEffort === false) return false

	// Selected effort from settings or model default
	const selectedEffort = (settings?.reasoningEffort ?? (model as any).reasoningEffort) as
		| "disable"
		| "none"
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| "xhigh"
		| "max" // kilocode_change: GPT-5.6 maximum effort
		| undefined

	// "disable" explicitly omits reasoning
	if (selectedEffort === "disable") return false

	const cap = model.supportsReasoningEffort as unknown

	// kilocode_change start: Maximum remains usable through request-time fallback.
	// Capability array: use only if selected is included (treat "none"/"minimal" as valid).
	// `max` is a user preference: when the model does not expose it directly,
	// it resolves to the strongest previous level in the request builder.
	if (Array.isArray(cap)) {
		return (
			!!selectedEffort &&
			((cap as ReadonlyArray<string>).includes(selectedEffort as string) ||
				(selectedEffort === "max" &&
					resolveReasoningEffortForModel(selectedEffort, undefined, model) !== undefined))
		)
	}
	// kilocode_change end

	// Boolean capability: true → require a selected effort
	if (model.supportsReasoningEffort === true) {
		return !!selectedEffort
	}

	// Not explicitly supported: only allow when the model itself defines a default effort
	// Ignore settings-only selections when capability is absent/false
	const modelDefaultEffort = (model as any).reasoningEffort as
		| "none"
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| "xhigh"
		| "max" // kilocode_change: GPT-5.6 maximum effort
		| undefined
	return !!modelDefaultEffort
}

export const DEFAULT_HYBRID_REASONING_MODEL_MAX_TOKENS = 16_384
export const DEFAULT_HYBRID_REASONING_MODEL_THINKING_TOKENS = 8_192
export const GEMINI_25_PRO_MIN_THINKING_TOKENS = 128
// kilocode_change start
const QWEN3_MAX_THINKING_OUTPUT_TOKEN_LIMIT = 32_768
const isPositiveFiniteTokenLimit = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0
// kilocode_change end

// Max Tokens

export const getModelMaxOutputTokens = ({
	modelId,
	model,
	settings,
	format,
}: {
	modelId: string
	model: ModelInfo
	settings?: ProviderSettings
	format?: "anthropic" | "openai" | "gemini" | "openrouter" | "zenmux"
}): number | undefined => {
	if (shouldUseReasoningBudget({ model, settings })) {
		// kilocode_change start: saved providers use -1 as an "automatic" sentinel;
		// it must never become a real output limit or a negative context reserve.
		return isPositiveFiniteTokenLimit(settings?.modelMaxTokens)
			? settings.modelMaxTokens
			: DEFAULT_HYBRID_REASONING_MODEL_MAX_TOKENS
		// kilocode_change end
	}

	const modelMaxTokens = model.maxTokens

	const isAnthropicContext =
		modelId.includes("claude") ||
		format === "anthropic" ||
		(format === "openrouter" && modelId.startsWith("anthropic/")) ||
		(format === "zenmux" && modelId.startsWith("anthropic/"))

	// For "Hybrid" reasoning models, discard the model's actual maxTokens for Anthropic contexts
	/* kilocode_change: don't limit Anthropic model output, no idea why this was done before
	if (model.supportsReasoningBudget && isAnthropicContext) {
		return ANTHROPIC_DEFAULT_MAX_TOKENS
	}*/

	// For Anthropic contexts, always ensure a maxTokens value is set
	if (isAnthropicContext && !isPositiveFiniteTokenLimit(modelMaxTokens)) {
		return ANTHROPIC_DEFAULT_MAX_TOKENS
	}

	// kilocode_change start
	const isQwen3MaxThinkingModel = modelId.toLowerCase().includes("qwen3-max-thinking")
	// kilocode_change end

	// If model has explicit maxTokens, clamp it to 20% of the context window
	// Exception: GPT-5 models should use their exact configured max output tokens
	if (isPositiveFiniteTokenLimit(modelMaxTokens)) {
		// Check if this is a GPT-5 model (case-insensitive)
		const isGpt5Model = modelId.toLowerCase().includes("gpt-5")

		// GPT-5 models bypass the 20% cap and use their full configured max tokens
		if (isGpt5Model) {
			return modelMaxTokens
		}

		const contextCappedMaxTokens = Math.min(modelMaxTokens, Math.ceil(model.contextWindow * 0.2))

		// kilocode_change start
		// qwen3-max-thinking currently rejects values above 32,768 (upstream provider constraint).
		if (isQwen3MaxThinkingModel) {
			return Math.min(contextCappedMaxTokens, QWEN3_MAX_THINKING_OUTPUT_TOKEN_LIMIT)
		}
		// kilocode_change end

		// All other models are clamped to 20% of context window
		return contextCappedMaxTokens
	}

	// For non-Anthropic formats without explicit maxTokens, return undefined
	if (format) {
		return undefined
	}

	// Default fallback
	return ANTHROPIC_DEFAULT_MAX_TOKENS
}

// GetModelsOptions

// Allow callers to always pass apiKey/baseUrl without excess property errors,
// while still enforcing required fields per provider where applicable.
type CommonFetchParams = {
	apiKey?: string
	baseUrl?: string
	allowInsecureTls?: boolean // kilocode_change: explicit per-profile API transport opt-in
}

// Exhaustive, value-level map for all dynamic providers.
// If a new dynamic provider is added in packages/types, this will fail to compile
// until a corresponding entry is added here.
const dynamicProviderExtras = {
	"openai-codex": {} as {}, // eslint-disable-line @typescript-eslint/no-empty-object-type -- kilocode_change: OAuth credentials come from secure storage
	gemini: {} as { apiKey?: string; baseUrl?: string }, // kilocode_change
	openrouter: {} as {}, // eslint-disable-line @typescript-eslint/no-empty-object-type
	zenmux: {} as { apiKey?: string; baseUrl?: string },
	"vercel-ai-gateway": {} as {}, // eslint-disable-line @typescript-eslint/no-empty-object-type
	huggingface: {} as {}, // eslint-disable-line @typescript-eslint/no-empty-object-type
	litellm: {} as { apiKey?: string; baseUrl?: string }, // kilocode_change: parameters optional
	kilocode: {} as { kilocodeToken?: string; kilocodeOrganizationId?: string }, // kilocode_change
	deepinfra: {} as { apiKey?: string; baseUrl?: string },
	"io-intelligence": {} as { apiKey?: string }, // kilocode_change: parameters optional
	requesty: {} as { apiKey?: string; baseUrl?: string },
	unbound: {} as { apiKey?: string },
	// kilocode_change start
	glama: {} as {}, // eslint-disable-line @typescript-eslint/no-empty-object-type
	// kilocode_change end
	"nano-gpt": {} as { nanoGptModelList?: "all" | "personalized" | "subscription" }, // kilocode_change
	ollama: {} as { numCtx?: number }, // kilocode_change
	lmstudio: {} as {}, // eslint-disable-line @typescript-eslint/no-empty-object-type
	oca: {} as { apiKey: string; baseUrl?: string }, // kilocode_change
	ovhcloud: {} as { apiKey?: string }, // kilocode_change
	inception: {} as { apiKey?: string; baseUrl?: string }, // kilocode_change
	synthetic: {} as { apiKey?: string }, // kilocode_change
	roo: {} as { apiKey?: string; baseUrl?: string },
	chutes: {} as { apiKey?: string },
	poe: {} as { apiKey?: string }, // kilocode_change
	// kilocode_change start
	"sap-ai-core": {} as {
		sapAiCoreServiceKey?: string
		sapAiCoreResourceGroup?: string
		sapAiCoreUseOrchestration?: boolean
	},
	aihubmix: {} as { apiKey?: string; baseUrl?: string },
	apertis: {} as { apiKey?: string; baseUrl?: string },
	// kilocode_change end
} as const satisfies Record<RouterName, object>

// Build the dynamic options union from the map, intersected with CommonFetchParams
// so extra fields are always allowed while required ones are enforced.
export type GetModelsOptions = {
	[P in keyof typeof dynamicProviderExtras]: ({ provider: P } & (typeof dynamicProviderExtras)[P]) & CommonFetchParams
}[RouterName]

// kilocode_change start: typed dynamic-provider model discovery
// Preserve provider-specific required fields for literal callers while also
// allowing router-backed handlers whose provider is already a validated union.
export type GetModelsOptionsFor<P extends RouterName> = { provider: P } & (typeof dynamicProviderExtras)[P] &
	CommonFetchParams
// kilocode_change end
