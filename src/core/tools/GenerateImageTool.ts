import path from "path"
import fs from "fs/promises"
import * as vscode from "vscode"
import {
	GenerateImageParams,
	IMAGE_GENERATION_MODEL_IDS,
	IMAGE_GENERATION_MODELS,
	type ProviderSettings,
} from "@roo-code/types"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { fileExistsAtPath } from "../../utils/fs"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { OpenRouterHandler } from "../../api/providers/openrouter"
import { BaseTool, ToolCallbacks } from "./BaseTool"
// kilocode_change start
import {
	buildImageOutputPath,
	findLatestConversationImage,
	generateOpenAiImage,
	getInputImageMimeType,
	getOpenAiImageGenerationModel,
	type OpenAiInputImage,
} from "../kilocode/image-generation/openAiImageGeneration"
import { resolveToolSettings } from "../kilocode/pinned-tools/resolvePinnedTools"
// kilocode_change end
import type { ToolUse } from "../../shared/tools"

import { t } from "../../i18n"

export class GenerateImageTool extends BaseTool<"generate_image"> {
	readonly name = "generate_image" as const

	parseLegacy(params: Partial<Record<string, string>>): GenerateImageParams {
		return {
			prompt: params.prompt || "",
			path: params.path || "",
			image: params.image,
		}
	}

	async execute(params: GenerateImageParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { prompt, path: relPath, image: inputImagePath } = params
		const { handleError, pushToolResult, askApproval, removeClosingTag, toolProtocol } = callbacks

		const provider = task.providerRef.deref()

		// kilocode_change start: OpenAI-compatible Images API through the current profile
		// Pinned image profile (IVOL settings) or the active profile's own settings.
		const resolvedImage = await resolveToolSettings("imageGeneration", task.apiConfiguration, provider)
		const openAiImageModel = getOpenAiImageGenerationModel(resolvedImage?.settings)
		if (resolvedImage && openAiImageModel) {
			await this.executeOpenAi(params, task, callbacks, openAiImageModel, resolvedImage.settings)
			return
		}
		// kilocode_change end

		const state = await provider?.getState()
		const isImageGenerationEnabled = experiments.isEnabled(
			state?.experiments ?? {},
			EXPERIMENT_IDS.IMAGE_GENERATION,
		)

		if (!isImageGenerationEnabled) {
			pushToolResult(
				formatResponse.toolError(
					"Image generation is an experimental feature that must be enabled in settings. Please enable 'Image Generation' in the Experimental Settings section.",
				),
			)
			return
		}

		if (!prompt) {
			task.consecutiveMistakeCount++
			task.recordToolError("generate_image")
			pushToolResult(await task.sayAndCreateMissingParamError("generate_image", "prompt"))
			return
		}

		if (!relPath) {
			task.consecutiveMistakeCount++
			task.recordToolError("generate_image")
			pushToolResult(await task.sayAndCreateMissingParamError("generate_image", "path"))
			return
		}

		const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)
		if (!accessAllowed) {
			await task.say("rooignore_error", relPath)
			pushToolResult(formatResponse.rooIgnoreError(relPath, toolProtocol))
			return
		}

		let inputImageData: string | undefined
		if (inputImagePath) {
			const inputImageFullPath = path.resolve(task.cwd, inputImagePath)

			const inputImageExists = await fileExistsAtPath(inputImageFullPath)
			if (!inputImageExists) {
				await task.say("error", `Input image not found: ${getReadablePath(task.cwd, inputImagePath)}`)
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(`Input image not found: ${getReadablePath(task.cwd, inputImagePath)}`),
				)
				return
			}

			const inputImageAccessAllowed = task.rooIgnoreController?.validateAccess(inputImagePath)
			if (!inputImageAccessAllowed) {
				await task.say("rooignore_error", inputImagePath)
				pushToolResult(formatResponse.rooIgnoreError(inputImagePath, toolProtocol))
				return
			}

