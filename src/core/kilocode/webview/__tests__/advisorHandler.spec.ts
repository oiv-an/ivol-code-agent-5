import { handleAdvisor } from "../advisorHandler"
import type { ClineProvider } from "../../../webview/ClineProvider"
const mocks = vi.hoisted(() => ({ getState: vi.fn(), execute: vi.fn(), analyze: vi.fn() }))
vi.mock("../../../../services/kilocode/advisor/workspaceDisabled", () => ({
	readWorkspaceDisabled: vi
		.fn()
		.mockResolvedValue({ status: "available", entries: [{ id: "vue.volar", name: "Vue" }] }),
}))
vi.mock("vscode", () => ({
	workspace: { workspaceFolders: [{ uri: { toString: () => "file:///project" } }] },
	commands: { executeCommand: mocks.execute },
}))
vi.mock("../../../../services/kilocode/advisor/AdvisorService", () => ({
	AdvisorService: class {
		getState = mocks.getState
	},
}))
vi.mock("../../../../services/kilocode/advisor/aiAnalysis", () => ({
	analyzeAdvisor: mocks.analyze,
	advisorWait: (promise: Promise<unknown>, signal: AbortSignal) =>
		new Promise((resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true })
			promise.then(resolve, reject)
		}),
}))
const state = {
	workspace: "file:///project",
	platformSupported: true,
	canScan: true,
	entries: [{ id: "redhat.java" }],
}
function provider() {
	return {
		contextProxy: { rawContext: {} },
		log: vi.fn(),
		getState: vi.fn().mockResolvedValue({ apiConfiguration: { apiProvider: "anthropic" } }),
		postMessageToWebview: vi.fn(),
	} as unknown as ClineProvider
}
beforeEach(() => {
	vi.clearAllMocks()
	mocks.getState.mockResolvedValue(state)
	mocks.analyze.mockResolvedValue(undefined)
})
it("returns a correlated read-only workspace snapshot without commands or AI", async () => {
	const p = provider()
	await handleAdvisor(p, { type: "getAdvisorState", advisorRequestId: "inventory" })
	expect(mocks.execute).not.toHaveBeenCalled()
	expect(mocks.analyze).not.toHaveBeenCalled()
	expect(p.postMessageToWebview).toHaveBeenCalledWith(
		expect.objectContaining({
			advisorRequestId: "inventory",
			advisorState: expect.objectContaining({
				workspaceDisabled: { status: "available", entries: [{ id: "vue.volar", name: "Vue" }] },
			}),
		}),
	)
})
it("uses current provider configuration and correlates the read-only result", async () => {
	const p = provider()
	await handleAdvisor(p, { type: "startAdvisorCheck", advisorRequestId: "scan" })
	expect(mocks.analyze.mock.calls[0][0]).toEqual({ apiProvider: "anthropic" })
	expect(p.postMessageToWebview).toHaveBeenCalledWith(
		expect.objectContaining({
			advisorRequestId: "scan",
			advisorState: expect.objectContaining({
				checked: true,
				ai: expect.objectContaining({ recommendations: [] }),
			}),
		}),
	)
})
it("opens the documented exact-ID query, not model commands", async () => {
	const p = provider()
	await handleAdvisor(p, { type: "openAdvisorExtension", advisorExtensionId: "redhat.java" })
	expect(mocks.execute).toHaveBeenCalledWith("workbench.extensions.search", "@id:redhat.java")
	await handleAdvisor(p, { type: "openAdvisorExtension", advisorExtensionId: "redhat.java @installed" })
	await handleAdvisor(p, { type: "openAdvisorExtension", advisorExtensionId: "unknown.extension" })
	expect(mocks.execute).toHaveBeenCalledTimes(1)
})
it("opens a workspace-disabled extension absent from the public inventory without enabling it", async () => {
	const p = provider()
	await handleAdvisor(p, { type: "openAdvisorExtension", advisorExtensionId: "vue.volar" })
	expect(mocks.execute).toHaveBeenCalledWith("workbench.extensions.search", "@id:vue.volar")
})
it("guards JetBrains native actions and AI inventory", async () => {
	mocks.getState.mockResolvedValue({ ...state, platformSupported: false, canScan: false })
	const p = provider()
	await handleAdvisor(p, { type: "openAdvisorExtension", advisorExtensionId: "redhat.java" })
	await handleAdvisor(p, { type: "startAdvisorCheck", advisorRequestId: "scan" })
	expect(mocks.execute).not.toHaveBeenCalled()
	expect(mocks.analyze).not.toHaveBeenCalled()
})
it("cancels only the matching scan", async () => {
	let started!: () => void
	const ready = new Promise<void>((resolve) => {
		started = resolve
	})
	mocks.analyze.mockImplementation(
		(_config, _root, _entries, signal: AbortSignal) =>
			new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason))
				started()
			}),
	)
	const p = provider()
	const pending = handleAdvisor(p, { type: "startAdvisorCheck", advisorRequestId: "scan" })
	await ready
	await handleAdvisor(p, { type: "cancelAdvisorCheck", advisorRequestId: "other" })
	expect(p.postMessageToWebview).not.toHaveBeenCalled()
	await handleAdvisor(p, { type: "cancelAdvisorCheck", advisorRequestId: "scan" })
	await pending
	expect(p.postMessageToWebview).toHaveBeenCalledWith(
		expect.objectContaining({
			advisorState: expect.objectContaining({
				ai: expect.objectContaining({ cancelled: true, error: "Advisor cancelled" }),
			}),
		}),
	)
})
it("times out a provider request after 90 seconds", async () => {
	vi.useFakeTimers()
	try {
		mocks.analyze.mockImplementation(
			(_config, _root, _entries, signal: AbortSignal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason))
				}),
		)
		const p = provider()
		const pending = handleAdvisor(p, { type: "startAdvisorCheck", advisorRequestId: "timeout" })
		await vi.advanceTimersByTimeAsync(90000)
		await pending
		expect(p.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				advisorState: expect.objectContaining({
					ai: expect.objectContaining({ error: "Advisor timed out after 90 seconds" }),
				}),
			}),
		)
	} finally {
		vi.useRealTimers()
	}
})
