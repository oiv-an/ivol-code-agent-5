import { useQuery, useQueryClient } from "@tanstack/react-query"

import { type ExtensionMessage, type ModelRecord, openAiModelInfoSaneDefaults } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

type OpenAiModelsRequest = {
	profileId?: string
	baseUrl?: string
	apiKey?: string
	openAiHeaders?: Record<string, string>
}

let requestCounter = 0
const OPEN_AI_MODELS_RESPONSE_TIMEOUT_MS = 20_000 // kilocode_change: allow authenticated plus public catalog attempts

const createRequestId = () => `openai-models-${Date.now()}-${++requestCounter}`

const toModelRecord = (models: string[]): ModelRecord =>
	Object.fromEntries(models.map((modelId) => [modelId, openAiModelInfoSaneDefaults]))

const getOpenAiModels = (
	{ profileId, baseUrl, apiKey, openAiHeaders }: OpenAiModelsRequest,
	onBackgroundModels: (models: ModelRecord) => void,
) =>
	new Promise<ModelRecord>((resolve, reject) => {
		const requestId = createRequestId()
		let initialResponseReceived = false

		const cleanup = () => {
			window.removeEventListener("message", handler)
		}

		const timeout = setTimeout(() => {
			cleanup()
			if (!initialResponseReceived) {
				reject(new Error("OpenAI-compatible models request timed out"))
			}
		}, OPEN_AI_MODELS_RESPONSE_TIMEOUT_MS)

		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type !== "openAiModels" || message.requestId !== requestId) {
				return
			}

			const models = message.openAiModels ?? []
			const modelRecord = toModelRecord(models)

			if (message.values?.backgroundRefresh) {
				clearTimeout(timeout)
				cleanup()
				onBackgroundModels(modelRecord)
				return
			}

			initialResponseReceived = true
			resolve(modelRecord)

			if (!message.values?.backgroundRefreshPending) {
				clearTimeout(timeout)
				cleanup()
			}
		}

		window.addEventListener("message", handler)
		vscode.postMessage({
			type: "requestOpenAiModels",
			requestId,
			values: {
				profileId,
				baseUrl,
				apiKey,
				openAiHeaders: openAiHeaders ?? {},
			},
		})
	})

export const useOpenAiModels = ({
	profileId,
	baseUrl,
	apiKey,
	openAiHeaders,
	enabled = true,
}: OpenAiModelsRequest & { enabled?: boolean }) => {
	const queryClient = useQueryClient()
	const queryKey = ["openAiModels", profileId, baseUrl, apiKey, openAiHeaders] as const

	return useQuery({
		queryKey,
		queryFn: () =>
			getOpenAiModels({ profileId, baseUrl, apiKey, openAiHeaders }, (models) => {
				queryClient.setQueryData(queryKey, models)
			}),
		enabled: enabled && Boolean(baseUrl && apiKey),
	})
}
