import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { OpenAICompatible } from "../OpenAICompatible"
import { ProviderSettings } from "@roo-code/types"

// Mock the vscrui Checkbox component
vi.mock("vscrui", () => ({
	Checkbox: ({ children, checked, disabled, onChange }: any) => (
		<label data-testid={`checkbox-${children?.toString().replace(/\s+/g, "-").toLowerCase()}`}>
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled}
				onChange={() => onChange(!checked)} // Toggle the checked state
				data-testid={`checkbox-input-${children?.toString().replace(/\s+/g, "-").toLowerCase()}`}
			/>
			{children}
		</label>
	),
}))

// Mock the VS Code toolkit components
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({
		children,
		value,
		onInput,
		placeholder,
		className,
		style,
		"data-testid": dataTestId,
		...rest
	}: any) => {
		return (
			<div
				data-testid={dataTestId ? `${dataTestId}-text-field` : "vscode-text-field"}
				className={className}
				style={style}>
				{children}
				<input
					type="text"
					value={value}
					onChange={(e) => onInput && onInput(e)}
					placeholder={placeholder}
					data-testid={dataTestId}
					{...rest}
				/>
			</div>
		)
	},
	VSCodeButton: ({ children, onClick, appearance, title }: any) => (
		<button onClick={onClick} title={title} data-testid={`vscode-button-${appearance}`}>
			{children}
		</button>
	),
	VSCodeDropdown: ({ children, value, onChange, className, id, "data-testid": dataTestId }: any) => (
		<select id={id} value={value} onChange={onChange} className={className} data-testid={dataTestId}>
			{children}
		</select>
	),
	VSCodeOption: ({ children, value }: any) => <option value={value}>{children}</option>,
}))

// Mock the translation hook
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

// Mock the UI components
vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
	StandardTooltip: ({ children, content }: any) => <div title={content}>{children}</div>,
}))

// Mock other components
vi.mock("../../ModelPicker", () => ({
	ModelPicker: () => <div data-testid="model-picker">Model Picker</div>,
}))

vi.mock("../../R1FormatSetting", () => ({
	R1FormatSetting: () => <div data-testid="r1-format-setting">R1 Format Setting</div>,
}))

vi.mock("../../ThinkingBudget", () => ({
	ThinkingBudget: ({ modelInfo }: any) => (
		<div data-testid="thinking-budget" data-reasoning-efforts={JSON.stringify(modelInfo?.supportsReasoningEffort)}>
			Thinking Budget
		</div>
	),
}))

// Mock react-use
vi.mock("react-use", () => ({
	useEvent: vi.fn(),
}))

describe("OpenAICompatible Component - includeMaxTokens checkbox", () => {
	const mockSetApiConfigurationField = vi.fn()
	const mockOrganizationAllowList = {
		allowAll: true,
		providers: {},
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("Checkbox Rendering", () => {
		it("should render the includeMaxTokens checkbox", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			// Check that the checkbox is rendered
			const checkbox = screen.getByTestId("checkbox-settings:includemaxoutputtokens")
			expect(checkbox).toBeInTheDocument()

			// Check that the description text is rendered
			expect(screen.getByText("settings:includeMaxOutputTokensDescription")).toBeInTheDocument()
		})

		it("should render the checkbox with correct translation keys", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			// Check that the correct translation key is used for the label
			expect(screen.getByText("settings:includeMaxOutputTokens")).toBeInTheDocument()

			// Check that the correct translation key is used for the description
			expect(screen.getByText("settings:includeMaxOutputTokensDescription")).toBeInTheDocument()
		})
	})

	describe("Initial State", () => {
		it("should show checkbox as checked when includeMaxTokens is true", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).toBeChecked()
		})

		it("should show checkbox as unchecked when includeMaxTokens is false", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: false,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).not.toBeChecked()
		})

		it("should default to checked when includeMaxTokens is undefined", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				// includeMaxTokens is not defined
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).toBeChecked()
		})

		it("should default to checked when includeMaxTokens is null", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: null as any,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).toBeChecked()
		})
	})

	describe("User Interaction", () => {
		it("should call handleInputChange with correct parameters when checkbox is clicked from checked to unchecked", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			fireEvent.click(checkboxInput)

			// Verify setApiConfigurationField was called with correct parameters
			expect(mockSetApiConfigurationField).toHaveBeenCalledWith("includeMaxTokens", false)
		})

		it("should call handleInputChange with correct parameters when checkbox is clicked from unchecked to checked", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: false,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			fireEvent.click(checkboxInput)

			// Verify setApiConfigurationField was called with correct parameters
			expect(mockSetApiConfigurationField).toHaveBeenCalledWith("includeMaxTokens", true)
		})
	})

	describe("Component Updates", () => {
		it("should update checkbox state when apiConfiguration changes", () => {
			const apiConfigurationInitial: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			const { rerender } = render(
				<OpenAICompatible
					apiConfiguration={apiConfigurationInitial as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			// Verify initial state
			let checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).toBeChecked()

			// Update with new configuration
			const apiConfigurationUpdated: Partial<ProviderSettings> = {
				includeMaxTokens: false,
			}

			rerender(
				<OpenAICompatible
					apiConfiguration={apiConfigurationUpdated as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			// Verify updated state
			checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).not.toBeChecked()
		})
	})

	describe("UI Structure", () => {
		it("should render the checkbox with description in correct structure", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			// Check that the checkbox and description are in a div container
			const checkbox = screen.getByTestId("checkbox-settings:includemaxoutputtokens")
			const parentDiv = checkbox.closest("div")
			expect(parentDiv).toBeInTheDocument()

			// Check that the description has the correct styling classes
			const description = screen.getByText("settings:includeMaxOutputTokensDescription")
			expect(description).toHaveClass("text-sm", "text-vscode-descriptionForeground", "ml-6")
		})
	})
})

