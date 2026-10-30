// kilocode_change - new file
import { DEFAULT_OPENAI_WEB_SEARCH_MODEL_ID, type ProviderSettings } from "@roo-code/types"

import { DEFAULT_HEADERS } from "../../../api/providers/constants"
import { createProviderFetch } from "../../../api/providers/utils/provider-tls"

/** Folder (relative to the workspace) where generated images are always saved. */
export const IMAGE_GENERATION_OUTPUT_DIR = "images_ivol"

const IMAGE_GENERATION_TIMEOUT_MS = 300_000
const MAX_ERROR_BODY_CHARS = 1_000

export interface OpenAiImageGenerationResult {
	/** Raw image bytes. */
	data: Buffer
	/** File extension derived from the image signature: png, jpg or webp. */
	extension: "png" | "jpg" | "webp"
}

type ImageSettings = Pick<
	ProviderSettings,
	| "apiProvider"
	| "openAiBaseUrl"
	| "openAiApiKey"
	| "openAiHeaders"
	| "allowInsecureTls"
	| "openAiImageGenerationEnabled"
	| "openAiImageGenerationModelId"
	| "openAiWebSearchModelId"
>

/** The model the user picked in settings, or undefined when generation is not usable. */
export function getOpenAiImageGenerationModel(settings: ImageSettings | undefined): string | undefined {
	if (!settings || settings.apiProvider !== "openai" || settings.openAiImageGenerationEnabled !== true) {
		return undefined
	}
	const model = settings.openAiImageGenerationModelId?.trim()
	return model ? model : undefined
}

function detectExtension(data: Buffer): OpenAiImageGenerationResult["extension"] {
	if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg"
	if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
		return "webp"
	}
	return "png"
}

function trimBaseUrl(baseUrl: string | undefined): string {
	return (baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "")
}

/**
 * Generates one image through the OpenAI Images API (`POST {baseUrl}/images/generations`)
 * using the current profile's URL, API key, custom headers and TLS setting.
 */
export interface OpenAiInputImage {
	data: Buffer
	/** MIME type, e.g. image/png. */
	mimeType: string
	fileName: string
}

