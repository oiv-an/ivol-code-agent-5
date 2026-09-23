import path from "path"
import * as fs from "fs/promises"
import { isBinaryFile } from "isbinaryfile"

import type { FileEntry, LineRange } from "@roo-code/types"
import { type ClineSayTool, isNativeProtocol, ANTHROPIC_DEFAULT_MAX_TOKENS } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { getModelMaxOutputTokens } from "../../shared/api"
import { t } from "../../i18n"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { getReadablePath } from "../../utils/path"
import { countFileLines } from "../../integrations/misc/line-counter"
import { extractTextFromFile, addLineNumbers, getSupportedBinaryFormats } from "../../integrations/misc/extract-text"
import { parseSourceCodeDefinitionsForFile } from "../../services/tree-sitter"
import { parseXml } from "../../utils/xml"
import { resolveToolProtocol } from "../../utils/resolveToolProtocol"
import type { ToolUse } from "../../shared/tools"

import {
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	isSupportedImageFormat,
	validateImageForProcessing,
	processImageFile,
	ImageMemoryTracker,
} from "./helpers/imageHelpers"
import { FILE_READ_BUDGET_PERCENT, readFileWithTokenBudget } from "./helpers/fileTokenBudget"
// kilocode_change: extracted documents share the same response budget
import { readTextWithTokenBudget, type ReadWithBudgetResult } from "../../integrations/misc/read-file-with-budget"
import { truncateDefinitionsToLineLimit } from "./helpers/truncateDefinitions"
import { BaseTool, ToolCallbacks } from "./BaseTool"

// kilocode_change start
/**
 * Asking for a file that is not there is a perfectly ordinary thing to do - the
 * model often checks whether it has to create one. Reporting that as a failed
 * tool call makes the turn look broken, so the absence is passed back as plain
 * information instead.
 */
function isFileNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT"
}
// kilocode_change end

interface FileResult {
	path: string
	status: "approved" | "denied" | "blocked" | "error" | "pending"
	content?: string
	error?: string
	notice?: string
	lineRanges?: LineRange[]
	xmlContent?: string
	nativeContent?: string
	imageDataUrl?: string
	feedbackText?: string
	feedbackImages?: any[]
}

export class ReadFileTool extends BaseTool<"read_file"> {
	readonly name = "read_file" as const

	parseLegacy(params: Partial<Record<string, string>>): { files: FileEntry[] } {
		const argsXmlTag = params.args
		const legacyPath = params.path
		const legacyStartLineStr = params.start_line
		const legacyEndLineStr = params.end_line

		const fileEntries: FileEntry[] = []

		// XML args format
		if (argsXmlTag) {
			const parsed = parseXml(argsXmlTag) as any
			const files = Array.isArray(parsed.file) ? parsed.file : [parsed.file].filter(Boolean)

			for (const file of files) {
				if (!file.path) continue

				const fileEntry: FileEntry = {
					path: file.path,
					lineRanges: [],
				}

				if (file.line_range) {
					const ranges = Array.isArray(file.line_range) ? file.line_range : [file.line_range]
					for (const range of ranges) {
						const match = String(range).match(/(\d+)-(\d+)/)
						if (match) {
							const [, start, end] = match.map(Number)
							if (!isNaN(start) && !isNaN(end)) {
								fileEntry.lineRanges?.push({ start, end })
							}
						}
					}
				}
				fileEntries.push(fileEntry)
			}

			return { files: fileEntries }
		}

		// Legacy single file path
		if (legacyPath) {
			const fileEntry: FileEntry = {
				path: legacyPath,
				lineRanges: [],
			}

			if (legacyStartLineStr && legacyEndLineStr) {
				const start = parseInt(legacyStartLineStr, 10)
				const end = parseInt(legacyEndLineStr, 10)
				if (!isNaN(start) && !isNaN(end) && start > 0 && end > 0) {
					fileEntry.lineRanges?.push({ start, end })
				}
			}
			fileEntries.push(fileEntry)
		}

		return { files: fileEntries }
	}