describe("OpenAICompatible Component - web search checkbox", () => {
	const mockSetApiConfigurationField = vi.fn()
	const mockOrganizationAllowList = {
		allowAll: true,
		providers: {},
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the translated label and defaults web search to enabled with the GPT search model", () => {
		render(
			<OpenAICompatible
				apiConfiguration={{ apiProvider: "openai" }}
				setApiConfigurationField={mockSetApiConfigurationField}
				organizationAllowList={mockOrganizationAllowList}
			/>,
		)

		expect(screen.getByText("settings:providers.openAiWebSearch")).toBeInTheDocument()
		expect(screen.getByText("settings:providers.openAiWebSearchDescription")).toBeInTheDocument()
		expect(screen.getByTestId("checkbox-input-settings:providers.openaiwebsearch")).toBeChecked()
		expect(screen.getByTestId("openai-web-search-model-select")).toHaveValue("1-gpt-sol")
		expect(screen.getByText("settings:providers.openAiWebSearchModelDescription")).toBeInTheDocument()
	})

	it("reflects the saved value and persists user changes through the profile setter", () => {
		render(
			<OpenAICompatible
				apiConfiguration={{ apiProvider: "openai-responses", openAiWebSearchEnabled: true }}
				setApiConfigurationField={mockSetApiConfigurationField}
				organizationAllowList={mockOrganizationAllowList}
			/>,
		)

		const checkbox = screen.getByTestId("checkbox-input-settings:providers.openaiwebsearch")
		expect(checkbox).toBeChecked()
		fireEvent.click(checkbox)
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("openAiWebSearchEnabled", false)
	})

	it("persists a dedicated web-search model from the current provider catalog", () => {
		render(
			<OpenAICompatible
				apiConfiguration={{
					apiProvider: "openai",
					openAiModelId: "main-model",
					openAiWebSearchEnabled: true,
					openAiWebSearchModelId: "gpt-5.6-sol",
				}}
				setApiConfigurationField={mockSetApiConfigurationField}
				organizationAllowList={mockOrganizationAllowList}
			/>,
		)

		const selector = screen.getByTestId("openai-web-search-model-select")
		expect(selector).toHaveValue("gpt-5.6-sol")
		fireEvent.change(selector, { target: { value: "main-model" } })
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("openAiWebSearchModelId", "main-model")
	})

	it("hides the web-search model selector after an explicit opt-out", () => {
		render(
			<OpenAICompatible
				apiConfiguration={{ apiProvider: "openai", openAiWebSearchEnabled: false }}
				setApiConfigurationField={mockSetApiConfigurationField}
				organizationAllowList={mockOrganizationAllowList}
			/>,
		)

		expect(screen.getByTestId("checkbox-input-settings:providers.openaiwebsearch")).not.toBeChecked()
		expect(screen.queryByTestId("openai-web-search-model-select")).not.toBeInTheDocument()
	})

	it("offers the maximum reasoning preference for every custom primary model", () => {
		const { rerender } = render(
			<OpenAICompatible
				apiConfiguration={{
					apiProvider: "openai",
					openAiModelId: "1-gpt-sol",
					openAiWebSearchEnabled: true,
					openAiWebSearchModelId: "older-search-model",
					enableReasoningEffort: true,
				}}
				setApiConfigurationField={mockSetApiConfigurationField}
				organizationAllowList={mockOrganizationAllowList}
			/>,
		)

		expect(screen.getByTestId("thinking-budget")).toHaveAttribute(
			"data-reasoning-efforts",
			JSON.stringify(["low", "medium", "high", "xhigh", "max"]),
		)

		rerender(
			<OpenAICompatible
				apiConfiguration={{
					apiProvider: "openai",
					openAiModelId: "older-model",
					openAiWebSearchEnabled: true,
					openAiWebSearchModelId: "1-gpt-sol",
					enableReasoningEffort: true,
				}}
				setApiConfigurationField={mockSetApiConfigurationField}
				organizationAllowList={mockOrganizationAllowList}
			/>,
		)

		expect(screen.getByTestId("thinking-budget")).toHaveAttribute(
			"data-reasoning-efforts",
			JSON.stringify(["low", "medium", "high", "xhigh", "max"]),
		)
	})

	it("keeps ordinary chat streaming enabled when web search uses a custom base URL", () => {
		render(
			<OpenAICompatible
				apiConfiguration={{
					apiProvider: "openai",
					openAiBaseUrl: "https://prox.example.com",
					openAiWebSearchEnabled: true,
					openAiStreamingEnabled: true,
				}}
				setApiConfigurationField={mockSetApiConfigurationField}
				organizationAllowList={mockOrganizationAllowList}
			/>,
		)

		const streamingCheckbox = screen.getByTestId("checkbox-input-settings:modelinfo.enablestreaming")
		expect(streamingCheckbox).toBeChecked()
		expect(streamingCheckbox).toBeEnabled()
		fireEvent.click(streamingCheckbox)
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("openAiStreamingEnabled", false)
	})
})
