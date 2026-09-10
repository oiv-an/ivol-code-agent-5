// kilocode_change - new file
import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"
import {
	cancelProviderConnectionTest,
	handleProviderConnectionTest,
	copyProviderConnectionReport,
} from "../providerConnectionTest"

vi.mock("../providerConnectionTest", () => ({
	handleProviderConnectionTest: vi.fn(),
	cancelProviderConnectionTest: vi.fn(),
	disposeProviderConnectionTest: vi.fn(),
	copyProviderConnectionReport: vi.fn(),
}))

describe("provider diagnostic webview message dispatch", () => {
	beforeEach(() => vi.clearAllMocks())

	it("routes report copying by identity without passing arbitrary text", async () => {
		const provider = {} as ClineProvider
		await webviewMessageHandler(provider, {
			type: "copyProviderConnectionReport",
			requestId: "safe-report",
			text: "ignored",
		})
		expect(copyProviderConnectionReport).toHaveBeenCalledWith(provider, "safe-report")
	})

	it("routes the unsaved form draft without reading profile or task state", async () => {
		const provider = {
			getState: vi.fn(),
			getCurrentTask: vi.fn(),
			postMessageToWebview: vi.fn(),
		} as unknown as ClineProvider
		const message = {
			type: "testProviderConnection" as const,
			requestId: "check-form",
			apiConfiguration: { apiProvider: "openai" as const, openAiModelId: "draft-model" },
		}
		await webviewMessageHandler(provider, message)
		expect(handleProviderConnectionTest).toHaveBeenCalledWith(provider, message)
		expect(provider.getState).not.toHaveBeenCalled()
		expect(provider.getCurrentTask).not.toHaveBeenCalled()
	})

	it("routes cancellation by request identity without cancelling an active task", async () => {
		const provider = { getCurrentTask: vi.fn() } as unknown as ClineProvider
		await webviewMessageHandler(provider, { type: "cancelProviderConnectionTest", requestId: "check-form" })
		expect(cancelProviderConnectionTest).toHaveBeenCalledWith(provider, "check-form")
		expect(provider.getCurrentTask).not.toHaveBeenCalled()
	})
})
