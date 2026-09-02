// kilocode_change - new file
// npx vitest src/components/kilocode/welcome/__tests__/OnboardingView.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"
import OnboardingView from "../OnboardingView"

// Mock Logo component
vi.mock("../../common/Logo", () => ({
	default: () => <div data-testid="ivol-code-agent-logo">Kilo Logo</div>,
}))

describe("OnboardingView", () => {
	const mockOnConfigureProviders = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the Kilo logo", () => {
		render(<OnboardingView onConfigureProviders={mockOnConfigureProviders} />)

		expect(screen.getByTestId("ivol-code-agent-logo")).toBeInTheDocument()
	})

	it("renders the title", () => {
		render(<OnboardingView onConfigureProviders={mockOnConfigureProviders} />)

		// The translation key is returned as-is by the test-utils mock
		expect(screen.getByText("kilocode:onboarding.title")).toBeInTheDocument()
	})

	it("renders only the personal provider setup option", () => {
		render(<OnboardingView onConfigureProviders={mockOnConfigureProviders} />)

		expect(screen.getByText("settings:sections.providers")).toBeInTheDocument()
		expect(screen.getByText("settings:providers.description")).toBeInTheDocument()
		expect(screen.queryByText("kilocode:onboarding.freeModels.title")).not.toBeInTheDocument()
		expect(screen.queryByText("kilocode:onboarding.premiumModels.title")).not.toBeInTheDocument()
	})

	it("opens the provider editor", () => {
		render(<OnboardingView onConfigureProviders={mockOnConfigureProviders} />)

		const providersButton = screen.getByText("settings:sections.providers").closest("button")
		expect(providersButton).toBeInTheDocument()
		fireEvent.click(providersButton!)

		expect(mockOnConfigureProviders).toHaveBeenCalledTimes(1)
	})
})
