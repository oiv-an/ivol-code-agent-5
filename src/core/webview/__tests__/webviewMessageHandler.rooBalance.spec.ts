import { beforeEach, describe, expect, it, vi } from "vitest"

import { CloudService } from "@roo-code/cloud"
import { webviewMessageHandler } from "../webviewMessageHandler"

vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn(),
		instance: {
			cloudAPI: {
				creditBalance: vi.fn(),
			},
		},
	},
}))

describe("webviewMessageHandler - requestRooCreditBalance", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("fails closed without consulting Roo Cloud", async () => {
		const mockProvider = {
			postMessageToWebview: vi.fn(),
			log: vi.fn(),
			contextProxy: {
				getValue: vi.fn(),
				setValue: vi.fn(),
			},
			getCurrentTask: vi.fn(),
			cwd: "/test/path",
		}
		const requestId = "test-request-id"

		vi.mocked(CloudService.hasInstance).mockReturnValue(true)
		vi.mocked(CloudService.instance.cloudAPI!.creditBalance).mockResolvedValue(42.75)

		await webviewMessageHandler(
			mockProvider as any,
			{
				type: "requestRooCreditBalance",
				requestId,
			} as any,
		)

		expect(CloudService.hasInstance).not.toHaveBeenCalled()
		expect(CloudService.instance.cloudAPI!.creditBalance).not.toHaveBeenCalled()
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "rooCreditBalance",
			requestId,
			values: { error: "Roo provider is unavailable in this personal build" },
		})
		expect(mockProvider.log).toHaveBeenCalledWith("[Models] Ignored Roo credit request in personal build")
	})
})
