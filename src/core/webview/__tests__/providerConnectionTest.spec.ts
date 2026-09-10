// kilocode_change - new file: diagnostic requests are draft-only and isolated per view.
import type { ProviderConnectionTestResult } from "@roo-code/types"
import * as vscode from "vscode"
import { runProviderConnectionTest } from "../../../services/provider-diagnostics"
import {
	cancelProviderConnectionTest,
	disposeProviderConnectionTest,
	handleProviderConnectionTest,
	copyProviderConnectionReport,
} from "../providerConnectionTest"

vi.mock("../../../services/provider-diagnostics", () => ({ runProviderConnectionTest: vi.fn() }))
vi.mock("vscode", () => ({ version: "test-host", env: { clipboard: { writeText: vi.fn() } } }))

const draft = {
	apiProvider: "openai" as const,
	openAiBaseUrl: "https://example.test/v1",
	openAiApiKey: "draft-key",
	openAiModelId: "model-a",
}
const result = (requestId: string): ProviderConnectionTestResult => ({
	requestId,
	status: "success",
	category: "success",
	report: "Sanitized report",
	elapsedMs: 10,
})
const request = (requestId: string) => ({ type: "testProviderConnection" as const, requestId, apiConfiguration: draft })
const host = () => ({
	postMessageToWebview: vi.fn().mockResolvedValue(true),
	getState: vi.fn(),
	getCurrentTask: vi.fn(),
	providerSettingsManager: { saveConfig: vi.fn() },
})

