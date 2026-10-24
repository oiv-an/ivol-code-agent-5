import {
	isTypicalProvider,
	modelIdKeysByProvider,
	openAiModelInfoSaneDefaults,
	taskModelSelectionKeys,
	taskModelSelectionSchema,
	type ModelIdKey,
	type ProviderSettings,
	type TaskModelSelection,
} from "@roo-code/types"

/** Capture a complete, non-secret model snapshot. Missing fields mean unset, not inheritance. */
export function pickModelSelection(settings: ProviderSettings): TaskModelSelection {
	return structuredClone(taskModelSelectionSchema.parse(settings))
}

/** Restore only validated model fields; connections and credentials always come from the profile. */
export function applyModelSelection<T extends ProviderSettings>(settings: T, selection?: TaskModelSelection): T {
	if (!selection) return settings
	const parsed = taskModelSelectionSchema.parse(selection)
	if (parsed.apiProvider && parsed.apiProvider !== settings.apiProvider) return settings
	const result = { ...settings }
	for (const key of taskModelSelectionKeys) delete result[key]
	return { ...result, ...structuredClone(parsed) }
}

function getPresetModelIdKey(provider: ProviderSettings["apiProvider"]): ModelIdKey | undefined {
	if (provider === "openai" || provider === "openai-responses") return "openAiModelId"
	return provider && isTypicalProvider(provider) ? modelIdKeysByProvider[provider] : undefined
}

/** Agent Manager: apply the model and reasoning chosen for a sub-agent to a copy of the profile. */
export function applyAgentModelChoice<T extends ProviderSettings>(
	settings: T,
	modelId?: string,
	reasoningEffort?: ProviderSettings["reasoningEffort"],
): T {
	const next: T = { ...settings }
	const modelIdKey = getPresetModelIdKey(settings.apiProvider)
	if (modelId && modelIdKey) (next as ProviderSettings)[modelIdKey] = modelId
	if (!reasoningEffort) return next
	next.reasoningEffort = reasoningEffort
	next.enableReasoningEffort = reasoningEffort !== "disable"
	if (settings.apiProvider === "openai" || settings.apiProvider === "openai-responses") {
		const info = { ...(settings.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults) }
		if (reasoningEffort === "disable") delete info.reasoningEffort
		else info.reasoningEffort = reasoningEffort
		next.openAiCustomModelInfo = info
	}
	return next
}

/**
 * New conversations always start on the MAX preset when the profile has one configured.
 * Only the runtime conversation view changes; the stored profile defaults stay untouched.
 */
export function applyMaxModelPreset<T extends ProviderSettings>(settings: T): T {
	const preset = settings.modelPresets?.max
	if (!preset?.modelId || settings.profileType === "autocomplete") return settings
	const modelIdKey = getPresetModelIdKey(settings.apiProvider)
	if (!modelIdKey) return settings
	const next: T = {
		...settings,
		[modelIdKey]: preset.modelId,
		reasoningEffort: preset.reasoningEffort,
		enableReasoningEffort: preset.enableReasoningEffort,
		activeModelPreset: "max",
	}
	if (settings.apiProvider === "openai" || settings.apiProvider === "openai-responses") {
		const info = { ...(settings.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults) }
		if (!preset.reasoningEffort || preset.reasoningEffort === "disable") delete info.reasoningEffort
		else info.reasoningEffort = preset.reasoningEffort
		next.openAiCustomModelInfo = info
	}
	return next
}
