// kilocode_change - new file
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

import { DEFAULT_OPENAI_WEB_SEARCH_MODEL_ID, type ProviderSettings } from "@roo-code/types"
import { vscode } from "@/utils/vscode"
import enChat from "@/i18n/locales/en/chat.json"
import ruChat from "@/i18n/locales/ru/chat.json"
import { StandaloneWebSearch } from "../StandaloneWebSearch"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn(), setState: vi.fn() } }))
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options: Record<string, string> = {}) => {
			const value = key
				.replace("chat:standaloneWebSearch.", "")
				.split(".")
				.reduce<unknown>((part, name) => {
					return part && typeof part === "object" ? (part as Record<string, unknown>)[name] : undefined
				}, enChat.standaloneWebSearch)
			return Object.entries(options).reduce(
				(text, [name, replacement]) => text.replaceAll(`{{${name}}}`, replacement),
				typeof value === "string" ? value : key,
			)
		},
	}),
}))

const configuration: ProviderSettings = {
	apiProvider: "openai",
	openAiBaseUrl: "https://provider.example/v1",
	openAiApiKey: "test-saved-key-never-exposed",
	openAiModelId: "coding-model",
	openAiWebSearchModelId: "search-model",
	openAiWebSearchEnabled: false,
}
const postMessage = vi.mocked(vscode.postMessage)

function openSearch() {
	fireEvent.click(screen.getByRole("button", { name: "Search the web" }))
}

function startSearch(query = "Find current weather in Moscow") {
	fireEvent.change(screen.getByRole("textbox", { name: "What do you want to find?" }), { target: { value: query } })
	fireEvent.click(screen.getByRole("button", { name: "Search" }))
	const message = postMessage.mock.calls.at(-1)?.[0]
	if (message?.type !== "startStandaloneWebSearch" || !message.requestId) throw new Error("Expected search request")
	return message.requestId
}

function update(requestId: string, status = "success", overrides: Record<string, unknown> = {}) {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "standaloneWebSearchUpdate",
					standaloneWebSearchUpdate: {
						requestId,
						status,
						result: {
							requestId,
							query: "Find current weather in Moscow",
							answer: "A useful **search answer**.",
							sources: [{ title: "Weather source", url: "https://weather.example/forecast" }],
							model: "search-model",
							createdAt: "2026-09-09T10:00:00.000Z",
							truncated: false,
						},
						...overrides,
					},
				},
			}),
		)
	})
}

function saveUpdate(requestId: string, status: string, errorCode?: string) {
	act(() =>
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "standaloneWebSearchSaveResult",
					standaloneWebSearchSaveResult: { requestId, status, errorCode },
				},
			}),
		),
	)
}

