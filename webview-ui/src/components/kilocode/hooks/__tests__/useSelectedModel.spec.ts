import { getModelIdKey } from "../useSelectedModel"

describe("getModelIdKey", () => {
	it.each(["openai", "openai-responses"] as const)("uses openAiModelId for %s", (provider) => {
		expect(getModelIdKey({ provider })).toBe("openAiModelId")
	})
})
