// kilocode_change - new file
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

import type { ProviderSettings } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import enSettings from "@src/i18n/locales/en/settings.json"

import { ProviderConnectionTest } from "../ProviderConnectionTest"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn(), setState: vi.fn() } }))
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options: Record<string, string> = {}) => {
			const translations = enSettings.providers.connectionTest
			const name = key.replace("settings:providers.connectionTest.", "") as keyof typeof translations
			return Object.entries(options).reduce(
				(text, [variable, value]) => text.replaceAll(`{{${variable}}}`, value),
				translations[name] ?? key,
			)
		},
	}),
}))

const draft: ProviderSettings = {
	apiProvider: "openai",
	openAiApiKey: "unsaved-test-credential",
	openAiBaseUrl: "https://unsaved-provider.example/v1",
	openAiModelId: "unsaved-model",
	openAiHeaders: { "X-Provider-Route": "unsaved-route" },
	allowInsecureTls: true,
}
const postMessage = vi.mocked(vscode.postMessage)
const writeText = vi.fn()

function startTest() {
	fireEvent.click(screen.getByRole("button", { name: "Test" }))
	const message = postMessage.mock.calls.at(-1)?.[0]
	if (message?.type !== "testProviderConnection" || !message.requestId) throw new Error("Expected a test request")
	return message.requestId
}

function completeTest(requestId: string, status = "success", report = "Request completed.\nNo secrets in report.") {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "providerConnectionTestResult",
					providerConnectionTestResult: { requestId, status, report, category: status, elapsedMs: 500 },
				},
			}),
		)
	})
}

