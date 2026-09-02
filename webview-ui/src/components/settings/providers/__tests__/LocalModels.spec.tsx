// kilocode_change - new file
import { act, render, screen } from "@testing-library/react"

import { LMStudio } from "../LMStudio"
import { Ollama } from "../Ollama"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

describe("local provider model availability", () => {
	it("warns when the selected Ollama model is absent from a loaded catalog", () => {
		render(
			<Ollama
				apiConfiguration={{ apiProvider: "ollama", ollamaModelId: "missing-model" }}
				setApiConfigurationField={vi.fn()}
			/>,
		)

		expect(screen.queryByText("settings:validation.modelAvailability")).not.toBeInTheDocument()

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "ollamaModels",
						ollamaModels: { available: { contextWindow: 8192, supportsPromptCache: false } },
					},
				}),
			)
		})

		expect(screen.getByText("settings:validation.modelAvailability")).toBeInTheDocument()
	})

	it("warns for missing LM Studio main and draft models after loading", () => {
		render(
			<LMStudio
				apiConfiguration={{
					apiProvider: "lmstudio",
					lmStudioModelId: "missing-main",
					lmStudioDraftModelId: "missing-draft",
					lmStudioSpeculativeDecodingEnabled: true,
				}}
				setApiConfigurationField={vi.fn()}
			/>,
		)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "lmStudioModels",
						lmStudioModels: { available: { contextWindow: 8192, supportsPromptCache: false } },
					},
				}),
			)
		})

		expect(screen.getAllByText("settings:validation.modelAvailability")).toHaveLength(2)
	})
})
