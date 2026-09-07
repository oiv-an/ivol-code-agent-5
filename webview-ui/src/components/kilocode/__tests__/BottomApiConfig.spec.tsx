import { cleanup, render, screen } from "@testing-library/react"
import type { ModelInfo, ProviderSettings } from "@roo-code/types"

import { useExtensionState, type ExtensionStateContextType } from "@/context/ExtensionStateContext"
import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { BottomApiConfig } from "../BottomApiConfig"
import { ModelSelector } from "../chat/ModelSelector"
import { ReasoningEffortSelector } from "../chat/ReasoningEffortSelector"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
}))

vi.mock("@/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: vi.fn(),
}))

vi.mock("../chat/ModelSelector", () => ({
	ModelSelector: vi.fn(() => <button>Model selector</button>),
}))

vi.mock("../chat/ReasoningEffortSelector", () => ({
	ReasoningEffortSelector: vi.fn(() => <button>Reasoning selector</button>),
}))

describe("BottomApiConfig", () => {
	const configuredModelInfo: ModelInfo = {
		contextWindow: 128_000,
		supportsPromptCache: true,
	}
	const selectedModelInfo: ModelInfo = {
		contextWindow: 370_000,
		supportsPromptCache: true,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
	}
	const apiConfiguration: ProviderSettings = {
		apiProvider: "openai",
		openAiModelId: "test-gpt-model",
		openAiCustomModelInfo: configuredModelInfo,
		reasoningEffort: "high",
	}

	const setExtensionState = (overrides: Partial<ExtensionStateContextType> = {}) => {
		vi.mocked(useExtensionState).mockReturnValue({
			currentApiConfigName: "My OpenAI profile",
			apiConfiguration,
			virtualQuotaActiveModel: undefined,
			...overrides,
		} as ExtensionStateContextType)
	}

	beforeEach(() => {
		vi.clearAllMocks()
		setExtensionState()
		vi.mocked(useSelectedModel).mockReturnValue({
			id: "test-gpt-model",
			provider: "openai",
			info: selectedModelInfo,
			isLoading: false,
			isError: false,
		})
	})

	afterEach(cleanup)

	it("renders reasoning immediately after the model selector in reading order", () => {
		render(<BottomApiConfig />)

		expect(screen.getAllByRole("button")).toEqual([
			screen.getByRole("button", { name: "Model selector" }),
			screen.getByRole("button", { name: "Reasoning selector" }),
		])
	})

	it("passes the same active profile and configuration to both selectors", () => {
		render(<BottomApiConfig />)

		expect(useSelectedModel).toHaveBeenLastCalledWith(apiConfiguration)
		const modelProps = vi.mocked(ModelSelector).mock.lastCall?.[0]
		const reasoningProps = vi.mocked(ReasoningEffortSelector).mock.lastCall?.[0]
		expect(modelProps?.currentApiConfigName).toBe("My OpenAI profile")
		expect(reasoningProps?.currentApiConfigName).toBe("My OpenAI profile")
		expect(modelProps?.apiConfiguration).toBe(apiConfiguration)
		expect(reasoningProps?.apiConfiguration).toBe(apiConfiguration)
		expect(modelProps?.fallbackText).toBe("openai:test-gpt-model")
	})

	it("passes resolved selected-model metadata rather than the raw custom model settings", () => {
		render(<BottomApiConfig />)

		const reasoningProps = vi.mocked(ReasoningEffortSelector).mock.lastCall?.[0]
		expect(reasoningProps?.modelInfo).toBe(selectedModelInfo)
		expect(reasoningProps?.modelInfo).not.toBe(configuredModelInfo)
	})

	it("preserves virtual-quota model display while passing its resolved capabilities to reasoning", () => {
		setExtensionState({
			virtualQuotaActiveModel: {
				id: "quota-active-model",
				info: selectedModelInfo,
				activeProfileNumber: 2,
			},
		})

		render(<BottomApiConfig />)

		expect(vi.mocked(ModelSelector).mock.lastCall?.[0].virtualQuotaActiveModel).toEqual({
			id: "quota-active-model",
			name: "quota-active-model",
			activeProfileNumber: 2,
		})
		expect(vi.mocked(ReasoningEffortSelector).mock.lastCall?.[0].modelInfo).toBe(selectedModelInfo)
	})

	it("updates both selectors and reasoning metadata when the active profile changes", () => {
		const { rerender } = render(<BottomApiConfig />)
		const nextConfiguration: ProviderSettings = {
			apiProvider: "openai-codex",
			apiModelId: "test-subscription-model",
			reasoningEffort: "max",
		}
		const nextModelInfo: ModelInfo = {
			contextWindow: 370_000,
			supportsPromptCache: true,
			supportsReasoningEffort: ["low", "medium", "high"],
		}
		setExtensionState({ currentApiConfigName: "My subscription", apiConfiguration: nextConfiguration })
		vi.mocked(useSelectedModel).mockReturnValue({
			id: "test-subscription-model",
			provider: "openai-codex",
			info: nextModelInfo,
			isLoading: false,
			isError: false,
		})

		rerender(<BottomApiConfig />)

		expect(useSelectedModel).toHaveBeenLastCalledWith(nextConfiguration)
		const modelProps = vi.mocked(ModelSelector).mock.lastCall?.[0]
		const reasoningProps = vi.mocked(ReasoningEffortSelector).mock.lastCall?.[0]
		expect(modelProps?.currentApiConfigName).toBe("My subscription")
		expect(reasoningProps?.currentApiConfigName).toBe("My subscription")
		expect(modelProps?.apiConfiguration).toBe(nextConfiguration)
		expect(reasoningProps?.apiConfiguration).toBe(nextConfiguration)
		expect(modelProps?.fallbackText).toBe("openai-codex:test-subscription-model")
		expect(reasoningProps?.modelInfo).toBe(nextModelInfo)
		expect(screen.getAllByRole("button")).toHaveLength(2)
	})

	it("renders neither selector when API configuration is unavailable", () => {
		setExtensionState({ apiConfiguration: undefined })

		const { container } = render(<BottomApiConfig />)

		expect(container).toBeEmptyDOMElement()
		expect(ModelSelector).not.toHaveBeenCalled()
		expect(ReasoningEffortSelector).not.toHaveBeenCalled()
		expect(useSelectedModel).toHaveBeenLastCalledWith(undefined)
	})

	it("removes both selectors when the configuration disappears on rerender", () => {
		const { rerender, container } = render(<BottomApiConfig />)
		setExtensionState({ apiConfiguration: undefined })
		vi.mocked(ModelSelector).mockClear()
		vi.mocked(ReasoningEffortSelector).mockClear()

		rerender(<BottomApiConfig />)

		expect(container).toBeEmptyDOMElement()
		expect(ModelSelector).not.toHaveBeenCalled()
		expect(ReasoningEffortSelector).not.toHaveBeenCalled()
	})

	it("forwards missing model metadata while capabilities are still loading", () => {
		vi.mocked(useSelectedModel).mockReturnValue({
			id: "test-gpt-model",
			provider: "openai",
			info: undefined,
			isLoading: true,
			isError: false,
		})

		render(<BottomApiConfig />)

		expect(screen.getByRole("button", { name: "Model selector" })).toBeInTheDocument()
		expect(vi.mocked(ReasoningEffortSelector).mock.lastCall?.[0].modelInfo).toBeUndefined()
	})
})