describe("StandaloneWebSearch", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		postMessage.mockReset()
	})
	afterEach(() => {
		cleanup()
		vi.useRealTimers()
	})

	it("opens an independent dialog and sends only a query and ID even with automatic web search disabled", () => {
		const original = structuredClone(configuration)
		render(<StandaloneWebSearch apiConfiguration={configuration} currentApiConfigName="My saved profile" />)
		openSearch()
		expect(screen.getByRole("dialog", { name: "Web search" })).toBeInTheDocument()
		expect(screen.getByText(/Chat history and project files are not sent/)).toBeInTheDocument()
		expect(screen.getByText(/Provider charges may apply/)).toBeInTheDocument()
		expect(screen.getByText("Search model: search-model")).toBeInTheDocument()
		const requestId = startSearch("  Independent question  ")
		expect(postMessage).toHaveBeenCalledTimes(1)
		expect(postMessage).toHaveBeenCalledWith({
			type: "startStandaloneWebSearch",
			requestId,
			text: "Independent question",
		})
		expect(configuration).toEqual(original)
		expect(vscode.setState).not.toHaveBeenCalled()
		expect(document.body.textContent).not.toContain(configuration.openAiApiKey)
		expect(screen.getByRole("button", { name: "Searching…" })).toBeDisabled()
		expect(screen.getByRole("status")).toHaveTextContent(/preparing an answer/)
	})

	it("shows the provider's default search model before the first request", () => {
		render(<StandaloneWebSearch apiConfiguration={{ ...configuration, openAiWebSearchModelId: undefined }} />)
		openSearch()
		expect(screen.getByText(`Search model: ${DEFAULT_OPENAI_WEB_SEARCH_MODEL_ID}`)).toBeInTheDocument()
		expect(postMessage).not.toHaveBeenCalled()
	})

	it.each([undefined, "ollama", "lmstudio", "openai-codex", "claude-code"])(
		"explains unsupported provider %s without sending a request",
		(apiProvider) => {
			render(
				<StandaloneWebSearch
					apiConfiguration={{ apiProvider: apiProvider as ProviderSettings["apiProvider"] }}
				/>,
			)
			const button = screen.getByRole("button", { name: "Search the web" })
			expect(button).toBeDisabled()
			expect(button.parentElement).toHaveAttribute("title", enChat.standaloneWebSearch.unsupported)
			fireEvent.click(button)
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
			expect(postMessage).not.toHaveBeenCalled()
		},
	)

	it("keeps empty or oversized queries local and prevents duplicate submissions", () => {
		render(<StandaloneWebSearch apiConfiguration={configuration} />)
		openSearch()
		expect(screen.getByRole("button", { name: "Search" })).toBeDisabled()
		const textbox = screen.getByRole("textbox")
		expect(textbox).toHaveAttribute("maxlength", "8000")
		fireEvent.change(textbox, { target: { value: "x".repeat(8_001) } })
		fireEvent.keyDown(textbox, { key: "Enter" })
		expect(postMessage).not.toHaveBeenCalled()
		startSearch()
		fireEvent.keyDown(textbox, { key: "Enter" })
		fireEvent.click(screen.getByRole("button", { name: "Searching…" }))
		expect(postMessage).toHaveBeenCalledTimes(1)
	})

	it("submits with Enter but preserves Shift+Enter and IME composition", () => {
		render(<StandaloneWebSearch apiConfiguration={configuration} />)
		openSearch()
		const textbox = screen.getByRole("textbox")
		fireEvent.change(textbox, { target: { value: "My question" } })
		fireEvent.keyDown(textbox, { key: "Enter", shiftKey: true })
		fireEvent.keyDown(textbox, { key: "Enter", isComposing: true })
		fireEvent.keyDown(textbox, { key: "Enter", keyCode: 229 })
		expect(postMessage).not.toHaveBeenCalled()
		fireEvent.keyDown(textbox, { key: "Enter" })
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: "startStandaloneWebSearch", text: "My question" }),
		)
	})

	it("renders Markdown and source links, saving only the host-owned result ID", () => {
		render(<StandaloneWebSearch apiConfiguration={configuration} />)
		openSearch()
		const requestId = startSearch()
		update(requestId)
		expect(screen.getByText("search answer").tagName).toBe("STRONG")
		expect(screen.getByText("Search model: search-model")).toBeInTheDocument()
		expect(screen.getByText("Answer model: search-model")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("link", { name: "Weather source" }))
		expect(postMessage).toHaveBeenLastCalledWith({ type: "openExternal", url: "https://weather.example/forecast" })
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		expect(postMessage).toHaveBeenLastCalledWith({ type: "saveStandaloneWebSearch", requestId })
		expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled()
		saveUpdate(requestId, "saved")
		expect(screen.getByRole("status")).toHaveTextContent("Search result saved.")
		act(() => vi.advanceTimersByTime(185_000))
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
	})

	it("does not execute raw HTML, load remote images, or open unsafe links", () => {
		render(<StandaloneWebSearch apiConfiguration={configuration} />)
		openSearch()
		const requestId = startSearch()
		update(requestId, "success", {
			result: {
				requestId,
				query: "Security check",
				model: "search-model",
				createdAt: "2026-09-09T10:00:00Z",
				truncated: false,
				answer: '<script>alert("secret")</script>\n\n<img src="https://tracker.example/pixel">\n\n![Remote image](https://tracker.example/image)\n\n[Command](command:run) [File](file:///private/file) [Data](data:text/html,bad) [Script](javascript:alert) [Credentials](https://user:pass@example.com/path) [Relative](/private/file) [Good](https://safe.example/page)',
				sources: [
					{ title: "Unsafe source", url: "javascript:alert(1)" },
					{ title: "Credential source", url: "https://key@example.com" },
					{ title: "Valid source", url: "http://safe.example/source" },
				],
			},
		})
		expect(document.querySelector("script, img, iframe")).toBeNull()
		expect(screen.getAllByRole("link")).toHaveLength(2)
		for (const name of [
			"Command",
			"File",
			"Data",
			"Script",
			"Credentials",
			"Relative",
			"Unsafe source",
			"Credential source",
		]) {
			expect(screen.queryByRole("link", { name })).not.toBeInTheDocument()
		}
		fireEvent.click(screen.getByRole("link", { name: "Good" }))
		expect(postMessage).toHaveBeenLastCalledWith({ type: "openExternal", url: "https://safe.example/page" })
		fireEvent(
			screen.getByRole("link", { name: "Valid source" }),
			new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
		)
		expect(postMessage).toHaveBeenLastCalledWith({ type: "openExternal", url: "http://safe.example/source" })
	})

	it("cancels only this search without cancelling the agent task and ignores its late result", () => {
		render(<StandaloneWebSearch apiConfiguration={configuration} />)
		openSearch()
		const requestId = startSearch()
		fireEvent.click(screen.getByRole("button", { name: "Cancel search" }))
		expect(postMessage).toHaveBeenLastCalledWith({ type: "cancelStandaloneWebSearch", requestId })
		update(requestId)
		expect(screen.getByRole("status")).toHaveTextContent("Search cancelled.")
		expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
		expect(
			postMessage.mock.calls.some(([message]) => ["cancelTask", "newTask", "askResponse"].includes(message.type)),
		).toBe(false)
	})

	it("clears query and result on close and ignores stale events after reopening", () => {
		render(<StandaloneWebSearch apiConfiguration={configuration} />)
		openSearch()
		const requestId = startSearch()
		fireEvent.click(screen.getByRole("button", { name: "Close web search" }))
		expect(postMessage).toHaveBeenLastCalledWith({ type: "cancelStandaloneWebSearch", requestId })
		update(requestId)
		openSearch()
		expect(screen.getByRole("textbox")).toHaveValue("")
		expect(screen.queryByRole("region", { name: "Search result" })).not.toBeInTheDocument()
	})

	it.each([
		["profile", configuration, "Other profile"],
		["model", { ...configuration, openAiWebSearchModelId: "new-search-model" }, "Profile"],
		["credential", { ...configuration, openAiApiKey: "new-test-key" }, "Profile"],
		["provider", { ...configuration, apiProvider: "ollama" as const }, "Profile"],
	] as const)("cancels and closes when the saved %s changes", (_name, nextConfiguration, nextProfile) => {
		const { rerender } = render(
			<StandaloneWebSearch apiConfiguration={configuration} currentApiConfigName="Profile" />,
		)
		openSearch()
		const requestId = startSearch()
		rerender(<StandaloneWebSearch apiConfiguration={nextConfiguration} currentApiConfigName={nextProfile} />)
		expect(postMessage).toHaveBeenLastCalledWith({ type: "cancelStandaloneWebSearch", requestId })
		update(requestId)
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
	})

	it("cancels its pending search on unmount", () => {
		const { unmount } = render(<StandaloneWebSearch apiConfiguration={configuration} />)
		openSearch()
		const requestId = startSearch()
		unmount()
		expect(postMessage).toHaveBeenLastCalledWith({ type: "cancelStandaloneWebSearch", requestId })
	})

	it("ignores unrelated, duplicate and stale replies across consecutive searches", () => {
		render(<StandaloneWebSearch apiConfiguration={configuration} />)
		openSearch()
		const firstId = startSearch()
		update("not-this-request")
		expect(screen.getByRole("button", { name: "Searching…" })).toBeInTheDocument()
		update(firstId)
		update(firstId, "error", { errorCode: "timeout" })
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
		const secondId = startSearch("Another question")
		expect(secondId).not.toBe(firstId)
		update(firstId)
		expect(screen.queryByRole("region", { name: "Search result" })).not.toBeInTheDocument()
		update(secondId)
		expect(screen.getByRole("region", { name: "Search result" })).toBeInTheDocument()
	})

	it("bounds the wait if the extension host stops responding", () => {
		render(<StandaloneWebSearch apiConfiguration={configuration} />)
		openSearch()
		const requestId = startSearch()
		act(() => vi.advanceTimersByTime(185_000))
		expect(screen.getByRole("alert")).toHaveTextContent(enChat.standaloneWebSearch.errors.timeout)
		expect(postMessage).toHaveBeenLastCalledWith({ type: "cancelStandaloneWebSearch", requestId })
		update(requestId)
		expect(screen.queryByRole("region", { name: "Search result" })).not.toBeInTheDocument()
	})

	it("handles an unavailable host without trapping the dialog or exposing raw errors", () => {
		render(<StandaloneWebSearch apiConfiguration={configuration} />)
		openSearch()
		postMessage.mockImplementation(() => {
			throw new Error("sensitive host detail")
		})
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Query" } })
		fireEvent.click(screen.getByRole("button", { name: "Search" }))
		expect(screen.getByRole("alert")).toHaveTextContent(enChat.standaloneWebSearch.errors.internal)
		expect(document.body.textContent).not.toContain("sensitive host detail")
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		fireEvent.click(screen.getByRole("button", { name: "Close web search" }))
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
		expect(warning).toHaveBeenCalledWith(
			"Standalone web search: could not deliver cancellation to the extension host.",
		)
		warning.mockRestore()
	})

	it.each(["connection", "authentication", "rate_limit", "provider", "internal", "unexpected-raw-secret-error"])(
		"uses a fixed safe explanation for error %s",
		(errorCode) => {
			render(<StandaloneWebSearch apiConfiguration={configuration} />)
			openSearch()
			update(startSearch(), "error", { errorCode })
			const expected =
				errorCode in enChat.standaloneWebSearch.errors
					? (errorCode as keyof typeof enChat.standaloneWebSearch.errors)
					: "internal"
			expect(screen.getByRole("alert")).toHaveTextContent(enChat.standaloneWebSearch.errors[expected])
			expect(document.body.textContent).not.toContain("unexpected-raw-secret-error")
		},
	)

	it("handles an empty or wrong-ID success as an empty response rather than exposing Save", () => {
		render(<StandaloneWebSearch apiConfiguration={configuration} />)
		openSearch()
		update(startSearch(), "success", { result: { requestId: "wrong", answer: "", sources: [] } })
		expect(screen.getByRole("alert")).toHaveTextContent(enChat.standaloneWebSearch.errors.empty_response)
		expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
	})

	it("ignores stale save replies and preserves the result after save cancellation or failure", () => {
		render(<StandaloneWebSearch apiConfiguration={configuration} />)
		openSearch()
		const requestId = startSearch()
		update(requestId)
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		saveUpdate("wrong-id", "saved")
		expect(screen.getByRole("button", { name: "Saving…" })).toBeInTheDocument()
		saveUpdate(requestId, "cancelled")
		expect(screen.getByRole("status")).toHaveTextContent(enChat.standaloneWebSearch.saveCancelled)
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		saveUpdate(requestId, "error", "file_exists")
		expect(screen.getByRole("alert")).toHaveTextContent(/existing file was not overwritten/)
		const newId = startSearch("A second query")
		saveUpdate(requestId, "saved")
		update(newId)
		expect(screen.queryByText("Search result saved.")).not.toBeInTheDocument()
	})

	it("drops completed results and a pending save when the dialog closes", () => {
		render(<StandaloneWebSearch apiConfiguration={configuration} />)
		openSearch()
		const requestId = startSearch()
		update(requestId)
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		fireEvent.click(screen.getByRole("button", { name: "Close web search" }))
		expect(postMessage).toHaveBeenLastCalledWith({ type: "cancelStandaloneWebSearch", requestId })
		saveUpdate(requestId, "saved")
		openSearch()
		expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
		expect(screen.queryByText("Search result saved.")).not.toBeInTheDocument()
	})

	it("displays truncation and fits the dialog within a narrow sidebar", () => {
		render(<StandaloneWebSearch apiConfiguration={configuration} />)
		openSearch()
		const requestId = startSearch()
		update(requestId, "success", {
			result: {
				requestId,
				query: "Query",
				answer: "Long answer",
				sources: [],
				model: "search-model",
				truncated: true,
			},
		})
		expect(screen.getByRole("status")).toHaveTextContent(/may be incomplete/)
		expect(screen.getByRole("dialog")).toHaveClass("w-[calc(100%-2rem)]", "max-h-[90vh]", "overflow-y-auto")
	})

	it("has complete matching English/Russian translation keys and placeholders", () => {
		const flatten = (value: object, prefix = ""): Record<string, string> =>
			Object.fromEntries(
				Object.entries(value).flatMap(([key, item]) =>
					typeof item === "string"
						? [[`${prefix}${key}`, item]]
						: Object.entries(flatten(item, `${prefix}${key}.`)),
				),
			)
		const english = flatten(enChat.standaloneWebSearch)
		const russian = flatten(ruChat.standaloneWebSearch)
		expect(Object.keys(russian).sort()).toEqual(Object.keys(english).sort())
		for (const key of Object.keys(english)) {
			expect(russian[key].trim()).not.toBe("")
			expect(russian[key].match(/\{\{[^}]+\}\}/g) ?? []).toEqual(english[key].match(/\{\{[^}]+\}\}/g) ?? [])
		}
	})
})