	async execute(params: { files: FileEntry[] }, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult, toolProtocol } = callbacks
		const fileEntries = params.files
		const modelInfo = task.api.getModel().info
		// Use the task's locked protocol for consistent output formatting throughout the task
		const protocol = resolveToolProtocol(task.apiConfiguration, modelInfo, task.taskToolProtocol)
		const useNative = isNativeProtocol(protocol)

		if (!fileEntries || fileEntries.length === 0) {
			task.consecutiveMistakeCount++
			task.recordToolError("read_file")
			const errorMsg = await task.sayAndCreateMissingParamError("read_file", "args (containing valid file paths)")
			const errorResult = useNative ? `Error: ${errorMsg}` : `<files><error>${errorMsg}</error></files>`
			pushToolResult(errorResult)
			return
		}

		// Enforce maxConcurrentFileReads limit
		const { maxConcurrentFileReads = 5 } = (await task.providerRef.deref()?.getState()) ?? {}
		if (fileEntries.length > maxConcurrentFileReads) {
			task.consecutiveMistakeCount++
			task.recordToolError("read_file")
			const errorMsg = `Too many files requested. You attempted to read ${fileEntries.length} files, but the concurrent file reads limit is ${maxConcurrentFileReads}. Please read files in batches of ${maxConcurrentFileReads} or fewer.`
			await task.say("error", errorMsg)
			const errorResult = useNative ? `Error: ${errorMsg}` : `<files><error>${errorMsg}</error></files>`
			pushToolResult(errorResult)
			return
		}

		const supportsImages = modelInfo.supportsImages ?? false

		const fileResults: FileResult[] = fileEntries.map((entry) => ({
			path: entry.path,
			status: "pending",
			lineRanges: entry.lineRanges,
		}))

		const updateFileResult = (filePath: string, updates: Partial<FileResult>) => {
			const index = fileResults.findIndex((result) => result.path === filePath)
			if (index !== -1) {
				fileResults[index] = { ...fileResults[index], ...updates }
			}
		}

		try {
			const filesToApprove: FileResult[] = []

			for (const fileResult of fileResults) {
				const relPath = fileResult.path
				const fullPath = path.resolve(task.cwd, relPath)

				if (fileResult.lineRanges) {
					let hasRangeError = false
					for (const range of fileResult.lineRanges) {
						if (range.start > range.end) {
							const errorMsg = "Invalid line range: end line cannot be less than start line"
							updateFileResult(relPath, {
								status: "blocked",
								error: errorMsg,
								xmlContent: `<file><path>${relPath}</path><error>Error reading file: ${errorMsg}</error></file>`,
								nativeContent: `File: ${relPath}\nError: Error reading file: ${errorMsg}`,
							})
							await task.say("error", `Error reading file ${relPath}: ${errorMsg}`)
							hasRangeError = true
							break
						}
						if (
							!Number.isSafeInteger(range.start) ||
							!Number.isSafeInteger(range.end) ||
							range.start < 1 ||
							range.end < 1
						) {
							// kilocode_change
							const errorMsg = "Invalid line range values"
							updateFileResult(relPath, {
								status: "blocked",
								error: errorMsg,
								xmlContent: `<file><path>${relPath}</path><error>Error reading file: ${errorMsg}</error></file>`,
								nativeContent: `File: ${relPath}\nError: Error reading file: ${errorMsg}`,
							})
							await task.say("error", `Error reading file ${relPath}: ${errorMsg}`)
							hasRangeError = true
							break
						}
					}
					if (hasRangeError) continue
				}

				if (fileResult.status === "pending") {
					const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)
					if (!accessAllowed) {
						await task.say("rooignore_error", relPath)
						const errorMsg = formatResponse.rooIgnoreError(relPath)
						updateFileResult(relPath, {
							status: "blocked",
							error: errorMsg,
							xmlContent: `<file><path>${relPath}</path><error>${errorMsg}</error></file>`,
							nativeContent: `File: ${relPath}\nError: ${errorMsg}`,
						})
						continue
					}

					filesToApprove.push(fileResult)
				}
			}

