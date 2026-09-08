import { useQuery } from "@tanstack/react-query"

import { type RouterModels, type ExtensionMessage, isPersonalRouterModelProvider } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

type UseRouterModelsOptions = {
	provider?: string // single provider filter (e.g. "roo")
	enabled?: boolean // gate fetching entirely
	debounceMs?: number // kilocode_change: defer requests while editing a settings draft
}

// kilocode_change start: correlate catalogs with the exact profile transport request.
let requestCounter = 0
const getRouterModels = async (
	queryKey: RouterModelsQueryKey,
	provider?: string,
	signal?: AbortSignal,
	debounceMs = 0,
) =>
	new Promise<RouterModels>((resolve, reject) => {
		const requestId = `router-models-${Date.now()}-${++requestCounter}`
		let sendTimeout: ReturnType<typeof setTimeout> | undefined
		const cleanup = () => {
			window.removeEventListener("message", handler)
			signal?.removeEventListener("abort", onAbort)
			clearTimeout(sendTimeout)
		}
		const onAbort = () => {
			clearTimeout(timeout)
			cleanup()
			reject(new Error("Router models request cancelled"))
		}

		const timeout = setTimeout(() => {
			cleanup()
			reject(new Error("Router models request timed out"))
		}, 10000)

		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === "routerModels" && message.requestId === requestId) {
				const msgProvider = message?.values?.provider as string | undefined

				// Verify response matches request
				if (provider !== msgProvider) {
					// Not our response; ignore and wait for the matching one
					return
				}

				clearTimeout(timeout)
				cleanup()

				if (message.routerModels) {
					resolve(message.routerModels)
				} else {
					reject(new Error("No router models in response"))
				}
			}
		}

		window.addEventListener("message", handler)
		// Never issue an unfiltered provider catalog request.
		if (!provider) {
			clearTimeout(timeout)
			cleanup()
			reject(new Error("A provider filter is required for model catalog requests"))
			return
		}
		if (signal?.aborted) {
			onAbort()
			return
		}
		signal?.addEventListener("abort", onAbort, { once: true })
		const send = () =>
			vscode.postMessage({
				type: "requestRouterModels",
				requestId,
				values: {
					provider,
					profileId: queryKey.profileId,
					baseUrl:
						provider === "ollama"
							? (queryKey.ollamaBaseUrl ?? "")
							: provider === "lmstudio"
								? (queryKey.lmStudioBaseUrl ?? "")
								: undefined,
					apiKey: provider === "ollama" ? (queryKey.ollamaApiKey ?? "") : undefined,
					numCtx: provider === "ollama" ? queryKey.ollamaNumCtx : undefined,
					allowInsecureTls: queryKey.allowInsecureTls === true,
				},
			})
		if (debounceMs > 0) sendTimeout = setTimeout(send, debounceMs)
		else send()
	})

type RouterModelsQueryKey = {
	profileId?: string
	allowInsecureTls?: boolean
	ollamaApiKey?: string
	ollamaNumCtx?: number
	openRouterBaseUrl?: string
	openRouterApiKey?: string
	lmStudioBaseUrl?: string
	ollamaBaseUrl?: string
	kilocodeOrganizationId?: string
	deepInfraApiKey?: string
	geminiApiKey?: string
	googleGeminiBaseUrl?: string
	chutesApiKey?: string
	nanoGptApiKey?: string
	nanoGptModelList?: "all" | "personalized" | "subscription"
	syntheticApiKey?: string
	zenmuxBaseUrl?: string
	zenmuxApiKey?: string
	// Requesty, Unbound, etc should perhaps also be here, but they already have their own hacks for reloading
}

export const useRouterModels = (queryKey: RouterModelsQueryKey, opts: UseRouterModelsOptions = {}) => {
	const provider = opts.provider || undefined
	// Share identical settings requests even when callers carry unrelated provider fields.
	const scopedKey = isPersonalRouterModelProvider(provider)
		? {
				profileId: queryKey.profileId,
				allowInsecureTls: queryKey.allowInsecureTls === true,
				baseUrl:
					provider === "ollama"
						? (queryKey.ollamaBaseUrl ?? "")
						: provider === "lmstudio"
							? (queryKey.lmStudioBaseUrl ?? "")
							: undefined,
				apiKey: provider === "ollama" ? (queryKey.ollamaApiKey ?? "") : undefined,
				numCtx: provider === "ollama" ? queryKey.ollamaNumCtx : undefined,
			}
		: queryKey
	return useQuery({
		queryKey: ["routerModels", provider || "all", scopedKey],
		queryFn: ({ signal }) => getRouterModels(queryKey, provider, signal, opts.debounceMs),
		enabled: opts.enabled !== false,
	})
}
// kilocode_change end
