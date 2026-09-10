// kilocode_change - new file: standalone search is private to one view and never mutates coding tasks.
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"
import type { ProviderSettings, StandaloneWebSearchResult } from "@roo-code/types"
import { DEFAULT_OPENAI_WEB_SEARCH_MODEL_ID } from "@roo-code/types"
import {
	OpenAiCompatibleResponsesHandler,
	type OpenAiNativeWebSearchResult,
} from "../../../api/providers/openai-responses"
import {
	cancelStandaloneWebSearch,
	disposeStandaloneWebSearch,
	handleStandaloneWebSearch,
	saveStandaloneWebSearch,
} from "../standaloneWebSearch"

const mocks = vi.hoisted(() => ({ searchWeb: vi.fn() }))
vi.mock("../../../api/providers/openai-responses", () => ({
	OpenAiCompatibleResponsesHandler: vi.fn(),
}))
vi.mock("node:fs/promises", () => ({ writeFile: vi.fn() }))
vi.mock("vscode", () => ({
	window: { showSaveDialog: vi.fn() },
	Uri: { file: vi.fn((fsPath: string) => ({ scheme: "file", fsPath })) },
}))

const settings: ProviderSettings = {
	apiProvider: "openai",
	openAiBaseUrl: "https://proxy.example.test/v1",
	openAiApiKey: "private-key-do-not-echo",
	openAiModelId: "coding-model",
	openAiWebSearchModelId: "search-model",
	openAiHeaders: { "X-Private": "private-header-do-not-echo" },
	allowInsecureTls: true,
	openAiWebSearchEnabled: false,
}
const makeHost = (configuration: ProviderSettings = structuredClone(settings)) => ({
	getState: vi
		.fn()
		.mockResolvedValue({ apiConfiguration: configuration, taskHistory: [{ task: "private-project" }] }),
	postMessageToWebview: vi.fn().mockResolvedValue(undefined),
	getCurrentTask: vi.fn(),
	updateTaskHistory: vi.fn(),
	providerSettingsManager: { saveConfig: vi.fn() },
})
const request = (requestId = "search-1", text = "  Current weather  ") => ({
	type: "startStandaloneWebSearch" as const,
	requestId,
	text,
})
const response = (): OpenAiNativeWebSearchResult => ({
	text: "Answer from a current source.",
	sources: [{ title: "Source", url: "https://example.test/article" }],
	usage: { type: "usage", inputTokens: 10, outputTokens: 20, totalCost: 1 },
})
const updates = (host: ReturnType<typeof makeHost>) => host.postMessageToWebview.mock.calls.map(([message]) => message)
const success = (host: ReturnType<typeof makeHost>) =>
	updates(host).find((message) => message.standaloneWebSearchUpdate?.status === "success")?.standaloneWebSearchUpdate
		.result as StandaloneWebSearchResult
const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve()
}

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((accept, decline) => {
		resolve = accept
		reject = decline
	})
	return { promise, resolve, reject }
}

