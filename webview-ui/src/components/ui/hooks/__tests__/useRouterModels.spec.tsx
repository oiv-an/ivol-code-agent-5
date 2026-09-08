// kilocode_change - new file
import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { WebviewMessage } from "@roo-code/types"
import { vscode } from "@src/utils/vscode"
import { useRouterModels } from "../useRouterModels"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const createWrapper = () => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	return ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	)
}

describe("TLS-scoped router model catalogs", () => {
	beforeEach(() => vi.clearAllMocks())
	it.each(["ollama", "lmstudio", "openai-codex"])(
		"sends the draft TLS policy and correlates %s responses",
		async (provider) => {
			const { result } = renderHook(
				() =>
					useRouterModels(
						{
							profileId: "profile-1",
							allowInsecureTls: true,
							ollamaBaseUrl: "https://ollama.example",
							ollamaApiKey: "test-key",
							ollamaNumCtx: 32000,
							lmStudioBaseUrl: "https://lmstudio.example",
						},
						{ provider },
					),
				{ wrapper: createWrapper() },
			)
			const request = vi.mocked(vscode.postMessage).mock.calls[0][0] as WebviewMessage
			expect(request.values).toEqual({
				provider,
				profileId: "profile-1",
				allowInsecureTls: true,
				baseUrl:
					provider === "ollama"
						? "https://ollama.example"
						: provider === "lmstudio"
							? "https://lmstudio.example"
							: undefined,
				apiKey: provider === "ollama" ? "test-key" : undefined,
				numCtx: provider === "ollama" ? 32000 : undefined,
			})
			act(() =>
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "routerModels",
							requestId: "old-request",
							values: { provider },
							routerModels: { [provider]: { wrong: {} } },
						},
					}),
				),
			)
			expect(result.current.data).toBeUndefined()
			act(() =>
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "routerModels",
							requestId: request.requestId,
							values: { provider },
							routerModels: { [provider]: { correct: {} } },
						},
					}),
				),
			)
			await waitFor(() => expect(result.current.data).toEqual({ [provider]: { correct: {} } }))
		},
	)

	it("does not reuse an insecure catalog after certificate verification is restored", async () => {
		const { result, rerender } = renderHook(
			({ allowInsecureTls }: { allowInsecureTls: boolean }) =>
				useRouterModels({ allowInsecureTls, ollamaBaseUrl: "https://same.example" }, { provider: "ollama" }),
			{ initialProps: { allowInsecureTls: true }, wrapper: createWrapper() },
		)
		const insecure = vi.mocked(vscode.postMessage).mock.calls[0][0] as WebviewMessage
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "routerModels",
						requestId: insecure.requestId,
						values: { provider: "ollama" },
						routerModels: { ollama: { unverified: {} } },
					},
				}),
			),
		)
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		rerender({ allowInsecureTls: false })
		const verified = vi.mocked(vscode.postMessage).mock.calls.at(-1)![0] as WebviewMessage
		expect(verified.values?.allowInsecureTls).toBe(false)
		expect(verified.requestId).not.toBe(insecure.requestId)
		expect(result.current.data).toBeUndefined()
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "routerModels",
						requestId: verified.requestId,
						values: { provider: "ollama" },
						routerModels: { ollama: { verified: {} } },
					},
				}),
			),
		)
		await waitFor(() => expect(result.current.data).toEqual({ ollama: { verified: {} } }))
	})

	it("defaults to verified TLS when a saved profile has no flag", () => {
		const { unmount } = renderHook(() => useRouterModels({}, { provider: "openai-codex" }), {
			wrapper: createWrapper(),
		})
		const request = vi.mocked(vscode.postMessage).mock.calls[0][0] as WebviewMessage
		expect(request.values?.allowInsecureTls).toBe(false)
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "routerModels",
						requestId: request.requestId,
						values: { provider: "openai-codex" },
						routerModels: {},
					},
				}),
			),
		)
		unmount()
	})

	it("sends explicit empty local draft credentials instead of inheriting another profile's key", () => {
		const { unmount } = renderHook(() => useRouterModels({}, { provider: "ollama" }), { wrapper: createWrapper() })
		const request = vi.mocked(vscode.postMessage).mock.calls[0][0] as WebviewMessage
		expect(request.values).toEqual(expect.objectContaining({ baseUrl: "", apiKey: "", allowInsecureTls: false }))
		unmount()
	})

	it("cancels an obsolete debounced settings request before posting it", async () => {
		const { rerender, unmount } = renderHook(
			({ baseUrl }: { baseUrl: string }) =>
				useRouterModels({ ollamaBaseUrl: baseUrl }, { provider: "ollama", debounceMs: 20 }),
			{ initialProps: { baseUrl: "https://old.example" }, wrapper: createWrapper() },
		)
		expect(vscode.postMessage).not.toHaveBeenCalled()
		rerender({ baseUrl: "https://new.example" })
		await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledTimes(1))
		expect((vi.mocked(vscode.postMessage).mock.calls[0][0] as WebviewMessage).values?.baseUrl).toBe(
			"https://new.example",
		)
		unmount()
	})
})