			if (filesToApprove.length > 1) {
				const { maxReadFileLine = 500 /*kilocode_change*/ } = (await task.providerRef.deref()?.getState()) ?? {}

				const batchFiles = filesToApprove.map((fileResult) => {
					const relPath = fileResult.path
					const fullPath = path.resolve(task.cwd, relPath)
					const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)

					let lineSnippet = ""
					if (fileResult.lineRanges && fileResult.lineRanges.length > 0) {
						const ranges = fileResult.lineRanges.map((range) =>
							t("tools:readFile.linesRange", { start: range.start, end: range.end }),
						)
						lineSnippet = ranges.join(", ")
					} else if (maxReadFileLine === 0) {
						lineSnippet = t("tools:readFile.definitionsOnly")
					} else if (maxReadFileLine > 0) {
						lineSnippet = t("tools:readFile.maxLines", { max: maxReadFileLine })
					}

					const readablePath = getReadablePath(task.cwd, relPath)
					const key = `${readablePath}${lineSnippet ? ` (${lineSnippet})` : ""}`

					return { path: readablePath, lineSnippet, isOutsideWorkspace, key, content: fullPath }
				})

				const completeMessage = JSON.stringify({ tool: "readFile", batchFiles } satisfies ClineSayTool)
				const { response, text, images } = await task.ask("tool", completeMessage, false)

