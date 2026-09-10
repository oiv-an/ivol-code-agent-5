// kilocode_change - new file
describe("provider diagnostic draft transport", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
		vi.resetModules()
	})

	it("does not log credentials in the browser-only preview", async () => {
		vi.resetModules()
		vi.stubGlobal("acquireVsCodeApi", undefined)
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
		const { vscode } = await import("../vscode")
		vscode.postMessage({
			type: "testProviderConnection",
			requestId: "preview-test",
			apiConfiguration: { apiProvider: "openai", openAiApiKey: "synthetic-private-value" },
		})
		expect(log).toHaveBeenCalledWith({ type: "testProviderConnection" })
		expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-private-value")
	})

	it("sends the exact draft to the extension host without a preview log", async () => {
		vi.resetModules()
		const postMessage = vi.fn()
		vi.stubGlobal("acquireVsCodeApi", () => ({ postMessage }))
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
		const { vscode } = await import("../vscode")
		const message = {
			type: "testProviderConnection" as const,
			requestId: "host-test",
			apiConfiguration: { apiProvider: "openai" as const, openAiApiKey: "synthetic-private-value" },
		}
		vscode.postMessage(message)
		expect(postMessage).toHaveBeenCalledWith(message)
		expect(log).not.toHaveBeenCalled()
	})

	it("does not record an independent search query in the browser-only preview log", async () => {
		vi.resetModules()
		vi.stubGlobal("acquireVsCodeApi", undefined)
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
		const { vscode } = await import("../vscode")
		vscode.postMessage({
			type: "startStandaloneWebSearch",
			requestId: "standalone-preview",
			text: "synthetic private search query",
		})
		expect(log).toHaveBeenCalledWith({ type: "startStandaloneWebSearch" })
		expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic private search query")
	})
})
