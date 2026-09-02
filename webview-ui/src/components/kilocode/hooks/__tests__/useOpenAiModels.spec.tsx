import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"

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
})
