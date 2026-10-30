// kilocode_change - new file
import type { ProviderSettings } from "@roo-code/types"

import { resolvePinnedToolAvailability, resolveToolSettings, type PinnedToolsSource } from "../resolvePinnedTools"

const active: ProviderSettings = {
	apiProvider: "openai",
	openAiBaseUrl: "https://active.example/v1",
	openAiApiKey: "active-key",
	openAiWebSearchEnabled: false,
}

const pinnedProfile = {
	name: "Proxy",
	id: "p1",
	apiProvider: "openai" as const,
	openAiBaseUrl: "https://proxy.example/v1",
	openAiApiKey: "proxy-key",
}

function source(
	values: Record<string, string>,
	profiles: Record<string, any> = { p1: pinnedProfile },
): PinnedToolsSource {
	return {
		contextProxy: { getValue: (key: string) => values[key] },
		providerSettingsManager: {
			getProfile: async ({ id }: { id: string }) => {
				if (!profiles[id]) throw new Error("not found")
				return profiles[id]
			},
		},
	}
}

describe("resolvePinnedTools", () => {
	it("offers nothing when the active provider is not OpenAI-compatible", async () => {
		const result = await resolvePinnedToolAvailability(
			{ apiProvider: "anthropic" },
			source({
				ivolWebSearchProfileId: "p1",
				ivolImageGenerationProfileId: "p1",
				ivolImageGenerationModelId: "img",
			}),
		)
		expect(result).toEqual({ webSearch: false, imageGeneration: false })
	})

	it("uses the pinned profile and model independently of the active profile", async () => {
		const src = source({
			ivolWebSearchProfileId: "p1",
			ivolWebSearchModelId: "search-model",
			ivolImageGenerationProfileId: "p1",
			ivolImageGenerationModelId: "gpt-image",
		})
		const search = await resolveToolSettings("webSearch", active, src)
		expect(search?.pinnedProfileName).toBe("Proxy")
		expect(search?.settings.openAiBaseUrl).toBe("https://proxy.example/v1")
		expect(search?.settings.openAiWebSearchModelId).toBe("search-model")
		expect(search?.settings.openAiWebSearchEnabled).toBe(true)

		const image = await resolveToolSettings("imageGeneration", active, src)
		expect(image?.settings.openAiApiKey).toBe("proxy-key")
		expect(image?.settings.openAiImageGenerationModelId).toBe("gpt-image")
	})

	it("requires a model for a pinned image profile", async () => {
		expect(
			await resolveToolSettings("imageGeneration", active, source({ ivolImageGenerationProfileId: "p1" })),
		).toBeUndefined()
	})

	it("falls back to the active profile when there is no pin or the pinned profile is gone", async () => {
		expect(await resolveToolSettings("webSearch", active, source({}))).toBeUndefined()
		const withSearch = { ...active, openAiWebSearchEnabled: true }
		const gone = await resolveToolSettings("webSearch", withSearch, source({ ivolWebSearchProfileId: "deleted" }))
		expect(gone?.settings).toBe(withSearch)
		expect(gone?.pinnedProfileName).toBeUndefined()
	})

	it("ignores a pinned profile that is not OpenAI-compatible", async () => {
		const src = source({ ivolWebSearchProfileId: "p2" }, { p2: { name: "Claude", apiProvider: "anthropic" } })
		expect(await resolveToolSettings("webSearch", active, src)).toBeUndefined()
	})
})
