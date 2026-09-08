import axios from "axios"
import { LLM, LLMInfo, LLMInstanceInfo, LMStudioClient } from "@lmstudio/sdk"

import { type ModelInfo, lMStudioDefaultModelInfo } from "@roo-code/types"

import { flushModels, getModels } from "./modelCache"
import { createProviderFetch } from "../utils/provider-tls" // kilocode_change

const modelsWithLoadedDetails = new Set<string>()

export const hasLoadedFullDetails = (modelId: string): boolean => modelsWithLoadedDetails.has(modelId)

export const forceFullModelDetailsLoad = async (
	baseUrl: string,
	modelId: string,
	allowInsecureTls = false,
): Promise<void> => {
	try {
		// kilocode_change start: SDK WebSocket transport cannot scope a TLS exception.
		// REST model discovery still works; model loading remains owned by chat requests.
		if (allowInsecureTls && URL.canParse(baseUrl) && new URL(baseUrl).protocol === "https:") {
			await flushModels({ provider: "lmstudio", baseUrl, allowInsecureTls }, true)
			return
		}
		// kilocode_change end
		// Test the connection to LM Studio first
		// Crrors will be caught further down.
		await axios.get(`${baseUrl}/v1/models`)
		const lmsUrl = baseUrl.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://")

		const client = new LMStudioClient({ baseUrl: lmsUrl })
		await client.llm.model(modelId)
		// Flush and refresh cache to get updated model details
		await flushModels({ provider: "lmstudio", baseUrl }, true)

		// Mark this model as having full details loaded.
		modelsWithLoadedDetails.add(modelId)
	} catch (error) {
		if (error.code === "ECONNREFUSED") {
			console.warn(`Error connecting to LMStudio at ${baseUrl}`)
		} else {
			console.error(
				`Error refreshing LMStudio model details: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)
		}
	}
}

export const parseLMStudioModel = (rawModel: LLMInstanceInfo | LLMInfo): ModelInfo => {
	// Handle both LLMInstanceInfo (from loaded models) and LLMInfo (from downloaded models)
	const contextLength = "contextLength" in rawModel ? rawModel.contextLength : rawModel.maxContextLength

	const modelInfo: ModelInfo = Object.assign({}, lMStudioDefaultModelInfo, {
		description: `${rawModel.displayName} - ${rawModel.path}`,
		contextWindow: contextLength,
		supportsPromptCache: true,
		supportsImages: rawModel.vision,
		maxTokens: contextLength,
	})

	return modelInfo
}

export async function getLMStudioModels(
	baseUrl = "http://localhost:1234",
	allowInsecureTls = false,
): Promise<Record<string, ModelInfo>> {
	// clear the set of models that have full details loaded
	modelsWithLoadedDetails.clear()
	// clearing the input can leave an empty string; use the default in that case
	baseUrl = baseUrl.trim() || "http://localhost:1234"

	const models: Record<string, ModelInfo> = {}
	// ws is required to connect using the LMStudio library
	const lmsUrl = baseUrl.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://")

	try {
		if (!URL.canParse(lmsUrl)) {
			return models
		}
		// kilocode_change start: never disable global TLS for the SDK's WebSocket connection.
		if (allowInsecureTls && new URL(baseUrl).protocol === "https:") {
			return await getLMStudioModelsOverRest(baseUrl)
		}
		// kilocode_change end

		// test the connection to LM Studio first
		// errors will be caught further down
		await axios.get(`${baseUrl}/v1/models`)

		const client = new LMStudioClient({ baseUrl: lmsUrl })

		// First, try to get all downloaded models
		try {
			const downloadedModels = await client.system.listDownloadedModels("llm")
			for (const model of downloadedModels) {
				// Use the model path as the key since that's what users select
				models[model.path] = parseLMStudioModel(model)
			}
		} catch (error) {
			console.warn("Failed to list downloaded models, falling back to loaded models only")
		}

		// Get loaded models for their runtime info (context size)
		const loadedModels = (await client.llm.listLoaded().then((models: LLM[]) => {
			return Promise.all(models.map((m) => m.getModelInfo()))
		})) as Array<LLMInstanceInfo>

		// Deduplicate: For each loaded model, check if any downloaded model path contains the loaded model's key
		// This handles cases like loaded "llama-3.1" matching downloaded "Meta/Llama-3.1/Something"
		// If found, remove the downloaded version and add the loaded model (prefer loaded over downloaded for accurate runtime info)
		for (const lmstudioModel of loadedModels) {
			const loadedModelId = lmstudioModel.modelKey.toLowerCase()

			// Find if any downloaded model path contains the loaded model's key as a path segment
			// Use word boundaries or path separators to avoid false matches like "llama" matching "codellama"
			const existingKey = Object.keys(models).find((key) => {
				const keyLower = key.toLowerCase()
				// Check if the loaded model ID appears as a distinct segment in the path
				// This matches "llama-3.1" in "Meta/Llama-3.1/Something" but not "llama" in "codellama"
				return (
					keyLower.includes(`/${loadedModelId}/`) ||
					keyLower.includes(`/${loadedModelId}`) ||
					keyLower.startsWith(`${loadedModelId}/`) ||
					keyLower === loadedModelId
				)
			})

			if (existingKey) {
				// Remove the downloaded version
				delete models[existingKey]
			}

			// Add the loaded model (either as replacement or new entry)
			models[lmstudioModel.modelKey] = parseLMStudioModel(lmstudioModel)
			modelsWithLoadedDetails.add(lmstudioModel.modelKey)
		}
	} catch (error) {
		if (error.code === "ECONNREFUSED") {
			console.warn(`Error connecting to LMStudio at ${baseUrl}`)
		} else {
			console.error(
				`Error fetching LMStudio models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)
		}
	}

	return models
}

