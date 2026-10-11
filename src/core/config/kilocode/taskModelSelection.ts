import {
	taskModelSelectionKeys,
	taskModelSelectionSchema,
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