describe("standalone web search", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.searchWeb.mockReset().mockResolvedValue(response())
		vi.mocked(OpenAiCompatibleResponsesHandler).mockImplementation((configuration) => {
			// The real constructor also supplies defaults in its options. The saved profile must remain unchanged.
			configuration.enableResponsesReasoningSummary = true
			return { searchWeb: mocks.searchWeb } as unknown as OpenAiCompatibleResponsesHandler
		})
		vi.mocked(vscode.window.showSaveDialog).mockReset().mockResolvedValue(undefined)
		vi.mocked(fs.writeFile).mockReset().mockResolvedValue(undefined)
	})
	afterEach(() => vi.useRealTimers())

	it("uses only a cloned saved provider and never reads a task, writes a file, or changes settings", async () => {
		const configuration = structuredClone(settings)
		const original = structuredClone(configuration)
		const host = makeHost(configuration)
		await handleStandaloneWebSearch(host, {
			...request(),
			apiConfiguration: { apiProvider: "anthropic", apiKey: "untrusted-draft" },
		})
		expect(OpenAiCompatibleResponsesHandler).toHaveBeenCalledWith({
			...settings,
			openAiWebSearchEnabled: true,
			enableResponsesReasoningSummary: true,
		})
		expect(configuration).toEqual(original)
		expect(configuration.openAiHeaders).not.toBe(
			vi.mocked(OpenAiCompatibleResponsesHandler).mock.calls[0][0].openAiHeaders,
		)
		expect(mocks.searchWeb).toHaveBeenCalledWith(
			"Current weather",
			"standalone-web-search-search-1",
			expect.any(AbortSignal),
			{
				maxTextChars: 48_000,
				maxSources: 32,
			},
		)
		expect(success(host)).toMatchObject({
			requestId: "search-1",
			query: "Current weather",
			model: "search-model",
			answer: response().text,
			sources: response().sources,
			truncated: false,
		})
		expect(success(host)).not.toHaveProperty("usage")
		expect(host.getCurrentTask).not.toHaveBeenCalled()
		expect(host.updateTaskHistory).not.toHaveBeenCalled()
		expect(host.providerSettingsManager.saveConfig).not.toHaveBeenCalled()
		expect(fs.writeFile).not.toHaveBeenCalled()
		expect(vscode.window.showSaveDialog).not.toHaveBeenCalled()
		expect(JSON.stringify(updates(host))).not.toMatch(/private-key|private-header|private-project|untrusted-draft/)
	})

	it("uses the same default native-search model as the existing search engine", async () => {
		const host = makeHost({ ...settings, openAiWebSearchModelId: " " })
		await handleStandaloneWebSearch(host, request())
		expect(success(host).model).toBe(DEFAULT_OPENAI_WEB_SEARCH_MODEL_ID)
	})

	it.each([
		["", "invalid_query"],
		[" \n ", "invalid_query"],
		["a".repeat(8_001), "query_too_long"],
	])("rejects invalid query input without configuration or provider access", async (text, errorCode) => {
		const host = makeHost()
		await handleStandaloneWebSearch(host, request("invalid", text))
		expect(host.getState).not.toHaveBeenCalled()
		expect(mocks.searchWeb).not.toHaveBeenCalled()
		expect(updates(host)).toEqual([
			{
				type: "standaloneWebSearchUpdate",
				standaloneWebSearchUpdate: { requestId: "invalid", status: "error", errorCode },
			},
		])
	})

	it("rejects invalid identities without echoing them or reading anything", async () => {
		const host = makeHost()
		await handleStandaloneWebSearch(host, request("\ninvalid-secret"))
		expect(host.getState).not.toHaveBeenCalled()
		expect(host.postMessageToWebview).not.toHaveBeenCalled()
	})

	it.each([
		[{ ...settings, apiProvider: "ollama" }, "unsupported_provider"],
		[{ ...settings, openAiApiKey: " " }, "invalid_configuration"],
		[{ ...settings, openAiBaseUrl: "file:///private/credentials" }, "invalid_configuration"],
		[{ ...settings, openAiBaseUrl: "not a URL" }, "invalid_configuration"],
		[{ ...settings, openAiApiKey: { nested: "private-key" } }, "invalid_configuration"],
	])("rejects unsupported or malformed saved configuration", async (configuration, errorCode) => {
		const host = makeHost(configuration as ProviderSettings)
		await handleStandaloneWebSearch(host, request())
		expect(mocks.searchWeb).not.toHaveBeenCalled()
		expect(updates(host).at(-1)?.standaloneWebSearchUpdate).toEqual({
			requestId: "search-1",
			status: "error",
			errorCode,
		})
		expect(JSON.stringify(updates(host))).not.toContain("private-key")
	})

	it("suppresses duplicate starts while running and after success", async () => {
		const host = makeHost()
		const pending = deferred<OpenAiNativeWebSearchResult>()
		mocks.searchWeb.mockReturnValue(pending.promise)
		const running = handleStandaloneWebSearch(host, request())
		await flush()
		await handleStandaloneWebSearch(host, request())
		expect(mocks.searchWeb).toHaveBeenCalledTimes(1)
		pending.resolve(response())
		await running
		await handleStandaloneWebSearch(host, request())
		expect(mocks.searchWeb).toHaveBeenCalledTimes(1)
	})

	it("replacement aborts the old search and ignores even an adapter's late success", async () => {
		const host = makeHost()
		const pending = deferred<OpenAiNativeWebSearchResult>()
		mocks.searchWeb.mockReturnValueOnce(pending.promise)
		const old = handleStandaloneWebSearch(host, request("old"))
		await flush()
		const signal = mocks.searchWeb.mock.calls[0][2] as AbortSignal
		await handleStandaloneWebSearch(host, request("new"))
		expect(signal.aborted).toBe(true)
		await old
		pending.resolve(response())
		await flush()
		expect(updates(host).filter((message) => message.standaloneWebSearchUpdate?.status === "success")).toHaveLength(
			1,
		)
		expect(success(host).requestId).toBe("new")
		await saveStandaloneWebSearch(host, "old")
		expect(vscode.window.showSaveDialog).not.toHaveBeenCalled()
	})

	it("cancel is per view and request; it finishes promptly when an adapter ignores cancellation", async () => {
		const one = makeHost(),
			two = makeHost()
		mocks.searchWeb.mockReturnValue(new Promise(() => undefined))
		const a = handleStandaloneWebSearch(one, request("a"))
		const b = handleStandaloneWebSearch(two, request("b"))
		await flush()
		const [aSignal, bSignal] = mocks.searchWeb.mock.calls.map((args) => args[2] as AbortSignal)
		cancelStandaloneWebSearch(one, "old")
		expect(aSignal.aborted).toBe(false)
		cancelStandaloneWebSearch(one, "a")
		await a
		expect(aSignal.aborted).toBe(true)
		expect(bSignal.aborted).toBe(false)
		expect(updates(one).at(-1)?.standaloneWebSearchUpdate.status).toBe("cancelled")
		disposeStandaloneWebSearch(two)
		await b
		expect(updates(two)).toHaveLength(1)
	})

	it("disposal while configuration is loading cannot start a provider later", async () => {
		const host = makeHost()
		const state = deferred<{ apiConfiguration: ProviderSettings }>()
		host.getState.mockReturnValue(state.promise)
		const running = handleStandaloneWebSearch(host, request())
		await flush()
		disposeStandaloneWebSearch(host)
		await running
		state.resolve({ apiConfiguration: settings })
		await flush()
		expect(mocks.searchWeb).not.toHaveBeenCalled()
		expect(updates(host)).toHaveLength(1)
	})

	it("uses an absolute 180-second deadline covering configuration loading and search", async () => {
		vi.useFakeTimers()
		const host = makeHost()
		const state = deferred<{ apiConfiguration: ProviderSettings }>()
		host.getState.mockReturnValue(state.promise)
		mocks.searchWeb.mockReturnValue(new Promise(() => undefined))
		const running = handleStandaloneWebSearch(host, request())
		await vi.advanceTimersByTimeAsync(120_000)
		state.resolve({ apiConfiguration: settings })
		await flush()
		expect(mocks.searchWeb).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(60_000)
		await running
		expect((mocks.searchWeb.mock.calls[0][2] as AbortSignal).aborted).toBe(true)
		expect(updates(host).at(-1)?.standaloneWebSearchUpdate).toEqual({
			requestId: "search-1",
			status: "error",
			errorCode: "timeout",
		})
	})

	it("caps answer and sources, removes unsafe links, and retains safe source references", async () => {
		const host = makeHost()
		mocks.searchWeb.mockResolvedValue({
			text: "a".repeat(50_000),
			sources: [
				{ title: "Unsafe", url: "javascript:alert(1)" },
				{ title: "Local", url: "file:///private/data" },
				{ title: "Credential", url: "https://secret:secret@example.test" },
				{ title: "Command", url: "command:workbench.action.closeWindow" },
				{ title: "Broken", url: "not a url" },
				...Array.from({ length: 40 }, (_, index) => ({
					title: "s".repeat(600),
					url: `https://example.test/${index}`,
				})),
			],
		})
		await handleStandaloneWebSearch(host, request())
		const result = success(host)
		expect(result.answer).toHaveLength(48_000)
		expect(result.sources).toHaveLength(32)
		expect(result.sources[0].title).toHaveLength(512)
		expect(result.truncated).toBe(true)
		expect(JSON.stringify(result.sources)).not.toMatch(/javascript:|file:|command:|secret/)
	})

	it("reports an empty answer without claiming a successful search", async () => {
		const host = makeHost()
		mocks.searchWeb.mockResolvedValue({ text: "   ", sources: [] })
		await handleStandaloneWebSearch(host, request())
		expect(success(host)).toBeUndefined()
		expect(updates(host).at(-1)?.standaloneWebSearchUpdate.errorCode).toBe("empty_response")
	})

	it.each([
		[{ status: 401 }, "authentication"],
		[{ status: 403 }, "authentication"],
		[{ status: 429 }, "rate_limit"],
		[{ cause: { code: "ECONNRESET" } }, "connection"],
		[{ code: "ETIMEDOUT" }, "timeout"],
		[new Error("Failed to connect to Responses API: Authorization: private-key"), "connection"],
		[new Error("Authentication failed. private-key"), "authentication"],
		[new Error("Responses API returned no text or function call"), "empty_response"],
		[new Error("Authorization: private-key"), "provider"],
	])("returns only a safe fixed error category", async (error, expected) => {
		const host = makeHost()
		mocks.searchWeb.mockRejectedValue(error)
		await handleStandaloneWebSearch(host, request())
		expect(updates(host).at(-1)?.standaloneWebSearchUpdate).toEqual({
			requestId: "search-1",
			status: "error",
			errorCode: expected,
		})
		expect(JSON.stringify(updates(host))).not.toContain("private-key")
	})

	it("does not execute hostile error getters", async () => {
		const host = makeHost()
		const getter = vi.fn(() => {
			throw new Error("private-key")
		})
		mocks.searchWeb.mockRejectedValue(Object.defineProperty({}, "message", { get: getter }))
		await handleStandaloneWebSearch(host, request())
		expect(getter).not.toHaveBeenCalled()
		expect(updates(host).at(-1)?.standaloneWebSearchUpdate.errorCode).toBe("provider")
	})

	it("classifies local configuration-read errors separately without exposing settings", async () => {
		const host = makeHost()
		host.getState.mockRejectedValue(new Error("private-key private-project"))
		await handleStandaloneWebSearch(host, request())
		expect(mocks.searchWeb).not.toHaveBeenCalled()
		expect(updates(host).at(-1)?.standaloneWebSearchUpdate.errorCode).toBe("internal")
		expect(JSON.stringify(updates(host))).not.toContain("private-")
	})

	it("stops without starting a provider if the webview is already unavailable", async () => {
		const host = makeHost()
		host.postMessageToWebview.mockRejectedValue(new Error("private-webview-details"))
		await handleStandaloneWebSearch(host, request())
		expect(host.getState).not.toHaveBeenCalled()
		expect(mocks.searchWeb).not.toHaveBeenCalled()
		expect(host.postMessageToWebview).toHaveBeenCalledTimes(1)
	})
})

