// kilocode_change - new file
import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"
import { cancelStandaloneWebSearch, handleStandaloneWebSearch, saveStandaloneWebSearch } from "../standaloneWebSearch"

vi.mock("../standaloneWebSearch", () => ({
	handleStandaloneWebSearch: vi.fn(),
	cancelStandaloneWebSearch: vi.fn(),
	disposeStandaloneWebSearch: vi.fn(),
	saveStandaloneWebSearch: vi.fn(),
}))

describe("standalone web search message dispatch", () => {
	beforeEach(() => vi.clearAllMocks())

	const createProvider = () =>
		({
			getCurrentTask: vi.fn(),
			createTask: vi.fn(),
			cancelTask: vi.fn(),
			postStateToWebview: vi.fn(),
		}) as unknown as ClineProvider

	it("starts an independent search without opening or changing a task", async () => {
		const provider = createProvider()
		const message = { type: "startStandaloneWebSearch" as const, requestId: "search-1", text: "synthetic query" }
		await webviewMessageHandler(provider, message)
		expect(handleStandaloneWebSearch).toHaveBeenCalledWith(provider, message)
		expect(provider.getCurrentTask).not.toHaveBeenCalled()
		expect(provider.createTask).not.toHaveBeenCalled()
		expect(provider.postStateToWebview).not.toHaveBeenCalled()
	})

	it("cancels only the standalone operation identified by the request ID", async () => {
		const provider = createProvider()
		await webviewMessageHandler(provider, { type: "cancelStandaloneWebSearch", requestId: "search-1" })
		expect(cancelStandaloneWebSearch).toHaveBeenCalledWith(provider, "search-1")
		expect(provider.getCurrentTask).not.toHaveBeenCalled()
		expect(provider.cancelTask).not.toHaveBeenCalled()
	})

	it("saves by identity without trusting arbitrary UI text or paths", async () => {
		const provider = createProvider()
		const message = {
			type: "saveStandaloneWebSearch" as const,
			requestId: "search-1",
			text: "ignored arbitrary content",
			path: "/ignored-path.md",
		}
		await webviewMessageHandler(provider, message)
		expect(saveStandaloneWebSearch).toHaveBeenCalledWith(provider, "search-1")
		expect(provider.getCurrentTask).not.toHaveBeenCalled()
	})
})