export async function generateOpenAiImage(
	settings: ImageSettings,
	model: string,
	prompt: string,
	options: { size?: string; signal?: AbortSignal; inputImages?: OpenAiInputImage[] } = {},
): Promise<OpenAiImageGenerationResult> {
	const baseUrl = trimBaseUrl(settings.openAiBaseUrl)
	const isEdit = (options.inputImages?.length ?? 0) > 0
	const headers: Record<string, string> = {
		...DEFAULT_HEADERS,
		...(settings.openAiHeaders || {}),
	}
	// Multipart requests need the boundary that fetch adds automatically.
	if (!isEdit) headers["Content-Type"] = "application/json"
	if (settings.openAiApiKey) {
		headers["Authorization"] = `Bearer ${settings.openAiApiKey}`
	}

	const fetch = createProviderFetch({
		baseUrl,
		allowInsecureTls: settings.allowInsecureTls === true,
		timeoutMs: IMAGE_GENERATION_TIMEOUT_MS,
	})

	const timeoutSignal = AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS)
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal

	let response: Response
	if (isEdit) {
		// Image editing: POST {baseUrl}/images/edits as multipart/form-data.
		const form = new FormData()
		form.append("model", model)
		form.append("prompt", prompt)
		form.append("n", "1")
		if (options.size?.trim()) form.append("size", options.size.trim())
		const images = options.inputImages ?? []
		const fieldName = images.length > 1 ? "image[]" : "image"
		for (const image of images) {
			form.append(fieldName, new Blob([new Uint8Array(image.data)], { type: image.mimeType }), image.fileName)
		}
		response = await fetch(`${baseUrl}/images/edits`, { method: "POST", headers, body: form, signal })
		// Many OpenAI-compatible gateways (including Codex-backed ones) implement only
		// /images/generations. Fall back to the Responses API with the source image as
		// input_image and the hosted image_generation tool, which supports editing.
		if (!response.ok && !signal.aborted) {
			const editsError = await readErrorDetail(response)
			try {
				return await editViaResponses(fetch, baseUrl, settings, model, prompt, images, options.size, signal)
			} catch (fallbackError) {
				const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
				throw new Error(
					`Image editing failed. /images/edits (${response.status}): ${editsError}. Responses fallback: ${fallbackMessage}`,
				)
			}
		}
	} else {
		// `response_format` is intentionally omitted: gpt-image models reject it and
		// always return base64; DALL·E-style endpoints may return a URL instead.
		const body: Record<string, unknown> = { model, prompt, n: 1 }
		if (options.size?.trim()) body.size = options.size.trim()
		response = await fetch(`${baseUrl}/images/generations`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		})
	}

	const text = await response.text()
	if (!response.ok) {
		let detail = text
		try {
			const parsed = JSON.parse(text)
			detail = parsed?.error?.message || parsed?.message || text
		} catch {
			// Non-JSON error body: keep the raw text.
		}
		throw new Error(
			`Image ${isEdit ? "editing" : "generation"} failed (${response.status}): ${String(detail).slice(0, MAX_ERROR_BODY_CHARS)}`,
		)
	}

	let parsed: any
	try {
		parsed = JSON.parse(text)
	} catch {
		throw new Error(`Image generation returned a non-JSON response: ${text.slice(0, MAX_ERROR_BODY_CHARS)}`)
	}

	const item = Array.isArray(parsed?.data) ? parsed.data[0] : undefined
	let data: Buffer | undefined
	if (typeof item?.b64_json === "string" && item.b64_json.length > 0) {
		data = Buffer.from(item.b64_json.replace(/^data:image\/\w+;base64,/, ""), "base64")
	} else if (typeof item?.url === "string" && item.url.length > 0) {
		if (item.url.startsWith("data:")) {
			data = Buffer.from(item.url.replace(/^data:image\/\w+;base64,/, ""), "base64")
		} else {
			const imageResponse = await fetch(item.url, { signal })
			if (!imageResponse.ok) {
				throw new Error(`Failed to download the generated image (${imageResponse.status})`)
			}
			data = Buffer.from(await imageResponse.arrayBuffer())
		}
	}

	if (!data || data.length === 0) {
		throw new Error("Image generation response contained no image data.")
	}

	return { data, extension: detectExtension(data) }
}

/** Builds the workspace-relative output path inside images_ivol/. */
export function buildImageOutputPath(
	requestedPath: string | undefined,
	extension: OpenAiImageGenerationResult["extension"],
	now = new Date(),
): string {
	const rawName = (requestedPath ?? "").split(/[\\/]/).pop()?.trim() ?? ""
	const stem = rawName
		.replace(/\.(png|jpe?g|webp|gif)$/i, "")
		.replace(/[^\p{L}\p{N}._-]+/gu, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
	const fallback = `image-${now.toISOString().replace(/[:.]/g, "-")}`
	return `${IMAGE_GENERATION_OUTPUT_DIR}/${stem || fallback}.${extension}`
}

const INPUT_IMAGE_MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
}

/** MIME type for a supported input image file extension, or undefined. */
export function getInputImageMimeType(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
	return INPUT_IMAGE_MIME_BY_EXT[ext]
}

/**
 * Finds the most recent image in the conversation (user attachment, pasted
 * screenshot or an image returned inside a tool result), newest first.
 * Note: images the model has already seen may have been compacted to JPEG.
 */
