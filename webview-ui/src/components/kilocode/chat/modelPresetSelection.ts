import { modelPresetTiers, type ModelPresetTier, type ProviderSettings } from "@roo-code/types"
import { getSelectedModelId } from "../hooks/useSelectedModel"

/** Keep the selected slot independent of reasoning, but never bind it to another model. */
export function getActiveModelPreset(config: ProviderSettings): ModelPresetTier | undefined {
	if (!config.apiProvider || config.profileType === "autocomplete") return undefined
	const currentId = getSelectedModelId({
		provider: config.apiProvider,
		apiConfiguration: config,
		defaultModelId: "",
	})
	const selected = config.activeModelPreset
	if (selected !== undefined) {
		return config.modelPresets?.[selected]?.modelId === currentId && currentId ? selected : undefined
	}
	// Older profiles did not store a slot. Preserve their existing highlight until the next edit.
	return modelPresetTiers.find((tier) => {
		const preset = config.modelPresets?.[tier]
		return (
			!!currentId &&
			preset?.modelId === currentId &&
			preset.reasoningEffort === config.reasoningEffort &&
			preset.enableReasoningEffort === config.enableReasoningEffort
		)
	})
}
