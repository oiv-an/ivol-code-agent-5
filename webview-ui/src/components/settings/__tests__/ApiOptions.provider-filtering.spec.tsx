import { render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import type { ProviderSettings, OrganizationAllowList } from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useSelectedModel } from "@src/components/ui/hooks/useSelectedModel"

import ApiOptions from "../ApiOptions"
import { MODELS_BY_PROVIDER, PROVIDERS } from "../constants"

// Mock the extension state context
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(() => ({
		organizationAllowList: undefined,
		cloudIsAuthenticated: false,
	})),
}))

// Mock the translation hook
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

// Mock vscode
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock the router models hook
vi.mock("@src/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: () => ({
		data: null,
		refetch: vi.fn(),
	}),
}))

// Mock the selected model hook
vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: vi.fn(() => ({
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		info: null,
	})),
}))

// Mock the OpenRouter model providers hook
vi.mock("@src/components/ui/hooks/useOpenRouterModelProviders", () => ({
	useOpenRouterModelProviders: () => ({
		data: null,
	}),
	OPENROUTER_DEFAULT_PROVIDER_NAME: "Auto",
}))

// Mock the SearchableSelect component to capture the options passed to it
vi.mock("@src/components/ui", () => ({
	SearchableSelect: ({ options, ...props }: any) => {
		// Store the options in a data attribute for testing
		return (
			<div data-testid="searchable-select" data-options={JSON.stringify(options)} {...props}>
				{options.map((opt: any) => (
					<div key={opt.value} data-testid={`option-${opt.value}`}>
						{opt.label}
					</div>
				))}
			</div>
		)
	},
	Select: ({ children }: any) => <div>{children}</div>,
	SelectTrigger: ({ children }: any) => <div>{children}</div>,
	SelectValue: ({ placeholder }: any) => <div>{placeholder}</div>,
	SelectContent: ({ children }: any) => <div>{children}</div>,
	SelectItem: ({ children, value }: any) => <div data-value={value}>{children}</div>,
	Collapsible: ({ children }: any) => <div>{children}</div>,
	CollapsibleTrigger: ({ children }: any) => <div>{children}</div>,
	CollapsibleContent: ({ children }: any) => <div>{children}</div>,
	Slider: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))

// kilocode_change start: the personal build exposes only its explicit provider allowlist.
describe("ApiOptions personal provider allowlist", () => {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
		},
	})

	const defaultProps = {
		uriScheme: "vscode",
		apiConfiguration: {
			apiProvider: "anthropic",
			apiKey: "test-key",
		} as ProviderSettings,
		setApiConfigurationField: vi.fn(),
		fromWelcomeView: false,
		errorMessage: undefined,
		setErrorMessage: vi.fn(),
	}

	const renderWithProviders = (props = defaultProps) => {
		return render(
			<QueryClientProvider client={queryClient}>
				<ApiOptions {...props} />
			</QueryClientProvider>,
		)
	}

	it("shows exactly the five personal providers when no organization allow list is provided", () => {
		renderWithProviders()

		const selectElement = screen.getByTestId("provider-select")
		const options = JSON.parse(selectElement.getAttribute("data-options") || "[]")

		const providerValues = options.map((opt: any) => opt.value)
		expect(providerValues).toEqual(["claude-code", "lmstudio", "ollama", "openai-codex", "openai"])
	})

	it("should hide static providers with empty models", () => {
		// Mock MODELS_BY_PROVIDER to have an empty provider
		const _originalModels = { ...MODELS_BY_PROVIDER }
		;(MODELS_BY_PROVIDER as any).emptyProvider = {}

		// Add the empty provider to PROVIDERS
		PROVIDERS.push({ value: "emptyProvider", label: "Empty Provider", proxy: false })

		renderWithProviders()

		const selectElement = screen.getByTestId("provider-select")
		const options = JSON.parse(selectElement.getAttribute("data-options") || "[]")
		const providerValues = options.map((opt: any) => opt.value)

		// Should NOT include the empty static provider
		expect(providerValues).not.toContain("emptyProvider")

		// Cleanup
		delete (MODELS_BY_PROVIDER as any).emptyProvider
		PROVIDERS.pop()
	})

	it("shows only Ollama and LM Studio among dynamic providers", () => {
		renderWithProviders()

		const selectElement = screen.getByTestId("provider-select")
		const options = JSON.parse(selectElement.getAttribute("data-options") || "[]")
		const providerValues = options.map((opt: any) => opt.value)

		expect(providerValues).toContain("ollama")
		expect(providerValues).toContain("lmstudio")
		expect(providerValues).not.toContain("openrouter")
		expect(providerValues).not.toContain("litellm")
		expect(providerValues).not.toContain("glama")
		expect(providerValues).not.toContain("unbound")
		expect(providerValues).not.toContain("requesty")
		expect(providerValues).not.toContain("io-intelligence")
	})

	it("does not let an organization allow list add hidden providers", () => {
		// Create a mock organization allow list that only allows certain models
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: {
				anthropic: {
					allowAll: false,
					models: ["claude-3-5-sonnet-20241022"], // Only allow one model
				},
				gemini: {
					allowAll: false,
					models: [], // No models allowed
				},
				openrouter: {
					allowAll: true, // Dynamic provider with all models allowed
				},
			},
		}

		// Mock the extension state with the allow list
		vi.mocked(useExtensionState).mockReturnValue({
			organizationAllowList: allowList,
			cloudIsAuthenticated: false,
		} as any)

		renderWithProviders()

		const selectElement = screen.getByTestId("provider-select")
		const options = JSON.parse(selectElement.getAttribute("data-options") || "[]")
		const providerValues = options.map((opt: any) => opt.value)

		expect(providerValues).not.toContain("anthropic")
		expect(providerValues).not.toContain("gemini")
		expect(providerValues).not.toContain("openrouter")
		expect(providerValues).not.toContain("openai-native")
		expect(providerValues).not.toContain("mistral")
		expect(providerValues).toEqual(["claude-code", "lmstudio", "ollama", "openai-codex", "openai"])
	})

	it("keeps a hidden provider hidden even when organization allowAll is true for it", () => {
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: {
				anthropic: {
					allowAll: true, // Allow all models for this provider
				},
			},
		}

		vi.mocked(useExtensionState).mockReturnValue({
			organizationAllowList: allowList,
			cloudIsAuthenticated: false,
		} as any)

		renderWithProviders()

		const selectElement = screen.getByTestId("provider-select")
		const options = JSON.parse(selectElement.getAttribute("data-options") || "[]")
		const providerValues = options.map((opt: any) => opt.value)

		expect(providerValues).not.toContain("anthropic")
		expect(providerValues).toContain("openai")
	})

	it("does not expose a hidden currently selected provider", () => {
		// Add an empty static provider to test
		;(MODELS_BY_PROVIDER as any).testEmptyProvider = {}
		// Add the provider to the PROVIDERS list
		PROVIDERS.push({ value: "testEmptyProvider", label: "Test Empty Provider", proxy: false })

		// Create a mock organization allow list that allows the provider but no models
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: {
				testEmptyProvider: {
					allowAll: true, // Allow the provider itself, but it has no models in MODELS_BY_PROVIDER
				},
				anthropic: {
					allowAll: true, // Allow anthropic for comparison
				},
			},
		}

		vi.mocked(useExtensionState).mockReturnValue({
			organizationAllowList: allowList,
			cloudIsAuthenticated: false,
		} as any)

		// Mock the selected model hook to return testEmptyProvider as the selected provider
		;(useSelectedModel as any).mockReturnValue({
			provider: "testEmptyProvider",
			id: undefined,
			info: null,
		})

		// Render with testEmptyProvider as the selected provider
		const props = {
			...defaultProps,
			apiConfiguration: {
				...defaultProps.apiConfiguration,
				apiProvider: "testEmptyProvider" as any,
			} as ProviderSettings,
		}

		renderWithProviders(props)

		const selectElement = screen.getByTestId("provider-select")
		const options = JSON.parse(selectElement.getAttribute("data-options") || "[]")
		const providerValues = options.map((opt: any) => opt.value)

		expect(providerValues).not.toContain("testEmptyProvider")
		expect(providerValues).not.toContain("anthropic")
		expect(providerValues).toEqual(["claude-code", "lmstudio", "ollama", "openai-codex", "openai"])

		// Cleanup
		delete (MODELS_BY_PROVIDER as any).testEmptyProvider
		PROVIDERS.pop()
	})
})
// kilocode_change end
