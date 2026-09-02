import posthog from "posthog-js"

import { telemetryClient } from "../TelemetryClient"

vi.mock("posthog-js", () => ({
	default: {
		reset: vi.fn(),
		init: vi.fn(),
		identify: vi.fn(),
		capture: vi.fn(),
		captureException: vi.fn(),
	},
}))

describe("TelemetryClient", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should be a singleton", () => {
		// Basic test to verify the service exists
		expect(telemetryClient).toBeDefined()
	})

	it("should have updateTelemetryState method", () => {
		// Test if the method exists
		expect(typeof telemetryClient.updateTelemetryState).toBe("function")

		// Call it with different values to verify it doesn't throw errors
		expect(() => telemetryClient.updateTelemetryState("enabled")).not.toThrow()
		expect(() => telemetryClient.updateTelemetryState("disabled")).not.toThrow()
		expect(() => telemetryClient.updateTelemetryState("unset")).not.toThrow()
	})

	it("should have capture method", () => {
		// Test if the method exists
		expect(typeof telemetryClient.capture).toBe("function")

		// Call it to verify it doesn't throw errors
		expect(() => telemetryClient.capture("test_event")).not.toThrow()
		expect(() => telemetryClient.capture("test_event", { key: "value" })).not.toThrow()
	})

	it("should never initialize or capture PostHog telemetry in the personal build", () => {
		telemetryClient.updateTelemetryState("enabled", "test-api-key", "test-user-id")
		telemetryClient.capture("test_event", { key: "value" })
		telemetryClient.captureException(new Error("test error"), { key: "value" })

		expect(posthog.reset).not.toHaveBeenCalled()
		expect(posthog.init).not.toHaveBeenCalled()
		expect(posthog.identify).not.toHaveBeenCalled()
		expect(posthog.capture).not.toHaveBeenCalled()
		expect(posthog.captureException).not.toHaveBeenCalled()
	})
})
