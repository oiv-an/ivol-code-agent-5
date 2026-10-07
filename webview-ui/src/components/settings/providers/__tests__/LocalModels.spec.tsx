// kilocode_change - new file
import { render, screen } from "@testing-library/react"

import { LMStudio } from "../LMStudio"
import { Ollama } from "../Ollama"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

// The catalog now arrives through a query instead of a raw extension message,
// so the test controls exactly what the component sees.
const routerModels = vi.hoisted(() => ({ data: undefined as unknown }))

vi.mock("@src/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: () => routerModels,
}))

const model = { contextWindow: 8192, supportsPromptCache: false }

describe("local provider model availability", () => {
	beforeEach(() => {
		routerModels.data = undefined
	})

	it("warns when the selected Ollama model is absent from a loaded catalog", () => {
		const config = { apiProvider: "ollama", ollamaModelId: "missing-model" } as const
		const { rerender } = render(<Ollama apiConfiguration={config} setApiConfigurationField={vi.fn()} />)

		expect(screen.queryByText("settings:validation.modelAvailability")).not.toBeInTheDocument()

		routerModels.data = { ollama: { available: model } }
		rerender(<Ollama apiConfiguration={config} setApiConfigurationField={vi.fn()} />)

		expect(screen.getByText("settings:validation.modelAvailability")).toBeInTheDocument()
	})

	it("stays silent when the selected Ollama model is present", () => {
		routerModels.data = { ollama: { available: model } }
		render(
			<Ollama
				apiConfiguration={{ apiProvider: "ollama", ollamaModelId: "available" }}
				setApiConfigurationField={vi.fn()}
			/>,
		)

		expect(screen.queryByText("settings:validation.modelAvailability")).not.toBeInTheDocument()
	})

	it("warns for missing LM Studio main and draft models after loading", () => {
		const config = {
			apiProvider: "lmstudio",
			lmStudioModelId: "missing-main",
			lmStudioDraftModelId: "missing-draft",
			lmStudioSpeculativeDecodingEnabled: true,
		} as const
		const { rerender } = render(<LMStudio apiConfiguration={config} setApiConfigurationField={vi.fn()} />)

		expect(screen.queryByText("settings:validation.modelAvailability")).not.toBeInTheDocument()

		routerModels.data = { lmstudio: { available: model } }
		rerender(<LMStudio apiConfiguration={config} setApiConfigurationField={vi.fn()} />)

		expect(screen.getAllByText("settings:validation.modelAvailability")).toHaveLength(2)
	})
})