// kilocode_change start
async function getLMStudioModelsOverRest(baseUrl: string): Promise<Record<string, ModelInfo>> {
	const catalogFetch = createProviderFetch({ baseUrl, allowInsecureTls: true, timeoutMs: 30_000 })
	let response = await catalogFetch(`${baseUrl.replace(/\/+$/, "")}/api/v0/models`, {
		signal: AbortSignal.timeout(30_000),
	})
	if (response.status === 404 || response.status === 405) {
		await response.body?.cancel()
		response = await catalogFetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`, {
			signal: AbortSignal.timeout(30_000),
		})
	}
	if (!response.ok) {
		await response.body?.cancel()
		throw new Error(`LM Studio model catalog request failed (${response.status})`)
	}
	const payload = (await response.json()) as { data?: unknown }
	if (!Array.isArray(payload.data)) return {}
	const models: Record<string, ModelInfo> = {}
	for (const value of payload.data) {
		if (!value || typeof value !== "object") continue
		const model = value as Record<string, unknown>
		if (typeof model.id !== "string" || !model.id.trim() || model.type === "embeddings") continue
		const loadedContext = model.loaded_context_length ?? model.context_length
		// max_context_length describes training capability, not the loaded runtime limit.
		// Use a conservative fallback when REST omits the loaded limit (the generic
		// LM Studio fallback is 200k and must not masquerade as measured runtime data).
		const trainedContext = model.max_context_length
		const fallbackContext =
			typeof trainedContext === "number" && Number.isFinite(trainedContext) && trainedContext > 0
				? Math.min(4096, trainedContext)
				: 4096
		const contextWindow =
			typeof loadedContext === "number" && Number.isFinite(loadedContext) && loadedContext > 0
				? loadedContext
				: fallbackContext
		models[model.id] = {
			...lMStudioDefaultModelInfo,
			description: typeof model.arch === "string" ? `${model.id} (${model.arch})` : model.id,
			contextWindow,
			maxTokens: Math.min(lMStudioDefaultModelInfo.maxTokens ?? 8192, contextWindow),
			...(model.type === "vlm" ? { supportsImages: true } : {}),
		}
	}
	return models
}
// kilocode_change end