export function findLatestConversationImage(
	messages: ReadonlyArray<{ role: string; content: unknown }>,
): OpenAiInputImage | undefined {
	const fromBlock = (block: any): OpenAiInputImage | undefined => {
		if (block?.type === "image" && block.source?.type === "base64" && typeof block.source.data === "string") {
			const mimeType = typeof block.source.media_type === "string" ? block.source.media_type : "image/png"
			const ext = mimeType.split("/")[1] === "jpeg" ? "jpg" : mimeType.split("/")[1] || "png"
			return { data: Buffer.from(block.source.data, "base64"), mimeType, fileName: `input.${ext}` }
		}
		return undefined
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const content = messages[i]?.content
		if (!Array.isArray(content)) continue
		for (let j = content.length - 1; j >= 0; j--) {
			const block: any = content[j]
			const direct = fromBlock(block)
			if (direct) return direct
			if (block?.type === "tool_result" && Array.isArray(block.content)) {
				for (let k = block.content.length - 1; k >= 0; k--) {
					const nested = fromBlock(block.content[k])
					if (nested) return nested
				}
			}
		}
	}
	return undefined
}

async function readErrorDetail(response: Response): Promise<string> {
	const text = await response.text().catch(() => "")
	try {
		const parsed = JSON.parse(text)
		return String(parsed?.error?.message || parsed?.message || text).slice(0, MAX_ERROR_BODY_CHARS)
	} catch {
		return text.slice(0, MAX_ERROR_BODY_CHARS)
	}
}

/** Extracts the first image_generation_call result from a Responses API body (JSON or SSE). */
export function extractResponsesImage(text: string): string | undefined {
	const fromOutput = (output: unknown): string | undefined => {
		if (!Array.isArray(output)) return undefined
		for (const item of output as any[]) {
			if (item?.type === "image_generation_call" && typeof item.result === "string" && item.result) {
				return item.result
			}
		}
		return undefined
	}
	try {
		const parsed = JSON.parse(text)
		return fromOutput(parsed?.output) ?? fromOutput(parsed?.response?.output)
	} catch {
		// Not a single JSON document: parse as server-sent events.
	}
	let partial: string | undefined
	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue
		let event: any
		try {
			event = JSON.parse(line.slice(5).trim())
		} catch {
			continue
		}
		if (event?.type === "response.output_item.done") {
			const found = fromOutput([event.item])
			if (found) return found
		} else if (event?.type === "response.completed") {
			const found = fromOutput(event.response?.output)
			if (found) return found
		} else if (event?.type === "response.image_generation_call.partial_image" && event.partial_image_b64) {
			partial = event.partial_image_b64
		}
	}
	return partial
}

async function editViaResponses(
	fetch: typeof globalThis.fetch,
	baseUrl: string,
	settings: ImageSettings,
	model: string,
	prompt: string,
	images: OpenAiInputImage[],
	size: string | undefined,
	signal: AbortSignal,
): Promise<OpenAiImageGenerationResult> {
	const headers: Record<string, string> = {
		...DEFAULT_HEADERS,
		...(settings.openAiHeaders || {}),
		"Content-Type": "application/json",
	}
	if (settings.openAiApiKey) headers["Authorization"] = `Bearer ${settings.openAiApiKey}`

	const tool: Record<string, unknown> = { type: "image_generation", model }
	if (size?.trim() && /^\d{3,5}x\d{3,5}$/.test(size.trim())) tool.size = size.trim()

	// The Responses request itself runs on a text model; the image model goes into the tool.
	const carrierModel = settings.openAiWebSearchModelId?.trim() || DEFAULT_OPENAI_WEB_SEARCH_MODEL_ID
	const body = {
		model: carrierModel,
		input: [
			{
				role: "user",
				content: [
					{ type: "input_text", text: `Edit the attached image: ${prompt}` },
					...images.map((image) => ({
						type: "input_image",
						image_url: `data:${image.mimeType};base64,${image.data.toString("base64")}`,
					})),
				],
			},
		],
		tools: [tool],
		tool_choice: { type: "image_generation" },
		store: false,
		stream: false,
	}

	const response = await fetch(`${baseUrl}/responses`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	})
	if (!response.ok) {
		throw new Error(`(${response.status}) ${await readErrorDetail(response)}`)
	}
	const b64 = extractResponsesImage(await response.text())
	if (!b64) {
		throw new Error("the Responses API returned no image_generation_call result")
	}
	const data = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ""), "base64")
	if (data.length === 0) throw new Error("the Responses API returned an empty image")
	return { data, extension: detectExtension(data) }
}
