import { z } from "zod"

export const autocompleteServiceSettingsSchema = z
	.object({
		enableAutoTrigger: z.boolean().optional(),
		enableSmartInlineTaskKeybinding: z.boolean().optional(),
		enableChatAutocomplete: z.boolean().optional(),
		provider: z.string().optional(),
		model: z.string().optional(),
		snoozeUntil: z.number().optional(),
		hasKilocodeProfileWithNoBalance: z.boolean().optional(),
	})
	.optional()

export type AutocompleteServiceSettings = z.infer<typeof autocompleteServiceSettingsSchema>

/**
 * Map of provider names to their default autocomplete models.
 * These are the providers that support autocomplete functionality.
 */
export const AUTOCOMPLETE_PROVIDER_MODELS = new Map([
	["mistral", "codestral-latest"],
	["kilocode", "mistralai/codestral-2508"],
	["openrouter", "mistralai/codestral-2508"],
	["requesty", "mistral/codestral-latest"],
	["bedrock", "mistral.codestral-2508-v1:0"],
	["huggingface", "mistralai/Codestral-22B-v0.1"],
	["litellm", "codestral/codestral-latest"],
	["lmstudio", "mistralai/codestral-22b-v0.1"],
	["ollama", "codestral:latest"],
] as const)

export type AutocompleteProviderKey = typeof AUTOCOMPLETE_PROVIDER_MODELS extends Map<infer K, unknown> ? K : never

export const commitRangeSchema = z.object({
	from: z.string(),
	fromTimeStamp: z.number().optional(),
	to: z.string(),
})

export type CommitRange = z.infer<typeof commitRangeSchema>

export const kiloCodeMetaDataSchema = z.object({
	commitRange: commitRangeSchema.optional(),
})

export type KiloCodeMetaData = z.infer<typeof kiloCodeMetaDataSchema>

export const fastApplyModelSchema = z.enum([
	"auto",
	"morph/morph-v3-fast",
	"morph/morph-v3-large",
	"relace/relace-apply-3",
])

export type FastApplyModel = z.infer<typeof fastApplyModelSchema>

export const fastApplyApiProviderSchema = z.enum(["current", "morph", "kilocode", "openrouter"])

export type FastApplyApiProvider = z.infer<typeof fastApplyApiProviderSchema>

/**
 * Deliberately non-routable base URL for removed Kilo cloud services.
 * Keeping the URL helpers fail-closed prevents legacy callers from reaching a
 * network service even if a saved setting unexpectedly reactivates them.
 */
export const DISABLED_KILOCODE_URL = "ivol-disabled://kilo"

// Retained for source compatibility with older consumers of the types package.
export const DEFAULT_KILOCODE_BACKEND_URL = DISABLED_KILOCODE_URL

export function getKiloBaseUriFromToken(_kilocodeToken?: string): string {
	return DISABLED_KILOCODE_URL
}

/**
 * Maps any legacy target URL to the disabled scheme while retaining only its
 * path, query and fragment for diagnostics.
 *
 * @param targetUrl The target URL to transform
 * @param kilocodeToken Ignored; tokens can never override the disabled target
 * @returns A URL using the disabled scheme
 */
export function getKiloUrlFromToken(targetUrl: string, _kilocodeToken?: string): string {
	let path = targetUrl
	try {
		const target = new URL(targetUrl)
		path = `${target.pathname}${target.search}${target.hash}`
	} catch {
		// Relative paths are handled directly by getDisabledKiloUrl.
	}
	return getDisabledKiloUrl(path)
}

function getDisabledKiloUrl(path: string = ""): string {
	return new URL(path, `${DISABLED_KILOCODE_URL}/`).toString()
}

export function getAppUrl(path: string = ""): string {
	return getDisabledKiloUrl(path)
}

export function getApiUrl(path: string = ""): string {
	return getDisabledKiloUrl(path)
}

export function getExtensionConfigUrl(): string {
	return getDisabledKiloUrl("/extension-config.json")
}
