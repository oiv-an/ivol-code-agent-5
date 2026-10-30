// kilocode_change - new file
import { DEFAULT_OPENAI_WEB_SEARCH_ENABLED, type ProviderSettings } from "@roo-code/types"

import { getOpenAiImageGenerationModel } from "../image-generation/openAiImageGeneration"

/**
 * Web search and image generation can be pinned (IVOL settings) to a saved
 * OpenAI-compatible profile + model, independently of the active profile.
 * The tools are still offered only while the ACTIVE provider is "openai".
 * Without a pin (or when the pinned profile no longer exists) the previous
 * per-profile behavior applies.
 */
export type PinnedToolKind = "webSearch" | "imageGeneration"

export interface PinnedToolsSource {
	contextProxy: { getValue(key: any): any }
	providerSettingsManager: { getProfile(params: { id: string }): Promise<ProviderSettings & { name: string }> }
}

export interface ResolvedToolSettings {
	/** Settings to execute the tool with (URL, key, headers, TLS and model). */
	settings: ProviderSettings
	/** Name of the pinned profile, when a pin is used. */
	pinnedProfileName?: string
}

const PIN_KEYS: Record<PinnedToolKind, { profile: string; model: string }> = {
	webSearch: { profile: "ivolWebSearchProfileId", model: "ivolWebSearchModelId" },
	imageGeneration: { profile: "ivolImageGenerationProfileId", model: "ivolImageGenerationModelId" },
}

function readPin(source: PinnedToolsSource | undefined, kind: PinnedToolKind) {
	const profileId = String(source?.contextProxy.getValue(PIN_KEYS[kind].profile) ?? "").trim()
	const modelId = String(source?.contextProxy.getValue(PIN_KEYS[kind].model) ?? "").trim()
	return { profileId, modelId }
}

function fromActiveProfile(kind: PinnedToolKind, active: ProviderSettings): ResolvedToolSettings | undefined {
	if (kind === "webSearch") {
		const enabled = active.openAiWebSearchEnabled ?? DEFAULT_OPENAI_WEB_SEARCH_ENABLED
		return enabled ? { settings: active } : undefined
	}
	return getOpenAiImageGenerationModel(active) ? { settings: active } : undefined
}

/** Effective settings for a tool, or undefined when the tool must not be offered. */
export async function resolveToolSettings(
	kind: PinnedToolKind,
	active: ProviderSettings | undefined,
	source: PinnedToolsSource | undefined,
): Promise<ResolvedToolSettings | undefined> {
	if (!active || active.apiProvider !== "openai") return undefined

	const { profileId, modelId } = readPin(source, kind)
	if (!profileId || !source) return fromActiveProfile(kind, active)

	let pinned: (ProviderSettings & { name: string }) | undefined
	try {
		pinned = await source.providerSettingsManager.getProfile({ id: profileId })
	} catch {
		pinned = undefined
	}
	// A deleted or non-OpenAI pinned profile falls back to the active profile.
	if (!pinned || pinned.apiProvider !== "openai") return fromActiveProfile(kind, active)

	if (kind === "webSearch") {
		return {
			settings: {
				...pinned,
				openAiWebSearchEnabled: true,
				...(modelId ? { openAiWebSearchModelId: modelId } : {}),
			},
			pinnedProfileName: pinned.name,
		}
	}

	if (!modelId) return undefined
	return {
		settings: { ...pinned, openAiImageGenerationEnabled: true, openAiImageGenerationModelId: modelId },
		pinnedProfileName: pinned.name,
	}
}

/** Which provider-local tools the OpenAI handler should expose for this request. */
export async function resolvePinnedToolAvailability(
	active: ProviderSettings | undefined,
	source: PinnedToolsSource | undefined,
): Promise<{ webSearch: boolean; imageGeneration: boolean }> {
	const [webSearch, imageGeneration] = await Promise.all([
		resolveToolSettings("webSearch", active, source),
		resolveToolSettings("imageGeneration", active, source),
	])
	return { webSearch: !!webSearch, imageGeneration: !!imageGeneration }
}
