import { type ModelInfo, type ModelRecord, OPENAI_CODEX_CONTEXT_WINDOW } from "@roo-code/types"

import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"
import { Package } from "../../../shared/package"
import { DEFAULT_HEADERS } from "../constants"

const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models"
const CATALOG_TIMEOUT_MS = 30_000

const supportedReasoningEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const)

type SupportedReasoningEffort = typeof supportedReasoningEfforts extends Set<infer T> ? T : never

type CodexCatalogModel = {
	slug?: unknown
	display_name?: unknown
	description?: unknown
	default_reasoning_level?: unknown
	supported_reasoning_levels?: unknown
	visibility?: unknown
	priority?: unknown
}

const readReasoningEffort = (value: unknown): SupportedReasoningEffort | undefined => {
	if (typeof value !== "string") return undefined
	return supportedReasoningEfforts.has(value as SupportedReasoningEffort)
		? (value as SupportedReasoningEffort)
		: undefined
}

const readReasoningEfforts = (value: unknown): SupportedReasoningEffort[] => {
	if (!Array.isArray(value)) return []

	const result: SupportedReasoningEffort[] = []
	for (const item of value) {
		const rawEffort =
			typeof item === "string" ? item : item && typeof item === "object" ? (item as any).effort : undefined
		const effort = readReasoningEffort(rawEffort)
		if (effort && !result.includes(effort)) result.push(effort)
	}
	return result
}

/**
 * Convert the account-specific Codex catalog to the shared ModelInfo shape.
 * The remote context window is deliberately ignored: this build fixes every
 * ChatGPT Plus/Pro model to the user's 370k context budget.
 */
export const normalizeOpenAiCodexCatalog = (payload: unknown): ModelRecord => {
	const rawModels =
		payload && typeof payload === "object" && Array.isArray((payload as any).models)
			? ((payload as any).models as CodexCatalogModel[])
			: []

	const visibleModels = rawModels
		.filter((model) => typeof model?.slug === "string" && model.slug.length > 0 && model.visibility !== "hide")
		.sort((left, right) => {
			const leftPriority = typeof left.priority === "number" ? left.priority : Number.MAX_SAFE_INTEGER
			const rightPriority = typeof right.priority === "number" ? right.priority : Number.MAX_SAFE_INTEGER
			return leftPriority - rightPriority || String(left.slug).localeCompare(String(right.slug))
		})

	const models: ModelRecord = {}
	for (const catalogModel of visibleModels) {
		const id = catalogModel.slug as string
		const efforts = readReasoningEfforts(catalogModel.supported_reasoning_levels)
		const catalogDefault = readReasoningEffort(catalogModel.default_reasoning_level)
		const reasoningEffort =
			catalogDefault && efforts.includes(catalogDefault)
				? catalogDefault
				: efforts.includes("medium")
					? "medium"
					: efforts[0]

		const info: ModelInfo = {
			maxTokens: 128_000,
			contextWindow: OPENAI_CODEX_CONTEXT_WINDOW,
			supportsNativeTools: true,
			defaultToolProtocol: "native",
			includedTools: ["apply_patch"],
			excludedTools: ["apply_diff", "write_to_file"],
			supportsImages: true,
			supportsPromptCache: true,
			...(efforts.length > 0 ? { supportsReasoningEffort: efforts } : {}),
			...(reasoningEffort ? { reasoningEffort } : {}),
			inputPrice: 0,
			outputPrice: 0,
			supportsTemperature: false,
			displayName: typeof catalogModel.display_name === "string" ? catalogModel.display_name : id,
			preferredIndex: typeof catalogModel.priority === "number" ? catalogModel.priority : undefined,
			description:
				typeof catalogModel.description === "string"
					? catalogModel.description
					: `${id} via ChatGPT subscription`,
		}

		models[id] = info
	}

	return models
}

const requestCatalog = async (accessToken: string): Promise<Response> => {
	const url = new URL(CODEX_MODELS_URL)
	url.searchParams.set("client_version", Package.version)

	const accountId = await openAiCodexOAuthManager.getAccountId()
	return fetch(url, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			originator: "kilo-code",
			"User-Agent": DEFAULT_HEADERS["User-Agent"],
			...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
		},
		signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
	})
}

/** Fetch the model catalog available to the currently signed-in ChatGPT account. */
export const getOpenAiCodexModels = async (): Promise<ModelRecord> => {
	let accessToken = await openAiCodexOAuthManager.getAccessToken()
	if (!accessToken) throw new Error("OpenAI Codex is not authenticated")

	let response = await requestCatalog(accessToken)
	if (response.status === 401) {
		accessToken = await openAiCodexOAuthManager.forceRefreshAccessToken()
		if (!accessToken) throw new Error("OpenAI Codex authentication expired")
		response = await requestCatalog(accessToken)
	}

	if (!response.ok) {
		throw new Error(`OpenAI Codex model catalog request failed (${response.status})`)
	}

	const models = normalizeOpenAiCodexCatalog(await response.json())
	if (Object.keys(models).length === 0) {
		throw new Error("OpenAI Codex returned an empty model catalog")
	}

	return models
}