describe("standalone search Save", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.searchWeb.mockReset().mockResolvedValue(response())
		vi.mocked(OpenAiCompatibleResponsesHandler).mockImplementation(
			() => ({ searchWeb: mocks.searchWeb }) as unknown as OpenAiCompatibleResponsesHandler,
		)
		vi.mocked(vscode.window.showSaveDialog).mockReset().mockResolvedValue(undefined)
		vi.mocked(fs.writeFile).mockReset().mockResolvedValue(undefined)
	})

	it("saves only the cached result after the native dialog, defaults outside the workspace, never overwrites", async () => {
		const host = makeHost()
		await handleStandaloneWebSearch(host, request())
		expect(fs.writeFile).not.toHaveBeenCalled()
		vi.mocked(vscode.window.showSaveDialog).mockResolvedValue({
			scheme: "file",
			fsPath: "/chosen/answer.md",
		} as vscode.Uri)
		await saveStandaloneWebSearch(host, "search-1")
		expect(vscode.window.showSaveDialog).toHaveBeenCalledWith(
			expect.objectContaining({
				defaultUri: expect.objectContaining({
					fsPath: expect.stringContaining(path.join(os.homedir(), "Downloads", "IVOL-web-search-")),
				}),
				filters: { Markdown: ["md"] },
			}),
		)
		expect(fs.writeFile).toHaveBeenCalledWith("/chosen/answer.md", expect.stringContaining(response().text), {
			encoding: "utf8",
			flag: "wx",
		})
		const contents = vi.mocked(fs.writeFile).mock.calls[0][1] as string
		expect(contents).toContain("> Current weather")
		expect(contents).toContain("https://example.test/article")
		expect(contents).not.toMatch(/private-key|private-header|private-project/)
		expect(updates(host).at(-1)?.standaloneWebSearchSaveResult).toEqual({ requestId: "search-1", status: "saved" })
	})

	it("a save-dialog cancel writes nothing and reports cancellation", async () => {
		const host = makeHost()
		await handleStandaloneWebSearch(host, request())
		await saveStandaloneWebSearch(host, "search-1")
		expect(fs.writeFile).not.toHaveBeenCalled()
		expect(updates(host).at(-1)?.standaloneWebSearchSaveResult.status).toBe("cancelled")
	})

	it.each(["vscode-remote", "http", "command"])("refuses unsupported save URI scheme %s", async (scheme) => {
		const host = makeHost()
		await handleStandaloneWebSearch(host, request())
		vi.mocked(vscode.window.showSaveDialog).mockResolvedValue({ scheme, fsPath: "/unsafe" } as vscode.Uri)
		await saveStandaloneWebSearch(host, "search-1")
		expect(fs.writeFile).not.toHaveBeenCalled()
		expect(updates(host).at(-1)?.standaloneWebSearchSaveResult.errorCode).toBe("unsupported_location")
	})

	it.each([
		[{ code: "EEXIST", message: "secret path" }, "file_exists"],
		[{ code: "EACCES", message: "secret path" }, "save_failed"],
	])("reports filesystem failure safely without overwriting or exposing paths", async (error, errorCode) => {
		const host = makeHost()
		await handleStandaloneWebSearch(host, request())
		vi.mocked(vscode.window.showSaveDialog).mockResolvedValue({
			scheme: "file",
			fsPath: "/chosen/answer.md",
		} as vscode.Uri)
		vi.mocked(fs.writeFile).mockRejectedValue(error)
		await saveStandaloneWebSearch(host, "search-1")
		expect(fs.writeFile).toHaveBeenCalledTimes(1)
		expect(updates(host).at(-1)?.standaloneWebSearchSaveResult).toEqual({
			requestId: "search-1",
			status: "error",
			errorCode,
		})
		expect(JSON.stringify(updates(host))).not.toContain("secret path")
	})

	it.each(["close", "dispose", "replace"])("a pending dialog cannot write after %s", async (action) => {
		const host = makeHost()
		await handleStandaloneWebSearch(host, request())
		const dialog = deferred<vscode.Uri | undefined>()
		vi.mocked(vscode.window.showSaveDialog).mockReturnValue(dialog.promise)
		const saving = saveStandaloneWebSearch(host, "search-1")
		if (action === "close") cancelStandaloneWebSearch(host, "search-1")
		if (action === "dispose") disposeStandaloneWebSearch(host)
		if (action === "replace") await handleStandaloneWebSearch(host, request("replacement"))
		dialog.resolve({ scheme: "file", fsPath: "/chosen/answer.md" } as vscode.Uri)
		await saving
		expect(fs.writeFile).not.toHaveBeenCalled()
		expect(updates(host).some((message) => message.standaloneWebSearchSaveResult?.status === "saved")).toBe(false)
	})

	it("does not allow another view or stale ID to export a cached answer", async () => {
		const host = makeHost()
		await handleStandaloneWebSearch(host, request())
		await saveStandaloneWebSearch(makeHost(), "search-1")
		await saveStandaloneWebSearch(host, "stale")
		expect(vscode.window.showSaveDialog).not.toHaveBeenCalled()
		expect(fs.writeFile).not.toHaveBeenCalled()
	})

	it("allows only one pending save dialog and clears the guard after cancellation", async () => {
		const host = makeHost()
		await handleStandaloneWebSearch(host, request())
		const dialog = deferred<vscode.Uri | undefined>()
		vi.mocked(vscode.window.showSaveDialog).mockReturnValueOnce(dialog.promise)
		const saving = saveStandaloneWebSearch(host, "search-1")
		await saveStandaloneWebSearch(host, "search-1")
		expect(vscode.window.showSaveDialog).toHaveBeenCalledTimes(1)
		dialog.resolve(undefined)
		await saving
		await saveStandaloneWebSearch(host, "search-1")
		expect(vscode.window.showSaveDialog).toHaveBeenCalledTimes(2)
	})
})
