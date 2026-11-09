import type { ProviderSettings } from "@roo-code/types"
import { cleanTaskTitle, generateTelegramTopicName, titleModelSettings } from "../topicTitle"

const settings = {
	apiProvider: "openai",
	openAiModelId: "big-model",
	modelPresets: { min: { modelId: "mini-model" } },
} as ProviderSettings

describe("Telegram topic name", () => {
	it("uses the MIN preset model when configured, otherwise the task model", () => {
		expect(titleModelSettings(settings).openAiModelId).toBe("mini-model")
		expect(titleModelSettings({ ...settings, modelPresets: undefined }).openAiModelId).toBe("big-model")
	})

	it("builds '<project> / <AI title>' with at most 20 title characters", async () => {
		const complete = vi.fn(async () => '"Голосовые сообщения в Telegram бота."')
		const name = await generateTelegramTopicName(
			"ivol-kilocode5",
			"Так, смотри, я хочу улучшить Telegram, чтобы отправлять голосовые",
			settings,
			"Task",
			complete,
		)
		expect(complete).toHaveBeenCalledWith(
			expect.objectContaining({ openAiModelId: "mini-model" }),
			expect.any(String),
		)
		expect(name.startsWith("ivol-kilocode5 / ")).toBe(true)
		expect(Array.from(name.slice("ivol-kilocode5 / ".length)).length).toBeLessThanOrEqual(20)
		expect(name).not.toContain('"')
	})

	it("falls back to the truncated request when the model fails", async () => {
		const name = await generateTelegramTopicName(
			"proj",
			"Fix the login redirect bug on mobile",
			settings,
			"Task",
			async () => {
				throw new Error("offline")
			},
		)
		expect(name).toBe("proj / Fix the login redire")
	})

	it("cleans model chatter", () => {
		expect(cleanTaskTitle("Title: «Fix login»\nextra")).toBe("Fix login")
	})
})