describe("provider connection test routing", () => {
	beforeEach(() => vi.clearAllMocks())

	it("copies only its own last sanitized report through the IDE clipboard", async () => {
		const h = host()
		const clipboard = vi.spyOn(vscode.env.clipboard, "writeText").mockResolvedValue(undefined)
		vi.mocked(runProviderConnectionTest).mockResolvedValue(result("copy"))
		await handleProviderConnectionTest(h, request("copy"))
		await copyProviderConnectionReport(host(), "copy")
		await copyProviderConnectionReport(h, "stale")
		expect(clipboard).not.toHaveBeenCalled()
		await copyProviderConnectionReport(h, "copy")
		expect(clipboard).toHaveBeenCalledWith("Sanitized report")
		expect(h.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "providerConnectionReportCopyResult",
			providerConnectionReportCopyResult: { requestId: "copy", success: true },
		})
		disposeProviderConnectionTest(h)
		await copyProviderConnectionReport(h, "copy")
		expect(clipboard).toHaveBeenCalledTimes(1)
	})

	it("reports clipboard failures without propagating raw platform errors", async () => {
		const h = host()
		vi.spyOn(vscode.env.clipboard, "writeText").mockRejectedValue(new Error("private clipboard details"))
		vi.mocked(runProviderConnectionTest).mockResolvedValue(result("copy-error"))
		await handleProviderConnectionTest(h, request("copy-error"))
		await copyProviderConnectionReport(h, "copy-error")
		expect(h.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "providerConnectionReportCopyResult",
			providerConnectionReportCopyResult: { requestId: "copy-error", success: false },
		})
		expect(JSON.stringify(h.postMessageToWebview.mock.calls)).not.toContain("private clipboard details")
	})

	it("uses only the supplied draft without reading another profile or touching tasks", async () => {
		const h = host()
		vi.mocked(runProviderConnectionTest).mockResolvedValue(result("check-1"))
		await handleProviderConnectionTest(h, request("check-1"))
		expect(runProviderConnectionTest).toHaveBeenCalledWith(
			draft,
			expect.objectContaining({ requestId: "check-1", signal: expect.any(AbortSignal) }),
		)
		expect(h.getState).not.toHaveBeenCalled()
		expect(h.getCurrentTask).not.toHaveBeenCalled()
		expect(h.providerSettingsManager.saveConfig).not.toHaveBeenCalled()
		expect(h.postMessageToWebview).toHaveBeenCalledWith({
			type: "providerConnectionTestResult",
			providerConnectionTestResult: result("check-1"),
		})
	})

	it("rejects a malformed draft without invoking a provider or echoing the credentials", async () => {
		const h = host()
		await handleProviderConnectionTest(h, {
			type: "testProviderConnection",
			requestId: "bad",
			apiConfiguration: { ...draft, openAiApiKey: { secret: "do-not-echo" } } as never,
		})
		expect(runProviderConnectionTest).not.toHaveBeenCalled()
		expect(h.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				providerConnectionTestResult: expect.objectContaining({ status: "error", category: "configuration" }),
			}),
		)
		expect(JSON.stringify(h.postMessageToWebview.mock.calls)).not.toContain("do-not-echo")
	})

	it("ignores invalid request identities", async () => {
		await handleProviderConnectionTest(host(), request("bad\nid"))
		expect(runProviderConnectionTest).not.toHaveBeenCalled()
	})

	it("suppresses duplicate starts and never posts a stale result after a new check", async () => {
		const h = host()
		let finishFirst!: (value: ProviderConnectionTestResult) => void
		vi.mocked(runProviderConnectionTest)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishFirst = resolve
					}),
			)
			.mockResolvedValueOnce(result("new"))
		const first = handleProviderConnectionTest(h, request("old"))
		const firstSignal = vi.mocked(runProviderConnectionTest).mock.calls[0][1].signal
		await handleProviderConnectionTest(h, request("old"))
		expect(runProviderConnectionTest).toHaveBeenCalledOnce()
		await handleProviderConnectionTest(h, request("new"))
		expect(firstSignal.aborted).toBe(true)
		finishFirst(result("old"))
		await first
		expect(h.postMessageToWebview).toHaveBeenCalledOnce()
		expect(h.postMessageToWebview).toHaveBeenCalledWith({
			type: "providerConnectionTestResult",
			providerConnectionTestResult: result("new"),
		})
	})

	it("cancels only the matching check and leaves other windows unaffected", async () => {
		const one = host(),
			two = host()
		const finishes: Array<(value: ProviderConnectionTestResult) => void> = []
		vi.mocked(runProviderConnectionTest).mockImplementation(
			() =>
				new Promise((resolve) => {
					finishes.push(resolve)
				}),
		)
		const first = handleProviderConnectionTest(one, request("one"))
		const second = handleProviderConnectionTest(two, request("two"))
		const [signalOne, signalTwo] = vi.mocked(runProviderConnectionTest).mock.calls.map((call) => call[1].signal)
		cancelProviderConnectionTest(one, "stale")
		expect(signalOne.aborted).toBe(false)
		cancelProviderConnectionTest(one, "one")
		expect(signalOne.aborted).toBe(true)
		expect(signalTwo.aborted).toBe(false)
		finishes[0]({ ...result("one"), status: "cancelled" })
		finishes[1](result("two"))
		await Promise.all([first, second])
	})

	it("disposal aborts the check and suppresses its response to the closed view", async () => {
		const h = host()
		let finish!: (value: ProviderConnectionTestResult) => void
		vi.mocked(runProviderConnectionTest).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		const running = handleProviderConnectionTest(h, request("closing"))
		disposeProviderConnectionTest(h)
		expect(vi.mocked(runProviderConnectionTest).mock.calls[0][1].signal.aborted).toBe(true)
		finish(result("closing"))
		await running
		expect(h.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("does not expose an unexpected runner exception", async () => {
		const h = host()
		vi.mocked(runProviderConnectionTest).mockRejectedValue(new Error("Authorization: Bearer SECRET-DO-NOT-PRINT"))
		await handleProviderConnectionTest(h, request("error"))
		expect(h.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				providerConnectionTestResult: expect.objectContaining({ category: "internal" }),
			}),
		)
		expect(JSON.stringify(h.postMessageToWebview.mock.calls)).not.toContain("SECRET-DO-NOT-PRINT")
	})

	it("does not throw or retry when the webview rejects delivery, and releases the operation", async () => {
		const h = host()
		h.postMessageToWebview.mockRejectedValueOnce(new Error("Disposed view: private detail"))
		vi.mocked(runProviderConnectionTest).mockResolvedValue(result("delivery"))
		await expect(handleProviderConnectionTest(h, request("delivery"))).resolves.toBeUndefined()
		expect(h.postMessageToWebview).toHaveBeenCalledOnce()
		await handleProviderConnectionTest(h, request("delivery"))
		expect(runProviderConnectionTest).toHaveBeenCalledTimes(2)
	})
})
