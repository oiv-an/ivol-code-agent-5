import type { ModelRecord, ProviderSettings } from "@roo-code/types"
import { render, screen } from "@/utils/test-utils"

import { OpenAICodex } from "../OpenAICodex"

const { modelPickerSpy, postMessageMock } = vi.hoisted(() => ({
	modelPickerSpy: vi.fn(),
	postMessageMock: vi.fn(),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
	}),
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: postMessageMock },
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
	Checkbox: ({ children, checked, disabled }: any) => (
		<label>
			<input type="checkbox" checked={checked} disabled={disabled} readOnly />
			{children}
		</label>
	),
}))

vi.mock("../../ModelPicker", () => ({
	ModelPicker: (props: any) => {
		modelPickerSpy(props)
		return <div data-testid="model-picker">{Object.keys(props.models).join(",")}</div>
	},
}))

vi.mock("../OpenAICodexRateLimitDashboard", () => ({
	OpenAICodexRateLimitDashboard: () => <div data-testid="rate-limit-dashboard" />,
}))

describe("OpenAICodex", () => {
	const apiConfiguration: ProviderSettings = {
		apiProvider: "openai-codex",
		apiModelId: "account-model",
	}
	const setApiConfigurationField = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("uses the signed-in account catalog and its first model as fallback default", () => {
		const models: ModelRecord = {
			"account-model": {
				contextWindow: 370_000,
				supportsPromptCache: true,
			},
			"account-model-2": {
				contextWindow: 370_000,
				supportsPromptCache: true,
			},
		}

		render(
			<OpenAICodex
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				models={models}
			/>,
		)

		expect(screen.getByTestId("model-picker")).toHaveTextContent("account-model,account-model-2")
		expect(modelPickerSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				models,
				defaultModelId: "account-model",
			}),
		)
	})

	it("shows prompt caching as permanently enabled", () => {
		render(<OpenAICodex apiConfiguration={apiConfiguration} setApiConfigurationField={setApiConfigurationField} />)

		const checkbox = screen.getByRole("checkbox", { name: "Enable prompt caching" })
		expect(checkbox).toBeChecked()
		expect(checkbox).toBeDisabled()
	})
})