describe("ProviderConnectionTest", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		postMessage.mockReset()
		writeText.mockReset().mockResolvedValue(undefined)
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
	})

	afterEach(() => {
		cleanup()
		vi.useRealTimers()
	})

	it("uses the exact unsaved draft without saving, activating a profile, or creating a task", () => {
		const unchangedDraft = structuredClone(draft)
		render(<ProviderConnectionTest apiConfiguration={draft} currentApiConfigName="Inactive draft profile" />)
		const requestId = startTest()
		expect(postMessage).toHaveBeenCalledTimes(1)
		expect(postMessage).toHaveBeenCalledWith({
			type: "testProviderConnection",
			requestId,
			apiConfiguration: unchangedDraft,
		})
		expect(draft).toEqual(unchangedDraft)
		expect(vscode.setState).not.toHaveBeenCalled()
		expect(screen.queryByText(draft.openAiApiKey!)).not.toBeInTheDocument()
		expect(screen.getByText(/Conversation history and project files are not sent/)).toBeInTheDocument()
		expect(screen.getByText(/does not verify tools or long tasks/)).toBeInTheDocument()
	})

	it("prevents duplicate requests and shows a successful reply", () => {
		render(<ProviderConnectionTest apiConfiguration={draft} />)
		const requestId = startTest()
		const pendingButton = screen.getByRole("button", { name: "Testing…" })
		expect(pendingButton).toBeDisabled()
		fireEvent.click(pendingButton)
		expect(postMessage).toHaveBeenCalledTimes(1)
		completeTest(requestId)
		expect(screen.getByRole("status")).toHaveTextContent("Connection verified")
		expect(screen.getByRole("textbox")).toHaveValue("Request completed.\nNo secrets in report.")
		expect(screen.getByRole("button", { name: "Test" })).toBeEnabled()
		act(() => vi.advanceTimersByTime(65_000))
		expect(postMessage).toHaveBeenCalledTimes(1)
	})

	it("renders a failure as plain text and copies the complete report", async () => {
		render(<ProviderConnectionTest apiConfiguration={draft} />)
		const requestId = startTest()
		const report = "HTTP 401 Unauthorized\nRequest ID: provider-123\n<script>not executable</script>"
		completeTest(requestId, "error", report)
		expect(screen.getByRole("status")).toHaveTextContent("Connection test failed")
		expect(screen.getByRole("textbox")).toHaveValue(report)
		expect(screen.getByRole("textbox")).toHaveAttribute("readonly")
		expect(document.querySelector("script")).toBeNull()
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy report" })))
		expect(writeText).toHaveBeenCalledTimes(1)
		expect(writeText).toHaveBeenCalledWith(report)
		expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument()
	})

	it("offers manual copying if clipboard access fails", async () => {
		writeText.mockRejectedValue(new Error("Clipboard unavailable"))
		render(<ProviderConnectionTest apiConfiguration={draft} />)
		completeTest(startTest(), "error", "Useful diagnostic report")
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy report" })))
		expect(screen.getByText(/Select and copy the report above/)).toBeInTheDocument()
		expect(screen.getByRole("textbox")).toHaveValue("Useful diagnostic report")
	})

	it("falls back to the IDE clipboard without sending raw report text and ignores stale acknowledgements", async () => {
		writeText.mockRejectedValue(new Error("Browser clipboard unavailable"))
		render(<ProviderConnectionTest apiConfiguration={draft} />)
		const requestId = startTest()
		completeTest(requestId)
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy report" })))
		expect(postMessage).toHaveBeenLastCalledWith({ type: "copyProviderConnectionReport", requestId })
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "providerConnectionReportCopyResult",
						providerConnectionReportCopyResult: { requestId, success: true },
					},
				}),
			),
		)
		expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument()
		completeTest(startTest(), "error", "New report")
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "providerConnectionReportCopyResult",
						providerConnectionReportCopyResult: { requestId, success: true },
					},
				}),
			),
		)
		expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument()
	})

	it("ignores delayed clipboard feedback from a previous result", async () => {
		let finishCopy!: () => void
		writeText.mockReturnValueOnce(new Promise<void>((resolve) => (finishCopy = resolve)))
		render(<ProviderConnectionTest apiConfiguration={draft} />)
		completeTest(startTest(), "error", "Old report")
		fireEvent.click(screen.getByRole("button", { name: "Copy report" }))
		completeTest(startTest(), "error", "New report")
		await act(async () => finishCopy())
		expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument()
		expect(screen.getByRole("textbox")).toHaveValue("New report")
	})

	it("cancels only its own request and ignores the late success", () => {
		render(<ProviderConnectionTest apiConfiguration={draft} />)
		const requestId = startTest()
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		expect(postMessage).toHaveBeenLastCalledWith({ type: "cancelProviderConnectionTest", requestId })
		expect(screen.getByRole("status")).toHaveTextContent("Test cancelled")
		completeTest(requestId)
		expect(screen.getByRole("status")).toHaveTextContent("Test cancelled")
		expect(screen.getByRole("button", { name: "Test" })).toBeEnabled()
	})

	it("accepts a cancellation reply from the host", () => {
		render(<ProviderConnectionTest apiConfiguration={draft} />)
		completeTest(startTest(), "cancelled", "Host cancelled this check")
		expect(screen.getByRole("status")).toHaveTextContent("Test cancelled")
		expect(screen.getByRole("textbox")).toHaveValue("Host cancelled this check")
	})

	it("ignores unrelated requests, duplicate replies, and a previous test's late reply", () => {
		render(<ProviderConnectionTest apiConfiguration={draft} />)
		const firstId = startTest()
		completeTest("another-request", "error", "Unrelated failure")
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		completeTest(firstId)
		completeTest(firstId, "error", "Duplicate response")
		expect(screen.getByRole("status")).toHaveTextContent("Connection verified")
		const secondId = startTest()
		expect(secondId).not.toEqual(firstId)
		completeTest(firstId, "error", "Stale failure")
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		completeTest(secondId, "error", "Current failure")
		expect(screen.getByRole("textbox")).toHaveValue("Current failure")
	})

	it.each([
		["key", { openAiApiKey: "new-test-credential" }],
		["URL", { openAiBaseUrl: "https://other.example/v1" }],
		["model", { openAiModelId: "other-model" }],
		["TLS", { allowInsecureTls: false }],
		["headers", { openAiHeaders: { "X-Provider-Route": "other-route" } }],
		["provider", { apiProvider: "ollama", ollamaModelId: "local-model" }],
	] as const)("cancels and discards results when the %s draft changes", (_field, change) => {
		const { rerender } = render(<ProviderConnectionTest apiConfiguration={draft} />)
		const requestId = startTest()
		const changedDraft: ProviderSettings = { ...draft, ...change }
		rerender(<ProviderConnectionTest apiConfiguration={changedDraft} />)
		expect(postMessage).toHaveBeenLastCalledWith({ type: "cancelProviderConnectionTest", requestId })
		completeTest(requestId)
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		const currentId = startTest()
		expect(postMessage).toHaveBeenLastCalledWith({
			type: "testProviderConnection",
			requestId: currentId,
			apiConfiguration: changedDraft,
		})
	})

	it("removes an old report after editing and preserves it for equivalent rerenders", () => {
		const { rerender } = render(<ProviderConnectionTest apiConfiguration={draft} />)
		completeTest(startTest())
		rerender(<ProviderConnectionTest apiConfiguration={{ ...draft }} />)
		expect(screen.getByRole("status")).toHaveTextContent("Connection verified")
		rerender(<ProviderConnectionTest apiConfiguration={{ ...draft, openAiModelId: "edited-model" }} />)
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		expect(screen.queryByRole("status")).not.toBeInTheDocument()
	})

	it("invalidates a pending check when switching between profiles with identical values", () => {
		const { rerender } = render(<ProviderConnectionTest apiConfiguration={draft} currentApiConfigName="First" />)
		const requestId = startTest()
		rerender(<ProviderConnectionTest apiConfiguration={draft} currentApiConfigName="Second" />)
		expect(postMessage).toHaveBeenLastCalledWith({ type: "cancelProviderConnectionTest", requestId })
		completeTest(requestId)
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
	})

	it("cancels on unmount and clears its timer", () => {
		const { unmount } = render(<ProviderConnectionTest apiConfiguration={draft} />)
		const requestId = startTest()
		unmount()
		expect(postMessage).toHaveBeenLastCalledWith({ type: "cancelProviderConnectionTest", requestId })
		act(() => vi.advanceTimersByTime(65_000))
		expect(postMessage).toHaveBeenCalledTimes(2)
	})

	it("bounds a missing host response and ignores replies after the UI timeout", () => {
		render(<ProviderConnectionTest apiConfiguration={draft} />)
		const requestId = startTest()
		act(() => vi.advanceTimersByTime(65_000))
		expect(screen.getByRole("status")).toHaveTextContent("Connection test failed")
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("host_timeout")
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain(requestId)
		expect(postMessage).toHaveBeenLastCalledWith({ type: "cancelProviderConnectionTest", requestId })
		completeTest(requestId)
		expect(screen.getByRole("status")).toHaveTextContent("Connection test failed")
		expect(screen.getByRole("button", { name: "Test" })).toBeEnabled()
	})

	it("reports an unavailable host without exposing the draft or thrown error", () => {
		postMessage.mockImplementationOnce(() => {
			throw new Error(`Transport failed with ${draft.openAiApiKey}`)
		})
		render(<ProviderConnectionTest apiConfiguration={draft} />)
		startTest()
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("host_unavailable")
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).not.toContain(draft.openAiApiKey!)
		expect(screen.getByRole("button", { name: "Test" })).toBeEnabled()
		act(() => vi.advanceTimersByTime(65_000))
		expect(postMessage).toHaveBeenCalledTimes(1)
	})
})
