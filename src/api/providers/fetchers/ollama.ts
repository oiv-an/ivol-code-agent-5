import axios from "axios"
import { ModelInfo, ollamaDefaultModelInfo } from "@roo-code/types"
import { z } from "zod"
import { createProviderFetch } from "../utils/provider-tls" // kilocode_change

const OllamaModelDetailsSchema = z.object({
	family: z.string(),
	families: z.array(z.string()).nullable().optional(),
	format: z.string().optional(),
	parameter_size: z.string(),
	parent_model: z.string().optional(),
	quantization_level: z.string().optional(),
})

const OllamaModelSchema = z.object({
	details: OllamaModelDetailsSchema,
	digest: z.string().optional(),
	model: z.string(),
	modified_at: z.string().optional(),
	name: z.string(),
	size: z.number().optional(),
})

const OllamaModelInfoResponseSchema = z.object({
	modelfile: z.string().optional(),
	parameters: z.string().optional(),
	template: z.string().optional(),
	details: OllamaModelDetailsSchema,
	model_info: z.record(z.string(), z.any()),
	capabilities: z.array(z.string()).optional(),
})

const OllamaModelsResponseSchema = z.object({
	models: z.array(OllamaModelSchema),
})

type OllamaModelsResponse = z.infer<typeof OllamaModelsResponseSchema>

type OllamaModelInfoResponse = z.infer<typeof OllamaModelInfoResponseSchema>

export const parseOllamaModel = (
	rawModel: OllamaModelInfoResponse,
	// kilocode_change start
	baseUrl?: string,
	numCtx?: number,
	// kilocode_change end
): ModelInfo | null => {
	// kilocode_change start
	const contextKey = rawModel.model_info && Object.keys(rawModel.model_info).find((k) => k.includes("context_length"))
	const contextLengthFromModelInfo =
		contextKey && typeof rawModel.model_info[contextKey] === "number" ? rawModel.model_info[contextKey] : undefined

	const contextLengthFromModelParameters =
		typeof rawModel.parameters === "string"
			? parseInt(rawModel.parameters.match(/^num_ctx\s+(\d+)/m)?.[1] ?? "", 10) || undefined
			: undefined

	const contextLengthFromEnvironment = parseInt(process.env.OLLAMA_CONTEXT_LENGTH ?? "", 10) || undefined

	const contextWindow =
		numCtx ??
		(baseUrl?.toLowerCase().startsWith("https://ollama.com") ? contextLengthFromModelInfo : undefined) ??
		contextLengthFromEnvironment ??
		(contextLengthFromModelParameters !== 40960 ? contextLengthFromModelParameters : undefined) ?? // Alledgedly Ollama sometimes returns an undefind context as 40960
		4096 // This is usually the default: https://github.com/ollama/ollama/blob/4383a3ab7a075eff78b31f7dc84c747e2fcd22b8/docs/faq.md#how-can-i-specify-the-context-window-size
	// kilocode_change end
	// Determine native tool support from capabilities array
	// The capabilities array is populated by Ollama based on model metadata
	const supportsNativeTools = rawModel.capabilities?.includes("tools") ?? false

	const modelInfo: ModelInfo = Object.assign({}, ollamaDefaultModelInfo, {
		description: `Family: ${rawModel.details.family}, Context: ${contextWindow}, Size: ${rawModel.details.parameter_size}`,
		contextWindow: contextWindow || ollamaDefaultModelInfo.contextWindow,
		supportsPromptCache: true,
		supportsImages: rawModel.capabilities?.includes("vision"),
		maxTokens: contextWindow || ollamaDefaultModelInfo.contextWindow,
		supportsNativeTools, // kilocode_change: Set based on actual capability (allows non-tool models for autocomplete)
	})

	return modelInfo
}

export async function getOllamaModels(
	baseUrl = "http://localhost:11434",
	apiKey?: string,
	numCtx?: number, // kilocode_change
	allowInsecureTls = false, // kilocode_change: profile-local HTTPS exception
): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}

	// clearing the input can leave an empty string; use the default in that case
	baseUrl = baseUrl === "" ? "http://localhost:11434" : baseUrl

	try {
		if (!URL.canParse(baseUrl)) {
			return models
		}

		// Prepare headers with optional API key
		const headers: Record<string, string> = {}
		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`
		}

		// kilocode_change start: keep the normal transport unchanged unless explicitly opted in
		const catalogFetch = allowInsecureTls
			? createProviderFetch({ baseUrl, allowInsecureTls, timeoutMs: 30_000 })
			: undefined
		const fetchJson = async (url: string, body?: unknown) => {
			const response = await catalogFetch!(url, {
				method: body === undefined ? "GET" : "POST",
				headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(30_000),
			})
			if (!response.ok) {
				await response.body?.cancel()
				throw new Error(`Ollama model catalog request failed (${response.status})`)
			}
			return { data: await response.json() }
		}
		const response = catalogFetch
			? await fetchJson(`${baseUrl}/api/tags`)
			: await axios.get<OllamaModelsResponse>(`${baseUrl}/api/tags`, { headers })
		// kilocode_change end
		const parsedResponse = OllamaModelsResponseSchema.safeParse(response.data)
		let modelInfoPromises = []

		if (parsedResponse.success) {
			for (const ollamaModel of parsedResponse.data.models) {
				modelInfoPromises.push(
					(catalogFetch
						? fetchJson(`${baseUrl}/api/show`, { model: ollamaModel.model })
						: axios.post<OllamaModelInfoResponse>(
								`${baseUrl}/api/show`,
								{
									model: ollamaModel.model,
								},
								{ headers },
							)
					).then((ollamaModelInfo) => {
						const modelInfo = parseOllamaModel(
							ollamaModelInfo.data,
							// kilocode_change start
							baseUrl,
							numCtx,
							// kilocode_change end
						)
						// Only include models that support native tools
						if (modelInfo) {
							models[ollamaModel.name] = modelInfo
						}
					}),
				)
			}

			await Promise.all(modelInfoPromises)
		} else {
			console.error(`Error parsing Ollama models response: ${JSON.stringify(parsedResponse.error, null, 2)}`)
		}
	} catch (error: any) {
		if (error.code === "ECONNREFUSED") {
			console.warn(`Failed connecting to Ollama at ${baseUrl}`)
		} else {
			console.error(
				`Error fetching Ollama models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)
		}
	}

	return models
}
