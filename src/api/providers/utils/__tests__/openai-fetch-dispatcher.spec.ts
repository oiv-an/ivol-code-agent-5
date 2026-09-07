// kilocode_change - new file
import { Dispatcher, getGlobalDispatcher } from "undici"
import { createOpenAiFetch } from "../openai-fetch"

describe("OpenAI request-specific dispatcher", () => {
	afterEach(() => vi.restoreAllMocks())

	it("preserves a request proxy dispatcher and overrides only timeout fields", async () => {
		const dispatch = vi.fn().mockReturnValue(true)
		const proxy = { dispatch } as unknown as Dispatcher
		const signal = new AbortController().signal
		const headers = { Authorization: "Bearer fixture-only" }
		const body = "fixture-body"
		const handler = { onError: vi.fn() }
		const options = {
			origin: "https://example.invalid",
			path: "/v1/chat/completions",
			method: "POST" as const,
			headers,
			body,
			headersTimeout: 300_000,
			bodyTimeout: 300_000,
		}
		const originalGlobalDispatcher = getGlobalDispatcher()
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			expect(init?.signal).toBe(signal)
			expect(init?.headers).toBe(headers)
			expect(init?.body).toBe(body)
			const dispatcher = (init as RequestInit & { dispatcher: Dispatcher }).dispatcher
			expect(dispatcher).not.toBe(proxy)
			dispatcher.dispatch(options, handler)
			return new Response("test")
		})

		await createOpenAiFetch(600_000)("https://example.invalid/v1/chat/completions", {
			method: "POST",
			headers,
			body,
			signal,
			dispatcher: proxy,
		} as RequestInit)

		expect(dispatch).toHaveBeenCalledExactlyOnceWith(
			{ ...options, headersTimeout: 600_000, bodyTimeout: 600_000 },
			handler,
		)
		expect(dispatch.mock.contexts[0]).toBe(proxy)
		expect(getGlobalDispatcher()).toBe(originalGlobalDispatcher)
		expect(globalThis.fetch).toBe(fetch)
	})

	it("delegates to the configured global dispatcher when no request dispatcher is supplied", async () => {
		const globalDispatcher = getGlobalDispatcher()
		const dispatch = vi.spyOn(globalDispatcher, "dispatch").mockReturnValue(true)
		const options = { origin: "https://example.invalid", path: "/", method: "GET" as const }
		const handler = { onError: vi.fn() }
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			;(init as RequestInit & { dispatcher: Dispatcher }).dispatcher.dispatch(options, handler)
			return new Response("test")
		})

		await createOpenAiFetch()("https://example.invalid")
		expect(dispatch).toHaveBeenCalledExactlyOnceWith(
			{ ...options, headersTimeout: 600_000, bodyTimeout: 600_000 },
			handler,
		)
		expect(getGlobalDispatcher()).toBe(globalDispatcher)
	})
})
