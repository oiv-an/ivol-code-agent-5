// npx vitest src/components/welcome/__tests__/WelcomeViewProvider.spec.tsx

import { fireEvent, render, screen } from "@/utils/test-utils"

import * as ExtensionStateContext from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import WelcomeViewProvider from "../WelcomeViewProvider"

const { ExtensionStateContextProvider } = ExtensionStateContext

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, onClick }: any) => (
		<button onClick={onClick} data-testid="vscode-link">
			{children}
		</button>
	),
	VSCodeProgressRing: () => <div data-testid="progress-ring">Loading...</div>,
	VSCodeTextField: ({ value, onKeyUp, placeholder }: any) => (
		<input data-testid="text-field" value={value} onChange={onKeyUp} placeholder={placeholder} />
	),
	VSCodeRadioGroup: ({ children, value }: any) => (
		<div data-testid="radio-group" data-value={value}>
			{children}
		</div>
	),
	VSCodeRadio: ({ children, value }: any) => (
		<div data-testid={`radio-${value}`} data-value={value}>
			{children}
		</div>
	),
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick, variant }: any) => (
		<button onClick={onClick} data-testid={`button-${variant}`}>
			{children}
		</button>
	),
}))

vi.mock("../../settings/ApiOptions", () => ({
	default: () => <div data-testid="api-options">API Options Component</div>,
}))

vi.mock("../../common/Tab", () => ({
	Tab: ({ children }: any) => <div data-testid="tab">{children}</div>,
	TabContent: ({ children }: any) => <div data-testid="tab-content">{children}</div>,
}))

vi.mock("../RooHero", () => ({
	default: () => <div data-testid="roo-hero">Roo Hero</div>,
}))

vi.mock("lucide-react", () => ({
	ArrowLeft: () => <span>left</span>,
	ArrowRight: () => <span>right</span>,
	BadgeInfo: () => <span>info</span>,
	Brain: () => <span>brain</span>,
	TriangleAlert: () => <span>alert</span>,
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("react-i18next", () => ({
	Trans: ({ i18nKey, children }: any) => <span data-testid={`trans-${i18nKey}`}>{children || i18nKey}</span>,
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@/utils/docLinks", () => ({
	buildDocLink: (path: string, source: string) => `https://docs.roocode.com/${path}?utm_source=${source}`,
}))

const renderWelcomeViewProvider = (extensionState = {}) => {
	const useExtensionStateMock = vi.spyOn(ExtensionStateContext, "useExtensionState")
	useExtensionStateMock.mockReturnValue({
		apiConfiguration: {},
		currentApiConfigName: "default",
		setApiConfiguration: vi.fn(),
		uriScheme: "vscode",
		cloudIsAuthenticated: false,
		...extensionState,
	} as any)

	render(
		<ExtensionStateContextProvider>
			<WelcomeViewProvider />
		</ExtensionStateContextProvider>,
	)
}

describe("WelcomeViewProvider personal build", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("opens directly on the personal provider setup", () => {
		renderWelcomeViewProvider()

		expect(screen.getByTestId("radio-group")).toHaveAttribute("data-value", "custom")
		expect(screen.getByTestId("radio-custom")).toBeInTheDocument()
		expect(screen.getByTestId("api-options")).toBeInTheDocument()
		expect(screen.queryByTestId("radio-roo")).not.toBeInTheDocument()
		expect(screen.queryByText(/welcome:landing.greeting/)).not.toBeInTheDocument()
		expect(screen.queryByTestId("button-secondary")).not.toBeInTheDocument()
	})

	it("saves a valid personal OpenAI-compatible configuration", () => {
		const apiConfiguration = {
			apiProvider: "openai",
			openAiBaseUrl: "https://provider.example/v1",
			openAiApiKey: "test-key",
			openAiModelId: "test-model",
		} as const
		renderWelcomeViewProvider({ apiConfiguration })

		fireEvent.click(screen.getByTestId("button-primary"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "upsertApiConfiguration",
			text: "default",
			apiConfiguration,
		})
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "rooCloudSignIn" }))
	})

	it("never offers Roo sign-in from the personal setup", () => {
		renderWelcomeViewProvider({ cloudIsAuthenticated: false })

		expect(screen.queryByText(/rooCloud/)).not.toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "rooCloudSignIn" }))
	})
})