			try {
				const imageBuffer = await fs.readFile(inputImageFullPath)
				const imageExtension = path.extname(inputImageFullPath).toLowerCase().replace(".", "")

				const supportedFormats = ["png", "jpg", "jpeg", "gif", "webp"]
				if (!supportedFormats.includes(imageExtension)) {
					await task.say(
						"error",
						`Unsupported image format: ${imageExtension}. Supported formats: ${supportedFormats.join(", ")}`,
					)
					task.didToolFailInCurrentTurn = true
					pushToolResult(
						formatResponse.toolError(
							`Unsupported image format: ${imageExtension}. Supported formats: ${supportedFormats.join(", ")}`,
						),
					)
					return
				}

				const mimeType = imageExtension === "jpg" ? "jpeg" : imageExtension
				inputImageData = `data:image/${mimeType};base64,${imageBuffer.toString("base64")}`
			} catch (error) {
				await task.say(
					"error",
					`Failed to read input image: ${error instanceof Error ? error.message : "Unknown error"}`,
				)
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(
						`Failed to read input image: ${error instanceof Error ? error.message : "Unknown error"}`,
					),
				)
				return
			}
		}

		const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false

		// Image generation in the personal build is always direct through the
		// user's OpenRouter account. Ignore a persisted legacy `kilocode` value so
		// restoring old settings cannot contact the retired gateway.
		const imageProvider = "openrouter" as const

		// Get the selected model
		let selectedModel = state?.openRouterImageGenerationSelectedModel
		let modelInfo = undefined

		// Find the model info matching both value AND provider
		// (since the same model value can exist for multiple providers)
		if (selectedModel) {
			modelInfo = IMAGE_GENERATION_MODELS.find((m) => m.value === selectedModel && m.provider === imageProvider)
			if (!modelInfo) {
				// Model doesn't exist for this provider, use first model for selected provider
				const providerModels = IMAGE_GENERATION_MODELS.filter((m) => m.provider === imageProvider)
				modelInfo = providerModels[0]
				selectedModel = modelInfo?.value || IMAGE_GENERATION_MODEL_IDS[0]
			}
		} else {
			// No model selected, use first model for selected provider
			const providerModels = IMAGE_GENERATION_MODELS.filter((m) => m.provider === imageProvider)
			modelInfo = providerModels[0]
			selectedModel = modelInfo?.value || IMAGE_GENERATION_MODEL_IDS[0]
		}

		// Validate API key for OpenRouter
		const openRouterApiKey = state?.openRouterImageApiKey
		if (!openRouterApiKey) {
			const errorMessage = t("tools:generateImage.openRouterApiKeyRequired")
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return
		}

		const fullPath = path.resolve(task.cwd, removeClosingTag("path", relPath))
		const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)

		const sharedMessageProps = {
			tool: "generateImage" as const,
			path: getReadablePath(task.cwd, removeClosingTag("path", relPath)),
			content: prompt,
			isOutsideWorkspace,
			isProtected: isWriteProtected,
		}

		try {
			task.consecutiveMistakeCount = 0

			const approvalMessage = JSON.stringify({
				...sharedMessageProps,
				content: prompt,
				...(inputImagePath && { inputImage: getReadablePath(task.cwd, inputImagePath) }),
			})

			const didApprove = await askApproval("tool", approvalMessage, undefined, isWriteProtected)

			if (!didApprove) {
				return
			}

			const handler = new OpenRouterHandler({})
			const result = await handler.generateImage(
				prompt,
				selectedModel,
				openRouterApiKey,
				inputImageData,
				task.taskId,
			)

			if (!result.success) {
				await task.say("error", result.error || "Failed to generate image")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(result.error || "Failed to generate image"))
				return
			}

			if (!result.imageData) {
				const errorMessage = "No image data received"
				await task.say("error", errorMessage)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(errorMessage))
				return
			}

			const base64Match = result.imageData.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/)
			if (!base64Match) {
				const errorMessage = "Invalid image format received"
				await task.say("error", errorMessage)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(errorMessage))
				return
			}

			const imageFormat = base64Match[1]
			const base64Data = base64Match[2]

			let finalPath = relPath
			if (!finalPath.match(/\.(png|jpg|jpeg)$/i)) {
				finalPath = `${finalPath}.${imageFormat === "jpeg" ? "jpg" : imageFormat}`
			}

			const imageBuffer = Buffer.from(base64Data, "base64")

			const absolutePath = path.resolve(task.cwd, finalPath)
			const directory = path.dirname(absolutePath)
			await fs.mkdir(directory, { recursive: true })

			await fs.writeFile(absolutePath, imageBuffer)

			if (finalPath) {
				await task.fileContextTracker.trackFileContext(finalPath, "roo_edited")
			}

			task.didEditFile = true

			task.recordToolUsage("generate_image")

			const fullImagePath = path.join(task.cwd, finalPath)

			let imageUri = provider?.convertToWebviewUri?.(fullImagePath) ?? vscode.Uri.file(fullImagePath).toString()

			const cacheBuster = Date.now()
			imageUri = imageUri.includes("?") ? `${imageUri}&t=${cacheBuster}` : `${imageUri}?t=${cacheBuster}`

			await task.say("image", JSON.stringify({ imageUri, imagePath: fullImagePath }))
			pushToolResult(formatResponse.toolResult(getReadablePath(task.cwd, finalPath)))
		} catch (error) {
			await handleError("generating image", error as Error)
		}
	}

	// kilocode_change start: OpenAI-compatible Images API branch. The image is saved
	// under images_ivol/ and only its path is returned to the model; the model
	// decides whether to read the file.
	private async executeOpenAi(
		params: GenerateImageParams,
		task: Task,
		callbacks: ToolCallbacks,
		model: string,
		imageSettings: ProviderSettings,
	): Promise<void> {
		const { handleError, pushToolResult, askApproval } = callbacks
		const prompt = typeof params.prompt === "string" ? params.prompt.trim() : ""

		if (!prompt) {
			task.consecutiveMistakeCount++
			task.recordToolError("generate_image")
			pushToolResult(await task.sayAndCreateMissingParamError("generate_image", "prompt"))
			return
		}

		// Optional source image for editing: a file path or "attached" (latest chat image).
		const imageRef = typeof params.image === "string" ? params.image.trim() : ""
		let inputImage: OpenAiInputImage | undefined
		let inputLabel: string | undefined
		if (imageRef && imageRef.toLowerCase() !== "null") {
			const fail = async (message: string) => {
				task.recordToolError("generate_image", message)
				task.didToolFailInCurrentTurn = true
				await task.say("error", message)
				pushToolResult(formatResponse.toolError(message))
			}
			if (imageRef.toLowerCase() === "attached") {
				inputImage = findLatestConversationImage(task.apiConversationHistory as any)
				if (!inputImage) {
					await fail("No image attached in this chat. Ask the user to attach the image or pass a file path.")
					return
				}
				inputLabel = "attached image"
			} else {
				const inputPath = path.resolve(task.cwd, imageRef)
				const mimeType = getInputImageMimeType(inputPath)
				if (!mimeType) {
					await fail(`Unsupported input image format: ${imageRef}. Supported: PNG, JPG, JPEG, WEBP.`)
					return
				}
				if (!(task.rooIgnoreController?.validateAccess(imageRef) ?? true)) {
					await task.say("rooignore_error", imageRef)
					pushToolResult(formatResponse.rooIgnoreError(imageRef, callbacks.toolProtocol))
					return
				}
				if (!(await fileExistsAtPath(inputPath))) {
					await fail(`Input image not found: ${getReadablePath(task.cwd, imageRef)}`)
					return
				}
				inputImage = { data: await fs.readFile(inputPath), mimeType, fileName: path.basename(inputPath) }
				inputLabel = getReadablePath(task.cwd, imageRef)
			}
		}

		const plannedPath = buildImageOutputPath(params.path, "png")
		const isWriteProtected = task.rooProtectedController?.isWriteProtected(plannedPath) || false

		try {
			task.consecutiveMistakeCount = 0
			const didApprove = await askApproval(
				"tool",
				JSON.stringify({
					tool: "generateImage" as const,
					path: plannedPath,
					content: prompt,
					...(inputLabel && { inputImage: inputLabel }),
					isOutsideWorkspace: false,
					isProtected: isWriteProtected,
				}),
				undefined,
				isWriteProtected,
			)
			if (!didApprove) {
				return
			}

			const result = await generateOpenAiImage(imageSettings, model, prompt, {
				signal: task.currentRequestAbortController?.signal,
				...(inputImage && { inputImages: [inputImage] }),
			})
			const relPath = buildImageOutputPath(params.path, result.extension)
			const absolutePath = path.resolve(task.cwd, relPath)
			await fs.mkdir(path.dirname(absolutePath), { recursive: true })
			await fs.writeFile(absolutePath, result.data)

			await task.fileContextTracker.trackFileContext(relPath, "roo_edited")
			task.didEditFile = true
			task.recordToolUsage("generate_image")

			const provider = task.providerRef.deref()
			let imageUri = provider?.convertToWebviewUri?.(absolutePath) ?? vscode.Uri.file(absolutePath).toString()
			imageUri = imageUri.includes("?") ? `${imageUri}&t=${Date.now()}` : `${imageUri}?t=${Date.now()}`
			await task.say("image", JSON.stringify({ imageUri, imagePath: absolutePath }))

			pushToolResult(
				formatResponse.toolResult(
					`Image ${inputImage ? `edited (source: ${inputLabel})` : "generated"} with model ${model} and saved to ${relPath} (${result.data.length} bytes). The image itself is not attached; read the file only if you need to inspect it. To edit this image later, call generate_image with image set to "${relPath}" (the original full-quality file).`,
				),
			)
		} catch (error) {
			if (task.abort || task.currentRequestAbortController?.signal.aborted) {
				return
			}
			task.recordToolError("generate_image", error instanceof Error ? error.message : String(error))
			task.didToolFailInCurrentTurn = true
			await handleError("generating image", error instanceof Error ? error : new Error(String(error)))
		}
	}
	// kilocode_change end

	override async handlePartial(task: Task, block: ToolUse<"generate_image">): Promise<void> {
		return
	}
}

export const generateImageTool = new GenerateImageTool()