				if (response === "yesButtonClicked") {
					if (text) await task.say("user_feedback", text, images)
					filesToApprove.forEach((fileResult) => {
						updateFileResult(fileResult.path, {
							status: "approved",
							feedbackText: text,
							feedbackImages: images,
						})
					})
				} else if (response === "noButtonClicked") {
					if (text) await task.say("user_feedback", text, images)
					task.didRejectTool = true
					filesToApprove.forEach((fileResult) => {
						updateFileResult(fileResult.path, {
							status: "denied",
							xmlContent: `<file><path>${fileResult.path}</path><status>Denied by user</status></file>`,
							nativeContent: `File: ${fileResult.path}\nStatus: Denied by user`,
							feedbackText: text,
							feedbackImages: images,
						})
					})
				} else {
					try {
						const individualPermissions = JSON.parse(text || "{}")
						let hasAnyDenial = false

						batchFiles.forEach((batchFile, index) => {
							const fileResult = filesToApprove[index]
							const approved = individualPermissions[batchFile.key] === true

							if (approved) {
								updateFileResult(fileResult.path, { status: "approved" })
							} else {
								hasAnyDenial = true
								updateFileResult(fileResult.path, {
									status: "denied",
									xmlContent: `<file><path>${fileResult.path}</path><status>Denied by user</status></file>`,
									nativeContent: `File: ${fileResult.path}\nStatus: Denied by user`,
								})
							}
						})

						if (hasAnyDenial) task.didRejectTool = true
					} catch (error) {
						console.error("Failed to parse individual permissions:", error)
						task.didRejectTool = true
						filesToApprove.forEach((fileResult) => {
							updateFileResult(fileResult.path, {
								status: "denied",
								xmlContent: `<file><path>${fileResult.path}</path><status>Denied by user</status></file>`,
								nativeContent: `File: ${fileResult.path}\nStatus: Denied by user`,
							})
						})
					}
				}
			} else if (filesToApprove.length === 1) {
				const fileResult = filesToApprove[0]
				const relPath = fileResult.path
				const fullPath = path.resolve(task.cwd, relPath)
				const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)
				const { maxReadFileLine = 500 /*kilocode_change*/ } = (await task.providerRef.deref()?.getState()) ?? {}

				let lineSnippet = ""
				if (fileResult.lineRanges && fileResult.lineRanges.length > 0) {
					const ranges = fileResult.lineRanges.map((range) =>
						t("tools:readFile.linesRange", { start: range.start, end: range.end }),
					)
					lineSnippet = ranges.join(", ")
				} else if (maxReadFileLine === 0) {
					lineSnippet = t("tools:readFile.definitionsOnly")
				} else if (maxReadFileLine > 0) {
					lineSnippet = t("tools:readFile.maxLines", { max: maxReadFileLine })
				}

				const completeMessage = JSON.stringify({
					tool: "readFile",
					path: getReadablePath(task.cwd, relPath),
					isOutsideWorkspace,
					content: fullPath,
					reason: lineSnippet,
				} satisfies ClineSayTool)

				const { response, text, images } = await task.ask("tool", completeMessage, false)

				if (response !== "yesButtonClicked") {
					if (text) await task.say("user_feedback", text, images)
					task.didRejectTool = true
					updateFileResult(relPath, {
						status: "denied",
						xmlContent: `<file><path>${relPath}</path><status>Denied by user</status></file>`,
						nativeContent: `File: ${relPath}\nStatus: Denied by user`,
						feedbackText: text,
						feedbackImages: images,
					})
				} else {
					if (text) await task.say("user_feedback", text, images)
					updateFileResult(relPath, { status: "approved", feedbackText: text, feedbackImages: images })
				}
			}

			const imageMemoryTracker = new ImageMemoryTracker()
			const state = await task.providerRef.deref()?.getState()
			const {
				maxReadFileLine = 500 /*kilocode_change*/,
				maxImageFileSize = DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
				maxTotalImageSize = DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
			} = state ?? {}

			// kilocode_change start: one bounded text allowance for the entire batch
			const { id: modelId, info } = task.api.getModel()
			const maxOutputTokens =
				getModelMaxOutputTokens({ modelId, model: info, settings: task.apiConfiguration }) ??
				ANTHROPIC_DEFAULT_MAX_TOKENS
			const available = info.contextWindow - maxOutputTokens - (task.getTokenUsage().contextTokens || 0)
			// Reserve room for paths, notices and protocol wrappers; never bypass a full context.
			let remainingBudget = Number.isFinite(available)
				? Math.max(
						0,
						Math.min(16_000, Math.floor(available * FILE_READ_BUDGET_PERCENT)) - 512 * fileEntries.length,
					)
				: 0
			const contextExhausted = remainingBudget === 0
			const rangeHint = (start: number, end: number) =>
				useNative ? `line_ranges: [[${start}, ${end}]]` : `<line_range>${start}-${end}</line_range>`
			// kilocode_change end

			for (const fileResult of fileResults) {
				if (fileResult.status !== "approved") continue

				const relPath = fileResult.path
				const fullPath = path.resolve(task.cwd, relPath)

				try {
					// Check if the path is a directory before attempting to read it
					const stats = await fs.stat(fullPath)
					if (stats.isDirectory()) {
						const errorMsg = `Cannot read '${relPath}' because it is a directory. To view the contents of a directory, use the list_files tool instead.`
						updateFileResult(relPath, {
							status: "error",
							error: errorMsg,
							xmlContent: `<file><path>${relPath}</path><error>Error reading file: ${errorMsg}</error></file>`,
							nativeContent: `File: ${relPath}\nError: Error reading file: ${errorMsg}`,
						})
						await task.say("error", `Error reading file ${relPath}: ${errorMsg}`)
						continue
					}

					const [totalLines, isBinary] = await Promise.all([countFileLines(fullPath), isBinaryFile(fullPath)])

					// kilocode_change start
					const renderText = async (extracted?: string) => {
						const count =
							extracted === undefined
								? totalLines
								: extracted
									? extracted.replace(/\r?\n$/, "").split(/\r?\n/).length
									: 0
						const explicit = !!fileResult.lineRanges?.length
						const ranges = explicit
							? fileResult.lineRanges!
							: [
									{
										start: 1,
										end: Math.max(
											1,
											maxReadFileLine > 0 ? Math.min(count, maxReadFileLine) : count,
										),
									},
								]
						const xml: string[] = []
						const native: string[] = []
						for (let index = 0; index < ranges.length; index++) {
							const range = ranges[index]
							const options = {
								budgetTokens: remainingBudget,
								startLine: range.start,
								endLine: range.end,
								includeLineNumbers: true,
							}
							const result: ReadWithBudgetResult =
								remainingBudget <= 0
									? { content: "", tokenCount: 0, lineCount: 0, complete: count === 0 }
									: extracted === undefined
										? await readFileWithTokenBudget(fullPath, options)
										: await readTextWithTokenBudget(extracted, options)
							remainingBudget = Math.max(0, remainingBudget - result.tokenCount - 128)
							const last = range.start + result.lineCount - 1
							if (result.lineCount > 0) {
								const numbered = addLineNumbers(result.content + "\n", range.start)
								xml.push(`<content lines="${range.start}-${last}">\n${numbered}</content>`)
								native.push(`Lines ${range.start}-${last}:\n${numbered}`)
							}
							let notice = ""
							if (!result.complete) {
								const next = range.start + result.lineCount
								notice = `File truncated by the shared response budget. ${result.lineCount ? `Continue at line ${next}` : `No lines read from line ${next}`}; use ${rangeHint(next, Math.max(next, Math.min(range.end, next + 199)))}. ${ranges.length - index - 1} later requested ranges were not read. `
								if (contextExhausted)
									notice +=
										"No available context budget for file reading. Compact the conversation before retrying; do not repeat the same full-file request or edit unread content."
								else if (!result.lineCount)
									notice +=
										"The batch allowance is exhausted or the next single line exceeds the safe response limit. Read this range in a separate call; if it still does not fit, compact context or use targeted search. Do not assume this line was read."
							} else if (!explicit && last < count) {
								notice = `Showing only ${result.lineCount} of ${count} total lines. Continue with ${rangeHint(last + 1, Math.min(count, last + 200))}.`
							} else if (count === 0) notice = "File is empty"
							if (notice) {
								xml.push(`<notice>${notice}</notice>`)
								native.push(`Note: ${notice}`)
							}
							if (!result.complete) break
						}
						// Preserve the useful code outline when the configured preview omits lines.
						if (
							!explicit &&
							maxReadFileLine > 0 &&
							count > maxReadFileLine &&
							remainingBudget > 0 &&
							extracted === undefined
						) {
							try {
								const definitions = await parseSourceCodeDefinitionsForFile(
									fullPath,
									task.rooIgnoreController,
								)
								if (definitions) {
									const result = await readTextWithTokenBudget(
										truncateDefinitionsToLineLimit(definitions, maxReadFileLine),
										{ budgetTokens: remainingBudget },
									)
									remainingBudget = Math.max(0, remainingBudget - result.tokenCount - 128)
									xml.push(
										`<list_code_definition_names>${result.content}</list_code_definition_names>${result.complete ? "" : "<notice>Definitions truncated by response budget.</notice>"}`,
									)
									native.push(
										`Code Definitions:\n${result.content}${result.complete ? "" : "\nNote: Definitions truncated by response budget."}`,
									)
								}
							} catch (error) {
								console.warn("[read_file] Could not extract definitions", error)
							}
						}
						await task.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)
						updateFileResult(relPath, {
							xmlContent: `<file><path>${relPath}</path>\n${xml.join("\n")}\n</file>`,
							nativeContent: `File: ${relPath}\n${native.join("\n\n")}`,
						})
					}
					// kilocode_change end

					if (isBinary) {
						const fileExtension = path.extname(relPath).toLowerCase()
						const supportedBinaryFormats = getSupportedBinaryFormats()

						if (isSupportedImageFormat(fileExtension)) {
							try {
								const validationResult = await validateImageForProcessing(
									fullPath,
									supportsImages,
									maxImageFileSize,
									maxTotalImageSize,
									imageMemoryTracker.getTotalMemoryUsed(),
								)

								if (!validationResult.isValid) {
									await task.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)
									updateFileResult(relPath, {
										xmlContent: `<file><path>${relPath}</path>\n<notice>${validationResult.notice}</notice>\n</file>`,
										nativeContent: `File: ${relPath}\nNote: ${validationResult.notice}`,
									})
									continue
								}

								const imageResult = await processImageFile(fullPath)
								imageMemoryTracker.addMemoryUsage(imageResult.sizeInMB)
								await task.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)

								updateFileResult(relPath, {
									xmlContent: `<file><path>${relPath}</path>\n<notice>${imageResult.notice}</notice>\n</file>`,
									nativeContent: `File: ${relPath}\nNote: ${imageResult.notice}`,
									imageDataUrl: imageResult.dataUrl,
								})
								continue
							} catch (error) {
								const errorMsg = error instanceof Error ? error.message : String(error)
								updateFileResult(relPath, {
									status: "error",
									error: `Error reading image file: ${errorMsg}`,
									xmlContent: `<file><path>${relPath}</path><error>Error reading image file: ${errorMsg}</error></file>`,
									nativeContent: `File: ${relPath}\nError: Error reading image file: ${errorMsg}`,
								})
								await task.say("error", `Error reading image file ${relPath}: ${errorMsg}`)
								continue
							}
						}

						if (supportedBinaryFormats && supportedBinaryFormats.includes(fileExtension)) {
							// Use extractTextFromFile for supported binary formats (PDF, DOCX, etc.)
							try {
								const content = await extractTextFromFile(fullPath)
								// kilocode_change start: extracted text uses the same ranges and batch budget
								await renderText(content)
								// kilocode_change end
								continue
							} catch (error) {
								const errorMsg = error instanceof Error ? error.message : String(error)
								updateFileResult(relPath, {
									status: "error",
									error: `Error extracting text: ${errorMsg}`,
									xmlContent: `<file><path>${relPath}</path><error>Error extracting text: ${errorMsg}</error></file>`,
									nativeContent: `File: ${relPath}\nError: Error extracting text: ${errorMsg}`,
								})
								await task.say("error", `Error extracting text from ${relPath}: ${errorMsg}`)
								continue
							}
						} else {
							const fileFormat = fileExtension.slice(1) || "bin"
							updateFileResult(relPath, {
								notice: `Binary file format: ${fileFormat}`,
								xmlContent: `<file><path>${relPath}</path>\n<binary_file format="${fileFormat}">Binary file - content not displayed</binary_file>\n</file>`,
								nativeContent: `File: ${relPath}\nBinary file (${fileFormat}) - content not displayed`,
							})
							continue
						}
					}

					// kilocode_change start: all ordinary text reads use the same bounded path
					if (maxReadFileLine === 0 && !fileResult.lineRanges?.length) {
						let definitions: string | undefined
						try {
							definitions =
								(await parseSourceCodeDefinitionsForFile(fullPath, task.rooIgnoreController)) ??
								undefined
						} catch (error) {
							console.warn("[read_file] Could not extract definitions", error)
						}
						const result = await readTextWithTokenBudget(definitions || "", {
							budgetTokens: remainingBudget,
						})
						remainingBudget = Math.max(0, remainingBudget - result.tokenCount - 128)
						const notice = `Showing only 0 of ${totalLines} total lines. ${result.complete ? "" : "Definitions truncated. "}Read file content with ${rangeHint(1, Math.max(1, Math.min(totalLines, 200)))}.${contextExhausted ? " Context budget exhausted; compact the conversation before retrying." : ""}`
						updateFileResult(relPath, {
							xmlContent: `<file><path>${relPath}</path><list_code_definition_names>${result.content}</list_code_definition_names><notice>${notice}</notice></file>`,
							nativeContent: `File: ${relPath}\nCode Definitions:\n${result.content}\n\nNote: ${notice}`,
						})
					} else {
						await renderText()
					}
					// kilocode_change end
				} catch (error) {
					// kilocode_change start: a missing file is an answer, not a failure
					if (isFileNotFoundError(error)) {
						const notice = `File does not exist: ${relPath}`
						updateFileResult(relPath, {
							xmlContent: `<file><path>${relPath}</path><notice>${notice}</notice></file>`,
							nativeContent: `File: ${relPath}\nNotice: ${notice}`,
						})
						continue
					}
					// kilocode_change end

					const errorMsg = error instanceof Error ? error.message : String(error)
					updateFileResult(relPath, {
						status: "error",
						error: `Error reading file: ${errorMsg}`,
						xmlContent: `<file><path>${relPath}</path><error>Error reading file: ${errorMsg}</error></file>`,
						nativeContent: `File: ${relPath}\nError: Error reading file: ${errorMsg}`,
					})
					await task.say("error", `Error reading file ${relPath}: ${errorMsg}`)
				}
			}

			// Check if any files had errors or were blocked and mark the turn as failed
			const hasErrors = fileResults.some((result) => result.status === "error" || result.status === "blocked")
			if (hasErrors) {
				task.didToolFailInCurrentTurn = true
			}

			// Build final result based on protocol
			let finalResult: string
			if (useNative) {
				const nativeResults = fileResults
					.filter((result) => result.nativeContent)
					.map((result) => result.nativeContent)
				finalResult = nativeResults.join("\n\n---\n\n")
			} else {
				const xmlResults = fileResults.filter((result) => result.xmlContent).map((result) => result.xmlContent)
				finalResult = `<files>\n${xmlResults.join("\n")}\n</files>`
			}

			const fileImageUrls = fileResults
				.filter((result) => result.imageDataUrl)
				.map((result) => result.imageDataUrl as string)

			let statusMessage = ""
			let feedbackImages: any[] = []

			const deniedWithFeedback = fileResults.find((result) => result.status === "denied" && result.feedbackText)

			if (deniedWithFeedback && deniedWithFeedback.feedbackText) {
				statusMessage = formatResponse.toolDeniedWithFeedback(deniedWithFeedback.feedbackText)
				feedbackImages = deniedWithFeedback.feedbackImages || []
			} else if (task.didRejectTool) {
				statusMessage = formatResponse.toolDenied()
			} else {
				const approvedWithFeedback = fileResults.find(
					(result) => result.status === "approved" && result.feedbackText,
				)

				if (approvedWithFeedback && approvedWithFeedback.feedbackText) {
					statusMessage = formatResponse.toolApprovedWithFeedback(approvedWithFeedback.feedbackText)
					feedbackImages = approvedWithFeedback.feedbackImages || []
				}
			}

			const allImages = [...feedbackImages, ...fileImageUrls]

			const finalModelSupportsImages = task.api.getModel().info.supportsImages ?? false
			const imagesToInclude = finalModelSupportsImages ? allImages : []

			if (statusMessage || imagesToInclude.length > 0) {
				const result = formatResponse.toolResult(
					statusMessage || finalResult,
					imagesToInclude.length > 0 ? imagesToInclude : undefined,
				)

				if (typeof result === "string") {
					if (statusMessage) {
						pushToolResult(`${result}\n${finalResult}`)
					} else {
						pushToolResult(result)
					}
				} else {
					if (statusMessage) {
						const textBlock = { type: "text" as const, text: finalResult }
						pushToolResult([...result, textBlock])
					} else {
						pushToolResult(result)
					}
				}
			} else {
				pushToolResult(finalResult)
			}
		} catch (error) {
			const relPath = fileEntries[0]?.path || "unknown"
			const errorMsg = error instanceof Error ? error.message : String(error)

			if (fileResults.length > 0) {
				updateFileResult(relPath, {
					status: "error",
					error: `Error reading file: ${errorMsg}`,
					xmlContent: `<file><path>${relPath}</path><error>Error reading file: ${errorMsg}</error></file>`,
					nativeContent: `File: ${relPath}\nError: Error reading file: ${errorMsg}`,
				})
			}

			await task.say("error", `Error reading file ${relPath}: ${errorMsg}`)

			// Mark that a tool failed in this turn
			task.didToolFailInCurrentTurn = true

			// Build final error result based on protocol
			let errorResult: string
			if (useNative) {
				const nativeResults = fileResults
					.filter((result) => result.nativeContent)
					.map((result) => result.nativeContent)
				errorResult = nativeResults.join("\n\n---\n\n")
			} else {
				const xmlResults = fileResults.filter((result) => result.xmlContent).map((result) => result.xmlContent)
				errorResult = `<files>\n${xmlResults.join("\n")}\n</files>`
			}

			pushToolResult(errorResult)
		}
	}

	getReadFileToolDescription(blockName: string, blockParams: any): string
	getReadFileToolDescription(blockName: string, nativeArgs: { files: FileEntry[] }): string
	getReadFileToolDescription(blockName: string, second: any): string {
		// If native typed args ({ files: FileEntry[] }) were provided
		if (second && typeof second === "object" && "files" in second && Array.isArray(second.files)) {
			const paths = (second.files as FileEntry[]).map((f) => f?.path).filter(Boolean) as string[]
			if (paths.length === 0) {
				return `[${blockName} with no valid paths]`
			} else if (paths.length === 1) {
				return `[${blockName} for '${paths[0]}'. Reading multiple files at once is more efficient for the LLM. If other files are relevant to your current task, please read them simultaneously.]`
			} else if (paths.length <= 3) {
				const pathList = paths.map((p) => `'${p}'`).join(", ")
				return `[${blockName} for ${pathList}]`
			} else {
				return `[${blockName} for ${paths.length} files]`
			}
		}

		// Fallback to legacy/XML or synthesized params
		const blockParams = second as any

		if (blockParams?.args) {
			try {
				const parsed = parseXml(blockParams.args) as any
				const files = Array.isArray(parsed.file) ? parsed.file : [parsed.file].filter(Boolean)
				const paths = files.map((f: any) => f?.path).filter(Boolean) as string[]

				if (paths.length === 0) {
					return `[${blockName} with no valid paths]`
				} else if (paths.length === 1) {
					return `[${blockName} for '${paths[0]}'. Reading multiple files at once is more efficient for the LLM. If other files are relevant to your current task, please read them simultaneously.]`
				} else if (paths.length <= 3) {
					const pathList = paths.map((p) => `'${p}'`).join(", ")
					return `[${blockName} for ${pathList}]`
				} else {
					return `[${blockName} for ${paths.length} files]`
				}
			} catch (error) {
				console.error("Failed to parse read_file args XML for description:", error)
				return `[${blockName} with unparsable args]`
			}
		} else if (blockParams?.path) {
			return `[${blockName} for '${blockParams.path}'. Reading multiple files at once is more efficient for the LLM. If other files are relevant to your current task, please read them simultaneously.]`
		} else if (blockParams?.files) {
			// Back-compat: some paths may still synthesize params.files; try to parse if present
			try {
				const files = JSON.parse(blockParams.files)
				if (Array.isArray(files) && files.length > 0) {
					const paths = files.map((f: any) => f?.path).filter(Boolean) as string[]
					if (paths.length === 1) {
						return `[${blockName} for '${paths[0]}'. Reading multiple files at once is more efficient for the LLM. If other files are relevant to your current task, please read them simultaneously.]`
					} else if (paths.length <= 3) {
						const pathList = paths.map((p) => `'${p}'`).join(", ")
						return `[${blockName} for ${pathList}]`
					} else {
						return `[${blockName} for ${paths.length} files]`
					}
				}
			} catch (error) {
				console.error("Failed to parse native files JSON for description:", error)
				return `[${blockName} with unparsable files]`
			}
		}

		return `[${blockName} with missing path/args/files]`
	}

	override async handlePartial(task: Task, block: ToolUse<"read_file">): Promise<void> {
		const argsXmlTag = block.params.args
		const legacyPath = block.params.path

		let filePath = ""
		if (argsXmlTag) {
			const match = argsXmlTag.match(/<file>.*?<path>([^<]+)<\/path>/s)
			if (match) filePath = match[1]
		}
		if (!filePath && legacyPath) {
			filePath = legacyPath
		}

		if (!filePath && block.nativeArgs && "files" in block.nativeArgs && Array.isArray(block.nativeArgs.files)) {
			const files = block.nativeArgs.files
			if (files.length > 0 && files[0]?.path) {
				filePath = files[0].path
			}
		}

		const fullPath = filePath ? path.resolve(task.cwd, filePath) : ""
		const sharedMessageProps: ClineSayTool = {
			tool: "readFile",
			path: getReadablePath(task.cwd, filePath),
			isOutsideWorkspace: filePath ? isPathOutsideWorkspace(fullPath) : false,
		}
		const partialMessage = JSON.stringify({
			...sharedMessageProps,
			content: undefined,
		} satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const readFileTool = new ReadFileTool()
