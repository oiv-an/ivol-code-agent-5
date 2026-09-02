import type { TelemetrySetting } from "@roo-code/types"

// kilocode_change start: personal builds never initialize or emit webview telemetry.
class TelemetryClient {
	private static instance: TelemetryClient

	public updateTelemetryState(_telemetrySetting: TelemetrySetting, _apiKey?: string, _distinctId?: string): void {
		return
	}

	public static getInstance(): TelemetryClient {
		if (!TelemetryClient.instance) {
			TelemetryClient.instance = new TelemetryClient()
		}

		return TelemetryClient.instance
	}

	public captureException(_error: Error, _properties?: Record<string, any>): void {
		return
	}

	public capture(_eventName: string, _properties?: Record<string, any>): void {
		return
	}
}
// kilocode_change end

export const telemetryClient = TelemetryClient.getInstance()
