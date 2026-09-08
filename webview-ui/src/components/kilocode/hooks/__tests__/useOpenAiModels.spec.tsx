import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { WebviewMessage } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

import { useOpenAiModels } from "../useOpenAiModels"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

const createWrapper = () => {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
		},
	})

	return ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	)
}

describe("useOpenAiModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("requests and exposes every model returned by an OpenAI-compatible provider", async () => {
		const { result } = renderHook(
			() =>
				useOpenAiModels({
					profileId: "profile-id",
					baseUrl: "https://provider.example/v1",
					apiKey: "test-key",
					openAiHeaders: { "X-Test": "value" },
					allowInsecureTls: false,
				}),
			{ wrapper: createWrapper() },
		)

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "requestOpenAiModels",
				requestId: expect.any(String),
				values: {
					profileId: "profile-id",
					baseUrl: "https://provider.example/v1",
					apiKey: "test-key",
					openAiHeaders: { "X-Test": "value" },
					allowInsecureTls: false,
				},
			}),
		)

		const requestId = (vi.mocked(vscode.postMessage).mock.calls[0][0] as { requestId?: string }).requestId

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "openAiModels",
						requestId: "another-profile-request",
						openAiModels: ["wrong-model"],
					},
				}),
			)
		})

		expect(result.current.isSuccess).toBe(false)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "openAiModels", requestId, openAiModels: ["model-one", "model-two"] },
				}),
			)
		})

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(Object.keys(result.current.data ?? {})).toEqual(["model-one", "model-two"])
	})

	it("replaces an immediate saved catalog with its background refresh", async () => {
		const { result } = renderHook(
			() =>
				useOpenAiModels({
					profileId: "profile-id",
					baseUrl: "https://provider.example/v1",
					apiKey: "test-key",
				}),
			{ wrapper: createWrapper() },
		)

		const requestId = (vi.mocked(vscode.postMessage).mock.calls[0][0] as { requestId?: string }).requestId

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "openAiModels",
						requestId,
						openAiModels: ["saved-model"],
						values: { backgroundRefreshPending: true },
					},
				}),
			)
		})

		await waitFor(() => expect(Object.keys(result.current.data ?? {})).toEqual(["saved-model"]))

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "openAiModels",
						requestId,
						openAiModels: ["fresh-model-one", "fresh-model-two"],
						values: { backgroundRefresh: true },
					},
				}),
			)
		})

		await waitFor(() =>
			expect(Object.keys(result.current.data ?? {})).toEqual(["fresh-model-one", "fresh-model-two"]),
		)
	})

	it("does not request models when credentials are incomplete", () => {
		renderHook(() => useOpenAiModels({ baseUrl: "https://provider.example/v1" }), {
			wrapper: createWrapper(),
		})

		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("separates insecure and verified catalogs and ignores a previous transport response", async () => {
		const { result, rerender } = renderHook(
			({ allowInsecureTls }: { allowInsecureTls: boolean }) =>
				useOpenAiModels({ baseUrl: "https://provider.example/v1", apiKey: "test-key", allowInsecureTls }),
			{ initialProps: { allowInsecureTls: true }, wrapper: createWrapper() },
		)
		const insecure = vi.mocked(vscode.postMessage).mock.calls[0][0] as WebviewMessage
		expect(insecure.values?.allowInsecureTls).toBe(true)
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "openAiModels",
						requestId: insecure.requestId,
						openAiModels: ["unverified-catalog"],
					},
				}),
			),
		)
		await waitFor(() => expect(Object.keys(result.current.data ?? {})).toEqual(["unverified-catalog"]))
		rerender({ allowInsecureTls: false })
		const verified = vi.mocked(vscode.postMessage).mock.calls.at(-1)![0] as WebviewMessage
		expect(verified.values?.allowInsecureTls).toBe(false)
		expect(verified.requestId).not.toBe(insecure.requestId)
		expect(result.current.data).toBeUndefined()
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "openAiModels",
						requestId: verified.requestId,
						openAiModels: ["verified-catalog"],
					},
				}),
			),
		)
		await waitFor(() => expect(Object.keys(result.current.data ?? {})).toEqual(["verified-catalog"]))
	})

	it("cancels an obsolete debounced settings request before posting it", async () => {
		const { rerender, unmount } = renderHook(
			({ baseUrl }: { baseUrl: string }) => useOpenAiModels({ baseUrl, apiKey: "test-key", debounceMs: 20 }),
			{ initialProps: { baseUrl: "https://old.example/v1" }, wrapper: createWrapper() },
		)
		expect(vscode.postMessage).not.toHaveBeenCalled()
		rerender({ baseUrl: "https://new.example/v1" })
		await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledTimes(1))
		expect((vi.mocked(vscode.postMessage).mock.calls[0][0] as WebviewMessage).values?.baseUrl).toBe(
			"https://new.example/v1",
		)
		unmount()
	})
})
