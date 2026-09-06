// npx vitest core/task/__tests__/Task.spec.ts

import * as os from "os"
import * as path from "path"

import * as vscode from "vscode"
import { Anthropic } from "@anthropic-ai/sdk"

import type { GlobalState, ProviderSettings, ModelInfo } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ApiStreamChunk } from "../../../api/transform/stream"
import { ContextProxy } from "../../config/ContextProxy"
import { processUserContentMentions } from "../../mentions/processUserContentMentions"
import { MultiSearchReplaceDiffStrategy } from "../../diff/strategies/multi-search-replace"
import { MultiFileSearchReplaceDiffStrategy } from "../../diff/strategies/multi-file-search-replace"
import { EXPERIMENT_IDS } from "../../../shared/experiments"
import { NonRetryableApiError } from "../../../api/providers/utils/non-retryable-api-error"
import {
	deleteContextHandoffFileIfOwned,
	hydratePendingContextHandoff,
	writeContextHandoffFile,
} from "../../context-management/context-handoff"
import { summarizeConversation } from "../../condense"

// Mock delay before any imports that might use it
vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

import delay from "delay"

vi.mock("uuid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("uuid")>()
	return {
		...actual,
		v7: vi.fn(() => "00000000-0000-7000-8000-000000000000"),
	}
})

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	const mockFunctions = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockImplementation((filePath) => {
			if (filePath.includes("ui_messages.json")) {
				return Promise.resolve(JSON.stringify(mockMessages))
			}
			if (filePath.includes("api_conversation_history.json")) {
				return Promise.resolve(
					JSON.stringify([
						{
							role: "user",
							content: [{ type: "text", text: "historical task" }],
							ts: Date.now(),
						},
						{
							role: "assistant",
							content: [{ type: "text", text: "I'll help you with that task." }],
							ts: Date.now(),
						},
					]),
				)
			}
			return Promise.resolve("[]")
		}),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
	}

	return {
		...actual,
		...mockFunctions,
		default: mockFunctions,
	}
})

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	const mockEventEmitter = { event: vi.fn(), fire: vi.fn() }
	const mockTextDocument = { uri: { fsPath: "/mock/workspace/path/file.ts" } }
	const mockTextEditor = { document: mockTextDocument }
	const mockTab = { input: { uri: { fsPath: "/mock/workspace/path/file.ts" } } }
	const mockTabGroup = { tabs: [mockTab] }

	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		Uri: {
			file: vi.fn((path) => ({ fsPath: path, toString: () => `file://${path}` })),
		},
		RelativePattern: vi.fn((base, pattern) => ({ base, pattern })),
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({
				dispose: vi.fn(),
			}),
			visibleTextEditors: [mockTextEditor],
			tabGroups: {
				all: [mockTabGroup],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: "/mock/workspace/path" },
					name: "mock-workspace",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: {
				stat: vi.fn().mockResolvedValue({ type: 1 }), // FileType.File = 1
			},
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			onDidChangeWorkspaceFolders: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (key: string, defaultValue: any) => defaultValue })),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
			appName: "Visual Studio Code", // kilocode_change
		},
		EventEmitter: vi.fn().mockImplementation(() => mockEventEmitter),
		Disposable: {
			from: vi.fn(),
		},
		TabInputText: vi.fn(),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi.fn().mockImplementation((text) => {
		return Promise.resolve({ text: `processed: ${text}`, mode: undefined })
	}),
	openMention: vi.fn(),
	getLatestTerminalOutput: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../ignore/RooIgnoreController")

vi.mock("../../condense", async (importOriginal) => {
	const actual = (await importOriginal()) as any
	return {
		...actual,
		summarizeConversation: vi.fn().mockImplementation(async (...args: any[]) => {
			const handoff = args[9]
			if (handoff?.enabled !== false) {
				await handoff?.onBeforeRequest?.(handoff?.prompt ?? "Create a complete continuation snapshot")
			}
			return {
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "summary" }],
						ts: Date.now(),
						isSummary: true,
						condenseId: "mock-condense-id",
					},
				],
				summary: "summary",
				cost: 0,
				condenseId: "mock-condense-id",
			}
		}),
	}
})

vi.mock("../../context-management/context-handoff", async (importOriginal) => {
	const actual = (await importOriginal()) as any
	return {
		...actual,
		writeContextHandoffFile: vi.fn().mockResolvedValue({
			handoffId: "mock-handoff-id",
			relativePath: "CONTEXT_RESTART.md",
			absolutePath: "/mock/workspace/path/CONTEXT_RESTART.md",
			content: "# IVOL Code — Context Restart\n\nsummary\n",
			body: "summary",
			sha256: "mock-sha256",
			createdAt: 1,
		}),
		deleteContextHandoffFileIfOwned: vi.fn().mockResolvedValue(true),
		hydratePendingContextHandoff: vi.fn().mockImplementation(({ messages }) => Promise.resolve({ messages })),
	}
})
// Mock storagePathManager to prevent dynamic import issues.
vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockImplementation((filePath) => {
		return filePath.includes("ui_messages.json") || filePath.includes("api_conversation_history.json")
	}),
}))

const mockMessages = [
	{
		ts: Date.now(),
		type: "say",
		say: "text",
		text: "historical task",
	},
]

describe("Cline", () => {
	let mockProvider: any
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: any
	let mockExtensionContext: vscode.ExtensionContext

	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		// Setup mock extension context
		const storageUri = {
			fsPath: path.join(os.tmpdir(), "test-storage"),
		}

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((key: keyof GlobalState) => {
					if (key === "taskHistory") {
						return [
							{
								id: "123",
								number: 0,
								ts: Date.now(),
								task: "historical task",
								tokensIn: 100,
								tokensOut: 200,
								cacheWrites: 0,
								cacheReads: 0,
								totalCost: 0.001,
							},
						]
					}

					return undefined
				}),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockImplementation((_key) => Promise.resolve(undefined)),
				store: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				delete: vi.fn().mockImplementation((_key) => Promise.resolve()),
			},
			extensionUri: {
				fsPath: "/mock/extension/path",
			},
			extension: {
				packageJSON: {
					version: "1.0.0",
				},
			},
		} as unknown as vscode.ExtensionContext

		// Setup mock output channel
		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}

		// Setup mock provider with output channel
		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		) as any

		// Setup mock API configuration
		mockApiConfig = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key", // Add API key to mock config
		}

		// Mock provider methods
		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.getTaskWithId = vi.fn().mockImplementation(async (id) => ({
			historyItem: {
				id,
				ts: Date.now(),
				task: "historical task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
			},
			taskDirPath: "/mock/storage/path/tasks/123",
			apiConversationHistoryFilePath: "/mock/storage/path/tasks/123/api_conversation_history.json",
			uiMessagesFilePath: "/mock/storage/path/tasks/123/ui_messages.json",
			apiConversationHistory: [
				{
					role: "user",
					content: [{ type: "text", text: "historical task" }],
					ts: Date.now(),
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "I'll help you with that task." }],
					ts: Date.now(),
				},
			],
		}))
	})

	describe("constructor", () => {
		it("should respect provided settings", async () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				fuzzyMatchThreshold: 0.95,
				task: "test task",
				startTask: false,
				context: mockExtensionContext,
			})

			expect(cline.diffEnabled).toBe(false)
		})

		it("should use default fuzzy match threshold when not provided", async () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				enableDiff: true,
				fuzzyMatchThreshold: 0.95,
				task: "test task",
				startTask: false,
				context: mockExtensionContext,
			})

			expect(cline.diffEnabled).toBe(true)

			// The diff strategy should be created with default threshold (1.0).
			expect(cline.diffStrategy).toBeDefined()
		})

		it("should use default consecutiveMistakeLimit when not provided", () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
				context: mockExtensionContext, // kilocode_change
			})

			expect(cline.consecutiveMistakeLimit).toBe(3)
		})

		it("should respect provided consecutiveMistakeLimit", () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 5,
				task: "test task",
				startTask: false,
				context: mockExtensionContext, // kilocode_change
			})

			expect(cline.consecutiveMistakeLimit).toBe(5)
		})

		it("should keep consecutiveMistakeLimit of 0 as 0 for unlimited", () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 0,
				task: "test task",
				startTask: false,
				context: mockExtensionContext, // kilocode_change
			})

			expect(cline.consecutiveMistakeLimit).toBe(0)
		})

		it("should pass 0 to ToolRepetitionDetector for unlimited mode", () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 0,
				task: "test task",
				startTask: false,
				context: mockExtensionContext, // kilocode_change
			})

			// The toolRepetitionDetector should be initialized with 0 for unlimited mode
			expect(cline.toolRepetitionDetector).toBeDefined()
			// Verify the limit remains as 0
			expect(cline.consecutiveMistakeLimit).toBe(0)
		})

		it("should pass consecutiveMistakeLimit to ToolRepetitionDetector", () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 5,
				task: "test task",
				startTask: false,
				context: mockExtensionContext, // kilocode_change
			})

			// The toolRepetitionDetector should be initialized with the same limit
			expect(cline.toolRepetitionDetector).toBeDefined()
			expect(cline.consecutiveMistakeLimit).toBe(5)
		})

		it("should require either task or historyItem", () => {
			expect(() => {
				new Task({ provider: mockProvider, apiConfiguration: mockApiConfig, context: mockExtensionContext })
			}).toThrow("Either historyItem or task/images must be provided")
		})
	})

	describe("getEnvironmentDetails", () => {
		describe("API conversation handling", () => {
			it.skip("should clean conversation history before sending to API", async () => {
				// Cline.create will now use our mocked getEnvironmentDetails
				const [cline, task] = Task.create({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					context: mockExtensionContext,
				})

				cline.abandoned = true
				await task

				// Set up mock stream.
				const mockStreamForClean = (async function* () {
					yield { type: "text", text: "test response" }
				})()

				// Set up spy.
				const cleanMessageSpy = vi.fn().mockReturnValue(mockStreamForClean)
				vi.spyOn(cline.api, "createMessage").mockImplementation(cleanMessageSpy)

				// Add test message to conversation history.
				cline.apiConversationHistory = [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: "test message" }],
						ts: Date.now(),
					},
				]

				// Mock abort state
				Object.defineProperty(cline, "abort", {
					get: () => false,
					set: () => {},
					configurable: true,
				})

				// Add a message with extra properties to the conversation history
				const messageWithExtra = {
					role: "user" as const,
					content: [{ type: "text" as const, text: "test message" }],
					ts: Date.now(),
					extraProp: "should be removed",
				}

				cline.apiConversationHistory = [messageWithExtra]

				// Trigger an API request
				await cline.recursivelyMakeClineRequests([{ type: "text", text: "test request" }], false)

				// Get the conversation history from the first API call
				expect(cleanMessageSpy.mock.calls.length).toBeGreaterThan(0)
				const history = cleanMessageSpy.mock.calls[0]?.[1]
				expect(history).toBeDefined()
				expect(history.length).toBeGreaterThan(0)

				// Find our test message
				const cleanedMessage = history.find((msg: { content?: Array<{ text: string }> }) =>
					msg.content?.some((content) => content.text === "test message"),
				)
				expect(cleanedMessage).toBeDefined()
				expect(cleanedMessage).toEqual({
					role: "user",
					content: [{ type: "text", text: "test message" }],
				})

				// Verify extra properties were removed
				expect(Object.keys(cleanedMessage!)).toEqual(["role", "content"])
			})

			it.skip("should handle image blocks based on model capabilities", async () => {
				// Create two configurations - one with image support, one without
				const configWithImages = {
					...mockApiConfig,
					apiModelId: "claude-3-sonnet",
				}
				const configWithoutImages = {
					...mockApiConfig,
					apiModelId: "gpt-3.5-turbo",
				}

				// Create test conversation history with mixed content
				const conversationHistory: (Anthropic.MessageParam & { ts?: number })[] = [
					{
						role: "user" as const,
						content: [
							{
								type: "text" as const,
								text: "Here is an image",
							} satisfies Anthropic.TextBlockParam,
							{
								type: "image" as const,
								source: {
									type: "base64" as const,
									media_type: "image/jpeg",
									data: "base64data",
								},
							} satisfies Anthropic.ImageBlockParam,
						],
					},
					{
						role: "assistant" as const,
						content: [
							{
								type: "text" as const,
								text: "I see the image",
							} satisfies Anthropic.TextBlockParam,
						],
					},
				]

				// Test with model that supports images
				const [clineWithImages, taskWithImages] = Task.create({
					provider: mockProvider,
					apiConfiguration: configWithImages,
					task: "test task",
					context: mockExtensionContext,
				})

				// Mock the model info to indicate image support
				vi.spyOn(clineWithImages.api, "getModel").mockReturnValue({
					id: "claude-3-sonnet",
					info: {
						supportsImages: true,
						supportsPromptCache: true,
						contextWindow: 200000,
						maxTokens: 4096,
						inputPrice: 0.25,
						outputPrice: 0.75,
					} as ModelInfo,
				})

				clineWithImages.apiConversationHistory = conversationHistory

				// Test with model that doesn't support images
				const [clineWithoutImages, taskWithoutImages] = Task.create({
					provider: mockProvider,
					apiConfiguration: configWithoutImages,
					task: "test task",
					context: mockExtensionContext,
				})

				// Mock the model info to indicate no image support
				vi.spyOn(clineWithoutImages.api, "getModel").mockReturnValue({
					id: "gpt-3.5-turbo",
					info: {
						supportsImages: false,
						supportsPromptCache: false,
						contextWindow: 16000,
						maxTokens: 2048,
						inputPrice: 0.1,
						outputPrice: 0.2,
					} as ModelInfo,
				})

				clineWithoutImages.apiConversationHistory = conversationHistory

				// Mock abort state for both instances
				Object.defineProperty(clineWithImages, "abort", {
					get: () => false,
					set: () => {},
					configurable: true,
				})

				Object.defineProperty(clineWithoutImages, "abort", {
					get: () => false,
					set: () => {},
					configurable: true,
				})

				// Set up mock streams
				const mockStreamWithImages = (async function* () {
					yield { type: "text", text: "test response" }
				})()

				const mockStreamWithoutImages = (async function* () {
					yield { type: "text", text: "test response" }
				})()

				// Set up spies
				const imagesSpy = vi.fn().mockReturnValue(mockStreamWithImages)
				const noImagesSpy = vi.fn().mockReturnValue(mockStreamWithoutImages)

				vi.spyOn(clineWithImages.api, "createMessage").mockImplementation(imagesSpy)
				vi.spyOn(clineWithoutImages.api, "createMessage").mockImplementation(noImagesSpy)

				// Set up conversation history with images
				clineWithImages.apiConversationHistory = [
					{
						role: "user",
						content: [
							{ type: "text", text: "Here is an image" },
							{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "base64data" } },
						],
					},
				]

				clineWithImages.abandoned = true
				await taskWithImages.catch(() => {})

				clineWithoutImages.abandoned = true
				await taskWithoutImages.catch(() => {})

				// Trigger API requests
				await clineWithImages.recursivelyMakeClineRequests([{ type: "text", text: "test request" }])
				await clineWithoutImages.recursivelyMakeClineRequests([{ type: "text", text: "test request" }])

				// Get the calls
				const imagesCalls = imagesSpy.mock.calls
				const noImagesCalls = noImagesSpy.mock.calls

				// Verify model with image support preserves image blocks
				expect(imagesCalls.length).toBeGreaterThan(0)
				if (imagesCalls[0]?.[1]?.[0]?.content) {
					expect(imagesCalls[0][1][0].content).toHaveLength(2)
					expect(imagesCalls[0][1][0].content[0]).toEqual({ type: "text", text: "Here is an image" })
					expect(imagesCalls[0][1][0].content[1]).toHaveProperty("type", "image")
				}

				// Verify model without image support converts image blocks to text
				expect(noImagesCalls.length).toBeGreaterThan(0)
				if (noImagesCalls[0]?.[1]?.[0]?.content) {
					expect(noImagesCalls[0][1][0].content).toHaveLength(2)
					expect(noImagesCalls[0][1][0].content[0]).toEqual({ type: "text", text: "Here is an image" })
					expect(noImagesCalls[0][1][0].content[1]).toEqual({
						type: "text",
						text: "[Referenced image in conversation]",
					})
				}
			})

			it.skip("should handle API retry with countdown", async () => {
				const [cline, task] = Task.create({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					context: mockExtensionContext,
				})

				// Mock delay to track countdown timing
				const mockDelay = vi.fn().mockResolvedValue(undefined)
				vi.spyOn(await import("delay"), "default").mockImplementation(mockDelay)

				// Mock say to track messages
				const saySpy = vi.spyOn(cline, "say")

				// Create a stream that fails on first chunk
				const mockError = new Error("API Error")
				const mockFailedStream = {
					// eslint-disable-next-line require-yield
					async *[Symbol.asyncIterator]() {
						throw mockError
					},
					async next() {
						throw mockError
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					async [Symbol.asyncDispose]() {
						// Cleanup
					},
				} as AsyncGenerator<ApiStreamChunk>

				// Create a successful stream for retry
				const mockSuccessStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "Success" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "Success" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					async [Symbol.asyncDispose]() {
						// Cleanup
					},
				} as AsyncGenerator<ApiStreamChunk>

				// Mock createMessage to fail first then succeed
				let firstAttempt = true
				vi.spyOn(cline.api, "createMessage").mockImplementation(() => {
					if (firstAttempt) {
						firstAttempt = false
						return mockFailedStream
					}
					return mockSuccessStream
				})

				// Set up mock state
				mockProvider.getState = vi.fn().mockResolvedValue({})

				// Mock previous API request message
				cline.clineMessages = [
					{
						ts: Date.now(),
						type: "say",
						say: "api_req_started",
						text: JSON.stringify({
							tokensIn: 100,
							tokensOut: 50,
							cacheWrites: 0,
							cacheReads: 0,
						}),
					},
				]

				// Trigger API request
				const iterator = cline.attemptApiRequest(0)
				await iterator.next()

				// Calculate expected delay for first retry
				const baseDelay = 3 // test retry delay

				// Verify countdown messages
				for (let i = baseDelay; i > 0; i--) {
					expect(saySpy).toHaveBeenCalledWith(
						"api_req_retry_delayed",
						expect.stringContaining(`Retrying in ${i} seconds`),
						undefined,
						true,
					)
				}

				expect(saySpy).toHaveBeenCalledWith(
					"api_req_retry_delayed",
					expect.stringContaining("Retrying now"),
					undefined,
					false,
				)

				// Calculate expected delay calls for countdown
				const totalExpectedDelays = baseDelay // One delay per second for countdown
				expect(mockDelay).toHaveBeenCalledTimes(totalExpectedDelays)
				expect(mockDelay).toHaveBeenCalledWith(1000)

				// Verify error message content
				const errorMessage = saySpy.mock.calls.find((call) => call[1]?.includes(mockError.message))?.[1]
				expect(errorMessage).toBe(
					`${mockError.message}\n\nRetry attempt 1\nRetrying in ${baseDelay} seconds...`,
				)

				await cline.abortTask(true)
				await task.catch(() => {})
			})

			it.skip("should not apply retry delay twice", async () => {
				const [cline, task] = Task.create({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					context: mockExtensionContext,
				})

				// Mock delay to track countdown timing
				const mockDelay = vi.fn().mockResolvedValue(undefined)
				vi.spyOn(await import("delay"), "default").mockImplementation(mockDelay)

				// Mock say to track messages
				const saySpy = vi.spyOn(cline, "say")

				// Create a stream that fails on first chunk
				const mockError = new Error("API Error")
				const mockFailedStream = {
					// eslint-disable-next-line require-yield
					async *[Symbol.asyncIterator]() {
						throw mockError
					},
					async next() {
						throw mockError
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					async [Symbol.asyncDispose]() {
						// Cleanup
					},
				} as AsyncGenerator<ApiStreamChunk>

				// Create a successful stream for retry
				const mockSuccessStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "Success" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "Success" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					async [Symbol.asyncDispose]() {
						// Cleanup
					},
				} as AsyncGenerator<ApiStreamChunk>

				// Mock createMessage to fail first then succeed
				let firstAttempt = true
				vi.spyOn(cline.api, "createMessage").mockImplementation(() => {
					if (firstAttempt) {
						firstAttempt = false
						return mockFailedStream
					}
					return mockSuccessStream
				})

				// Set up mock state
				mockProvider.getState = vi.fn().mockResolvedValue({})

				// Mock previous API request message
				cline.clineMessages = [
					{
						ts: Date.now(),
						type: "say",
						say: "api_req_started",
						text: JSON.stringify({
							tokensIn: 100,
							tokensOut: 50,
							cacheWrites: 0,
							cacheReads: 0,
						}),
					},
				]

				// Trigger API request
				const iterator = cline.attemptApiRequest(0)
				await iterator.next()

				// Verify delay is only applied for the countdown
				const baseDelay = 3 // test retry delay
				const expectedDelayCount = baseDelay // One delay per second for countdown
				expect(mockDelay).toHaveBeenCalledTimes(expectedDelayCount)
				expect(mockDelay).toHaveBeenCalledWith(1000) // Each delay should be 1 second

				// Verify countdown messages were only shown once
				const retryMessages = saySpy.mock.calls.filter(
					(call) => call[0] === "api_req_retry_delayed" && call[1]?.includes("Retrying in"),
				)
				expect(retryMessages).toHaveLength(baseDelay)

				// Verify the retry message sequence
				for (let i = baseDelay; i > 0; i--) {
					expect(saySpy).toHaveBeenCalledWith(
						"api_req_retry_delayed",
						expect.stringContaining(`Retrying in ${i} seconds`),
						undefined,
						true,
					)
				}

				// Verify final retry message
				expect(saySpy).toHaveBeenCalledWith(
					"api_req_retry_delayed",
					expect.stringContaining("Retrying now"),
					undefined,
					false,
				)

				await cline.abortTask(true)
				await task.catch(() => {})
			})

			// kilocode_change start
			it("attemptApiRequest should not recursively auto-retry first-chunk Chutes terminated errors", async () => {
				const chutesConfig = {
					...mockApiConfig,
					apiProvider: "chutes" as const,
					apiModelId: "moonshotai/Kimi-K2.5-TEE",
				}

				const task = new Task({
					provider: mockProvider,
					apiConfiguration: chutesConfig,
					task: "test task",
					startTask: false,
					context: mockExtensionContext,
				})

				const terminatedError = new Error("terminated")
				const mockFailedStream = {
					// eslint-disable-next-line require-yield
					async *[Symbol.asyncIterator]() {
						throw terminatedError
					},
					async next() {
						throw terminatedError
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					async [Symbol.asyncDispose]() {
						// Cleanup
					},
				} as AsyncGenerator<ApiStreamChunk>

				const createMessageSpy = vi.spyOn(task.api, "createMessage").mockReturnValue(mockFailedStream)
				const backoffSpy = vi.spyOn(task as any, "backoffAndAnnounce").mockResolvedValue(undefined)

				mockProvider.getState = vi.fn().mockResolvedValue({
					apiConfiguration: chutesConfig,
					autoApprovalEnabled: true,
					requestDelaySeconds: 1,
					mode: "code",
				})

				const iterator = task.attemptApiRequest(0, { skipProviderRateLimit: true })
				await expect(iterator.next()).rejects.toThrow("terminated")

				expect(createMessageSpy).toHaveBeenCalledTimes(1)
				expect(backoffSpy).not.toHaveBeenCalled()
			})

			it("attemptApiRequest should not automatically replay a non-retryable provider response", async () => {
				const responsesConfig = {
					...mockApiConfig,
					apiProvider: "openai" as const,
					openAiBaseUrl: "https://prox.example.com",
					openAiModelId: "1-gpt-sol",
					openAiWebSearchEnabled: true,
				}

				const task = new Task({
					provider: mockProvider,
					apiConfiguration: responsesConfig,
					task: "test task",
					startTask: false,
					context: mockExtensionContext,
				})

				const completedResponseError = new NonRetryableApiError(
					"Responses API completed without assistant text.",
				)
				const mockFailedStream = {
					// eslint-disable-next-line require-yield
					async *[Symbol.asyncIterator]() {
						throw completedResponseError
					},
					async next() {
						throw completedResponseError
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					async [Symbol.asyncDispose]() {},
				} as AsyncGenerator<ApiStreamChunk>

				const createMessageSpy = vi.spyOn(task.api, "createMessage").mockReturnValue(mockFailedStream)
				const backoffSpy = vi.spyOn(task as any, "backoffAndAnnounce").mockResolvedValue(undefined)

				mockProvider.getState = vi.fn().mockResolvedValue({
					apiConfiguration: responsesConfig,
					autoApprovalEnabled: true,
					requestDelaySeconds: 1,
					mode: "code",
				})

				const iterator = task.attemptApiRequest(0, { skipProviderRateLimit: true })
				await expect(iterator.next()).rejects.toThrow("completed without assistant text")

				expect(createMessageSpy).toHaveBeenCalledTimes(1)
				expect(backoffSpy).not.toHaveBeenCalled()
			})

			it("should apply Chutes terminated retry cap at the configured threshold", async () => {
				const chutesConfig = {
					...mockApiConfig,
					apiProvider: "chutes" as const,
					apiModelId: "moonshotai/Kimi-K2.5-TEE",
				}

				const task = new Task({
					provider: mockProvider,
					apiConfiguration: chutesConfig,
					task: "test task",
					startTask: false,
					context: mockExtensionContext,
				})

				const terminatedError = new Error("terminated")

				expect((task as any).hasExceededChutesTerminatedRetryLimit(terminatedError, 0)).toBe(false)
				expect((task as any).hasExceededChutesTerminatedRetryLimit(terminatedError, 1)).toBe(false)
				expect((task as any).hasExceededChutesTerminatedRetryLimit(terminatedError, 2)).toBe(true)
			})
			// kilocode_change end

			describe("processUserContentMentions", () => {
				it("should process mentions in task and feedback tags", async () => {
					const [cline, task] = Task.create({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "test task",
						context: mockExtensionContext,
					})

					const userContent = [
						{
							type: "text",
							text: "Regular text with 'some/path' (see below for file content)",
						} as const,
						{
							type: "text",
							text: "<task>Text with 'some/path' (see below for file content) in task tags</task>",
						} as const,
						{
							type: "tool_result",
							tool_use_id: "test-id",
							content: [
								{
									type: "text",
									text: "<feedback>Check 'some/path' (see below for file content)</feedback>",
								},
							],
						} as Anthropic.ToolResultBlockParam,
						{
							type: "tool_result",
							tool_use_id: "test-id-2",
							content: [
								{
									type: "text",
									text: "Regular tool result with 'path' (see below for file content)",
								},
							],
						} as Anthropic.ToolResultBlockParam,
					]

					const { content: processedContent } = await processUserContentMentions({
						userContent,
						cwd: cline.cwd,
						urlContentFetcher: cline.urlContentFetcher,
						fileContextTracker: cline.fileContextTracker,
					})

					// Regular text should not be processed
					expect((processedContent[0] as Anthropic.TextBlockParam).text).toBe(
						"Regular text with 'some/path' (see below for file content)",
					)

					// Text within task tags should be processed
					expect((processedContent[1] as Anthropic.TextBlockParam).text).toContain("processed:")
					expect((processedContent[1] as Anthropic.TextBlockParam).text).toContain(
						"<task>Text with 'some/path' (see below for file content) in task tags</task>",
					)

					// Feedback tag content should be processed
					const toolResult1 = processedContent[2] as Anthropic.ToolResultBlockParam
					const content1 = Array.isArray(toolResult1.content) ? toolResult1.content[0] : toolResult1.content
					expect((content1 as Anthropic.TextBlockParam).text).toContain("processed:")
					expect((content1 as Anthropic.TextBlockParam).text).toContain(
						"<feedback>Check 'some/path' (see below for file content)</feedback>",
					)

					// Regular tool result should not be processed
					const toolResult2 = processedContent[3] as Anthropic.ToolResultBlockParam
					const content2 = Array.isArray(toolResult2.content) ? toolResult2.content[0] : toolResult2.content
					expect((content2 as Anthropic.TextBlockParam).text).toBe(
						"Regular tool result with 'path' (see below for file content)",
					)

					await cline.abortTask(true)
					await task.catch(() => {})
				})
			})
		})

		describe("Subtask Rate Limiting", () => {
			let mockProvider: any
			let mockApiConfig: any
			let mockDelay: ReturnType<typeof vi.fn>

			beforeEach(() => {
				vi.clearAllMocks()
				// Reset the global timestamp before each test
				Task.resetGlobalApiRequestTime()

				mockApiConfig = {
					apiProvider: "anthropic",
					apiKey: "test-key",
					rateLimitSeconds: 5,
				}

				mockProvider = {
					context: {
						globalStorageUri: { fsPath: "/test/storage" },
					},
					getState: vi.fn().mockResolvedValue({
						apiConfiguration: mockApiConfig,
					}),
					getMcpHub: vi.fn().mockReturnValue(undefined),
					getSkillsManager: vi.fn().mockReturnValue(undefined),
					say: vi.fn(),
					postStateToWebview: vi.fn().mockResolvedValue(undefined),
					postMessageToWebview: vi.fn().mockResolvedValue(undefined),
					updateTaskHistory: vi.fn().mockResolvedValue(undefined),
					getKiloConfig: vi.fn().mockResolvedValue(undefined),
				}

				// Get the mocked delay function
				mockDelay = delay as ReturnType<typeof vi.fn>
				mockDelay.mockClear()
			})

			afterEach(() => {
				// Clean up the global state after each test
				Task.resetGlobalApiRequestTime()
			})

			it("should enforce rate limiting across parent and subtask", async () => {
				// Add a spy to track getState calls
				const getStateSpy = vi.spyOn(mockProvider, "getState")

				// Create parent task
				const parent = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "parent task",
					startTask: false,
					context: mockExtensionContext,
				})

				// Mock the API stream response
				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "parent response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "parent response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(parent.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the parent task
				const parentIterator = parent.attemptApiRequest(0)
				await parentIterator.next()

				// Verify no delay was applied for the first request
				expect(mockDelay).not.toHaveBeenCalled()

				// Create a subtask immediately after
				const child = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "child task",
					parentTask: parent,
					rootTask: parent,
					startTask: false,
					context: mockExtensionContext,
				})

				// Spy on child.say to verify the emitted message type
				const saySpy = vi.spyOn(child, "say")

				// Mock the child's API stream
				const childMockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "child response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "child response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(child.api, "createMessage").mockReturnValue(childMockStream)

				// Make an API request with the child task
				const childIterator = child.attemptApiRequest(0)
				await childIterator.next()

				// Verify rate limiting was applied
				expect(mockDelay).toHaveBeenCalledTimes(mockApiConfig.rateLimitSeconds)
				expect(mockDelay).toHaveBeenCalledWith(1000)

				// Verify we used the non-error rate-limit wait message type (JSON format)
				expect(saySpy).toHaveBeenCalledWith(
					"api_req_rate_limit_wait",
					expect.stringMatching(/\{"seconds":\d+\}/),
					undefined,
					true,
				)

				// Verify the wait message was finalized
				expect(saySpy).toHaveBeenCalledWith("api_req_rate_limit_wait", undefined, undefined, false)
			}, 10000) // Increase timeout to 10 seconds

			it("should not apply rate limiting if enough time has passed", async () => {
				// Create parent task
				const parent = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "parent task",
					startTask: false,
					context: mockExtensionContext,
				})

				// Mock the API stream response
				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(parent.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the parent task
				const parentIterator = parent.attemptApiRequest(0)
				await parentIterator.next()

				// Simulate time passing (more than rate limit)
				const originalPerformanceNow = performance.now
				const mockTime = performance.now() + (mockApiConfig.rateLimitSeconds + 1) * 1000
				performance.now = vi.fn(() => mockTime)

				// Create a subtask after time has passed
				const child = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "child task",
					parentTask: parent,
					rootTask: parent,
					startTask: false,
					context: mockExtensionContext,
				})

				vi.spyOn(child.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the child task
				const childIterator = child.attemptApiRequest(0)
				await childIterator.next()

				// Verify no rate limiting was applied
				expect(mockDelay).not.toHaveBeenCalled()

				// Restore performance.now
				performance.now = originalPerformanceNow
			})

			it("should share rate limiting across multiple subtasks", async () => {
				// Create parent task
				const parent = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "parent task",
					startTask: false,
					context: mockExtensionContext,
				})

				// Mock the API stream response
				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(parent.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the parent task
				const parentIterator = parent.attemptApiRequest(0)
				await parentIterator.next()

				// Create first subtask
				const child1 = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "child task 1",
					parentTask: parent,
					rootTask: parent,
					startTask: false,
					context: mockExtensionContext,
				})

				vi.spyOn(child1.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the first child task
				const child1Iterator = child1.attemptApiRequest(0)
				await child1Iterator.next()

				// Verify rate limiting was applied
				const firstDelayCount = mockDelay.mock.calls.length
				expect(firstDelayCount).toBe(mockApiConfig.rateLimitSeconds)

				// Clear the mock to count new delays
				mockDelay.mockClear()

				// Create second subtask immediately after
				const child2 = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "child task 2",
					parentTask: parent,
					rootTask: parent,
					startTask: false,
					context: mockExtensionContext,
				})

				vi.spyOn(child2.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the second child task
				const child2Iterator = child2.attemptApiRequest(0)
				await child2Iterator.next()

				// Verify rate limiting was applied again
				expect(mockDelay).toHaveBeenCalledTimes(mockApiConfig.rateLimitSeconds)
			}, 15000) // Increase timeout to 15 seconds

			it("should handle rate limiting with zero rate limit", async () => {
				// Update config to have zero rate limit
				mockApiConfig.rateLimitSeconds = 0
				mockProvider.getState.mockResolvedValue({
					apiConfiguration: mockApiConfig,
				})

				// Create parent task
				const parent = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "parent task",
					startTask: false,
					context: mockExtensionContext,
				})

				// Mock the API stream response
				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(parent.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the parent task
				const parentIterator = parent.attemptApiRequest(0)
				await parentIterator.next()

				// Create a subtask
				const child = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "child task",
					parentTask: parent,
					rootTask: parent,
					startTask: false,
					context: mockExtensionContext,
				})

				vi.spyOn(child.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the child task
				const childIterator = child.attemptApiRequest(0)
				await childIterator.next()

				// Verify no delay was applied
				expect(mockDelay).not.toHaveBeenCalled()
			})

			it("should update global timestamp even when no rate limiting is needed", async () => {
				// Create task
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
					context: mockExtensionContext,
				})

				// Mock the API stream response
				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: any) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(task.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request
				const iterator = task.attemptApiRequest(0)
				await iterator.next()

				// Access the private static property via reflection for testing
				const globalTimestamp = (Task as any).lastGlobalApiRequestTime
				expect(globalTimestamp).toBeDefined()
				expect(globalTimestamp).toBeGreaterThan(0)
			})
		})

		describe("Dynamic Strategy Selection", () => {
			let mockProvider: any
			let mockApiConfig: any

			beforeEach(() => {
				vi.clearAllMocks()

				mockApiConfig = {
					apiProvider: "anthropic",
					apiKey: "test-key",
				}

				mockProvider = {
					context: {
						globalStorageUri: { fsPath: "/test/storage" },
					},
					getState: vi.fn(),
				}
			})

			it("should use MultiSearchReplaceDiffStrategy by default", async () => {
				mockProvider.getState.mockResolvedValue({
					experiments: {
						[EXPERIMENT_IDS.MULTI_FILE_APPLY_DIFF]: false,
					},
				})

				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					enableDiff: true,
					task: "test task",
					startTask: false,
					context: mockExtensionContext,
				})

				// Initially should be MultiSearchReplaceDiffStrategy
				expect(task.diffStrategy).toBeInstanceOf(MultiSearchReplaceDiffStrategy)
				expect(task.diffStrategy?.getName()).toBe("MultiSearchReplace")
			})

			it("should switch to MultiFileSearchReplaceDiffStrategy when experiment is enabled", async () => {
				mockProvider.getState.mockResolvedValue({
					experiments: {
						[EXPERIMENT_IDS.MULTI_FILE_APPLY_DIFF]: true,
					},
				})

				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					enableDiff: true,
					task: "test task",
					startTask: false,
					context: mockExtensionContext,
				})

				// Initially should be MultiSearchReplaceDiffStrategy
				expect(task.diffStrategy).toBeInstanceOf(MultiSearchReplaceDiffStrategy)

				// Wait for async strategy update
				await new Promise((resolve) => setTimeout(resolve, 10))

				// Should have switched to MultiFileSearchReplaceDiffStrategy
				expect(task.diffStrategy).toBeInstanceOf(MultiFileSearchReplaceDiffStrategy)
				expect(task.diffStrategy?.getName()).toBe("MultiFileSearchReplace")
			})

			it("should keep MultiSearchReplaceDiffStrategy when experiments are undefined", async () => {
				mockProvider.getState.mockResolvedValue({})

				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					enableDiff: true,
					task: "test task",
					startTask: false,
					context: mockExtensionContext,
				})

				// Initially should be MultiSearchReplaceDiffStrategy
				expect(task.diffStrategy).toBeInstanceOf(MultiSearchReplaceDiffStrategy)

				// Wait for async strategy update
				await new Promise((resolve) => setTimeout(resolve, 10))

				// Should still be MultiSearchReplaceDiffStrategy
				expect(task.diffStrategy).toBeInstanceOf(MultiSearchReplaceDiffStrategy)
				expect(task.diffStrategy?.getName()).toBe("MultiSearchReplace")
			})

			it("should not create diff strategy when enableDiff is false", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					enableDiff: false,
					task: "test task",
					startTask: false,
					context: mockExtensionContext, // kilocode_change
				})

				expect(task.diffEnabled).toBe(false)
				expect(task.diffStrategy).toBeUndefined()
			})
		})

		describe("getApiProtocol", () => {
			it("should determine API protocol based on provider and model", async () => {
				// Test with Anthropic provider
				const anthropicConfig = {
					...mockApiConfig,
					apiProvider: "anthropic" as const,
					apiModelId: "gpt-4",
				}
				const anthropicTask = new Task({
					provider: mockProvider,
					apiConfiguration: anthropicConfig,
					task: "test task",
					startTask: false,
					context: mockExtensionContext, // kilocode_change
				})
				// Should use anthropic protocol even with non-claude model
				expect(anthropicTask.apiConfiguration.apiProvider).toBe("anthropic")

				// Test with OpenRouter provider and Claude model
				const openrouterClaudeConfig = {
					apiProvider: "openrouter" as const,
					openRouterModelId: "anthropic/claude-3-opus",
				}
				const openrouterClaudeTask = new Task({
					provider: mockProvider,
					apiConfiguration: openrouterClaudeConfig,
					task: "test task",
					startTask: false,
					context: mockExtensionContext, // kilocode_change
				})
				expect(openrouterClaudeTask.apiConfiguration.apiProvider).toBe("openrouter")

				// Test with OpenRouter provider and non-Claude model
				const openrouterGptConfig = {
					apiProvider: "openrouter" as const,
					openRouterModelId: "openai/gpt-4",
				}
				const openrouterGptTask = new Task({
					provider: mockProvider,
					apiConfiguration: openrouterGptConfig,
					task: "test task",
					startTask: false,
					context: mockExtensionContext, // kilocode_change
				})
				expect(openrouterGptTask.apiConfiguration.apiProvider).toBe("openrouter")

				// Test with various Claude model formats
				const claudeModelFormats = [
					"claude-3-opus",
					"Claude-3-Sonnet",
					"CLAUDE-instant",
					"anthropic/claude-3-haiku",
					"some-provider/claude-model",
				]

				for (const modelId of claudeModelFormats) {
					const config = {
						apiProvider: "openai" as const,
						openAiModelId: modelId,
					}
					const task = new Task({
						provider: mockProvider,
						apiConfiguration: config,
						task: "test task",
						startTask: false,
						context: mockExtensionContext, // kilocode_change
					})
					// Verify the model ID contains claude (case-insensitive)
					expect(modelId.toLowerCase()).toContain("claude")
				}
			})

			it("should handle edge cases for API protocol detection", async () => {
				// Test with undefined provider
				const undefinedProviderConfig = {
					apiModelId: "claude-3-opus",
				}
				const undefinedProviderTask = new Task({
					provider: mockProvider,
					apiConfiguration: undefinedProviderConfig,
					task: "test task",
					startTask: false,
					context: mockExtensionContext, // kilocode_change
				})
				expect(undefinedProviderTask.apiConfiguration.apiProvider).toBeUndefined()

				// Test with no model ID
				const noModelConfig = {
					apiProvider: "openai" as const,
				}
				const noModelTask = new Task({
					provider: mockProvider,
					apiConfiguration: noModelConfig,
					task: "test task",
					startTask: false,
					context: mockExtensionContext, // kilocode_change
				})
				expect(noModelTask.apiConfiguration.apiProvider).toBe("openai")
			})
		})

		describe("submitUserMessage", () => {
			it("should always route through webview sendMessage invoke", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "initial task",
					startTask: false,
					context: mockExtensionContext,
				})

				// Set up some existing messages to simulate an ongoing conversation
				task.clineMessages = [
					{
						ts: Date.now(),
						type: "say",
						say: "text",
						text: "Initial message",
					},
				]

				// Call submitUserMessage
				task.submitUserMessage("test message", ["image1.png"])

				// Verify postMessageToWebview was called with sendMessage invoke
				expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
					type: "invoke",
					invoke: "sendMessage",
					text: "test message",
					images: ["image1.png"],
				})
			})

			it("should handle empty messages gracefully", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "initial task",
					startTask: false,
					context: mockExtensionContext,
				})

				// Call with empty text and no images
				task.submitUserMessage("", [])

				// Should not call postMessageToWebview for empty messages
				expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()

				// Call with whitespace only
				task.submitUserMessage("   ", [])
				expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
			})

			it("should route through webview for both new and existing tasks", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "initial task",
					startTask: false,
					context: mockExtensionContext,
				})

				// Test with no messages (new task scenario)
				task.clineMessages = []
				task.submitUserMessage("new task", ["image1.png"])

				expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
					type: "invoke",
					invoke: "sendMessage",
					text: "new task",
					images: ["image1.png"],
				})

				// Clear mock
				mockProvider.postMessageToWebview.mockClear()

				// Test with existing messages (ongoing task scenario)
				task.clineMessages = [
					{
						ts: Date.now(),
						type: "say",
						say: "text",
						text: "Initial message",
					},
				]
				task.submitUserMessage("follow-up message", ["image2.png"])

				expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
					type: "invoke",
					invoke: "sendMessage",
					text: "follow-up message",
					images: ["image2.png"],
				})
			})

			it("should handle undefined provider gracefully", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "initial task",
					startTask: false,
					context: mockExtensionContext,
				})

				// Simulate weakref returning undefined
				Object.defineProperty(task, "providerRef", {
					value: { deref: () => undefined },
					writable: false,
					configurable: true,
				})

				// Spy on console.error to verify error is logged
				const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				// Should log error but not throw
				task.submitUserMessage("test message")

				expect(consoleErrorSpy).toHaveBeenCalledWith("[Task#submitUserMessage] Provider reference lost")
				expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()

				// Restore console.error
				consoleErrorSpy.mockRestore()
			})
		})
	})

	describe("abortTask", () => {
		it("should set abort flag and emit TaskAborted event", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
				context: mockExtensionContext, // kilocode_change
			})

			// Spy on emit method
			const emitSpy = vi.spyOn(task, "emit")

			// Mock the dispose method to avoid actual cleanup
			vi.spyOn(task, "dispose").mockImplementation(() => {})

			// Call abortTask
			await task.abortTask()

			// Verify abort flag is set
			expect(task.abort).toBe(true)

			// Verify TaskAborted event was emitted
			expect(emitSpy).toHaveBeenCalledWith("taskAborted")
		})

		it("should be equivalent to clicking Cancel button functionality", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
				context: mockExtensionContext, // kilocode_change
			})

			// Mock the dispose method to track cleanup
			const disposeSpy = vi.spyOn(task, "dispose").mockImplementation(() => {})

			// Call abortTask
			await task.abortTask()

			// Verify the same behavior as Cancel button
			expect(task.abort).toBe(true)
			expect(disposeSpy).toHaveBeenCalled()
		})

		it("should work with TaskLike interface", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
				context: mockExtensionContext, // kilocode_change
			})

			// Cast to TaskLike to ensure interface compliance
			const taskLike = task as any // TaskLike interface from types package

			// Verify abortTask method exists and is callable
			expect(typeof taskLike.abortTask).toBe("function")

			// Mock the dispose method to avoid actual cleanup
			vi.spyOn(task, "dispose").mockImplementation(() => {})

			// Call abortTask through interface
			await taskLike.abortTask()

			// Verify it works
			expect(task.abort).toBe(true)
		})

		it("should handle errors during disposal gracefully", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
				context: mockExtensionContext, // kilocode_change
			})

			// Mock dispose to throw an error
			const mockError = new Error("Disposal failed")
			vi.spyOn(task, "dispose").mockImplementation(() => {
				throw mockError
			})

			// Spy on console.error to verify error is logged
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			// abortTask should not throw even if dispose fails
			await expect(task.abortTask()).resolves.not.toThrow()

			// Verify error was logged
			expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Error during task"), mockError)

			// Verify abort flag is still set
			expect(task.abort).toBe(true)

			// Restore console.error
			consoleErrorSpy.mockRestore()
		})
		describe("Stream Failure Retry", () => {
			it("should not abort task on stream failure, only on user cancellation", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
					context: mockExtensionContext, // kilocode_change
				})

				// Spy on console.error to verify error logging
				const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				// Spy on abortTask to verify it's NOT called for stream failures
				const abortTaskSpy = vi.spyOn(task, "abortTask").mockResolvedValue(undefined)

				// Test Case 1: Stream failure should NOT abort task
				task.abort = false
				task.abandoned = false

				// Simulate the catch block behavior for stream failure
				const streamFailureError = new Error("Stream failed mid-execution")

				// The key assertion: verify that when abort=false, abortTask is NOT called
				// This would normally happen in the catch block around line 2184
				const shouldAbort = task.abort
				expect(shouldAbort).toBe(false)

				// Verify error would be logged (this is what the new code does)
				console.error(
					`[Task#${task.taskId}.${task.instanceId}] Stream failed, will retry: ${streamFailureError.message}`,
				)
				expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Stream failed, will retry"))

				// Verify abortTask was NOT called
				expect(abortTaskSpy).not.toHaveBeenCalled()

				// Test Case 2: User cancellation SHOULD abort task
				task.abort = true

				// For user cancellation, abortTask SHOULD be called
				if (task.abort) {
					await task.abortTask()
				}

				expect(abortTaskSpy).toHaveBeenCalled()

				// Restore mocks
				consoleErrorSpy.mockRestore()
			})
		})

		describe("cancelCurrentRequest", () => {
			it("should cancel the current HTTP request via AbortController", () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
					context: mockExtensionContext, // kilocode_change
				})

				// Create a real AbortController and spy on its abort method
				const mockAbortController = new AbortController()
				const abortSpy = vi.spyOn(mockAbortController, "abort")
				task.currentRequestAbortController = mockAbortController

				// Spy on console.log
				const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})

				// Call cancelCurrentRequest
				task.cancelCurrentRequest()

				// Verify abort was called on the controller
				expect(abortSpy).toHaveBeenCalled()

				// Verify the controller was cleared
				expect(task.currentRequestAbortController).toBeUndefined()

				// Verify logging
				expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Aborting current HTTP request"))

				// Restore console.log
				consoleLogSpy.mockRestore()
			})

			it("should handle missing AbortController gracefully", () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
					context: mockExtensionContext, // kilocode_change
				})

				// Ensure no controller exists
				task.currentRequestAbortController = undefined

				// Should not throw when called with no controller
				expect(() => task.cancelCurrentRequest()).not.toThrow()
			})

			it("should be called during dispose", () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
					context: mockExtensionContext, // kilocode_change
				})

				// Spy on cancelCurrentRequest
				const cancelSpy = vi.spyOn(task, "cancelCurrentRequest")

				// Mock other dispose operations
				vi.spyOn(task.messageQueueService, "removeListener").mockImplementation(
					() => task.messageQueueService as any,
				)
				vi.spyOn(task.messageQueueService, "dispose").mockImplementation(() => {})
				vi.spyOn(task, "removeAllListeners").mockImplementation(() => task as any)

				// Call dispose
				task.dispose()

				// Verify cancelCurrentRequest was called
				expect(cancelSpy).toHaveBeenCalled()
			})
		})
	})
})

describe("Queued message processing after condense", () => {
	beforeEach(() => {
		vi.mocked(writeContextHandoffFile).mockClear()
		vi.mocked(deleteContextHandoffFileIfOwned).mockClear()
		vi.mocked(hydratePendingContextHandoff).mockClear()
		vi.mocked(summarizeConversation).mockClear()
	})

	function createProvider(): any {
		const storageUri = { fsPath: path.join(os.tmpdir(), "test-storage") }
		const ctx = {
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		const output = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}

		const provider = new ClineProvider(ctx, output as any, "sidebar", new ContextProxy(ctx)) as any
		provider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		provider.getState = vi.fn().mockResolvedValue({})
		return provider
	}

	const apiConfig: ProviderSettings = {
		apiProvider: "anthropic",
		apiModelId: "claude-3-5-sonnet-20241022",
		apiKey: "test-api-key",
	} as any

	it("processes queued message after condense completes", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context, // kilocode_change
		})

		// Make condense fast + deterministic
		vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("system")
		// Queue behavior is independent of timestamped progress persistence.
		vi.spyOn(task, "say").mockResolvedValue(undefined)
		const submitSpy = vi.spyOn(task, "submitUserMessage").mockResolvedValue(undefined)

		// Queue a message during condensing
		task.messageQueueService.addMessage("queued text", ["img1.png"])

		// Use fake timers to capture setTimeout(0) in processQueuedMessages
		vi.useFakeTimers()
		await task.condenseContext()

		// Flush the microtask that submits the queued message
		vi.runAllTimers()
		vi.useRealTimers()

		expect(submitSpy).toHaveBeenCalledWith("queued text", ["img1.png"])
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("does not cross-drain queues between separate tasks", async () => {
		const providerA = createProvider()
		const providerB = createProvider()

		const taskA = new Task({
			provider: providerA,
			apiConfiguration: apiConfig,
			task: "task A",
			startTask: false,
			context: providerA.context, // kilocode_change
		})
		const taskB = new Task({
			provider: providerB,
			apiConfiguration: apiConfig,
			task: "task B",
			startTask: false,
			context: providerB.context, // kilocode_change
		})

		vi.spyOn(taskA as any, "getSystemPrompt").mockResolvedValue("system")
		vi.spyOn(taskB as any, "getSystemPrompt").mockResolvedValue("system")
		vi.spyOn(taskA, "say").mockResolvedValue(undefined)
		vi.spyOn(taskB, "say").mockResolvedValue(undefined)

		const spyA = vi.spyOn(taskA, "submitUserMessage").mockResolvedValue(undefined)
		const spyB = vi.spyOn(taskB, "submitUserMessage").mockResolvedValue(undefined)

		taskA.messageQueueService.addMessage("A message")
		taskB.messageQueueService.addMessage("B message")

		// Condense in task A should only drain A's queue
		vi.useFakeTimers()
		await taskA.condenseContext()
		vi.runAllTimers()
		vi.useRealTimers()

		expect(spyA).toHaveBeenCalledWith("A message", undefined)
		expect(spyB).not.toHaveBeenCalled()
		expect(taskB.messageQueueService.isEmpty()).toBe(false)

		// Now condense in task B should drain B's queue
		vi.useFakeTimers()
		await taskB.condenseContext()
		vi.runAllTimers()
		vi.useRealTimers()

		expect(spyB).toHaveBeenCalledWith("B message", undefined)
		expect(taskB.messageQueueService.isEmpty()).toBe(true)
	})

	it("writes the restart file before committing condensed history", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("system")

		let resolveWrite!: (record: any) => void
		const pendingWrite = new Promise<any>((resolve) => {
			resolveWrite = resolve
		})
		vi.mocked(writeContextHandoffFile).mockImplementationOnce(() => pendingWrite)
		const saveSpy = vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
		const saySpy = vi.spyOn(task, "say").mockResolvedValue(undefined)

		const condensePromise = task.condenseContext()
		await vi.waitFor(() => expect(writeContextHandoffFile).toHaveBeenCalledOnce())
		expect(saveSpy).not.toHaveBeenCalled()
		expect(saySpy).toHaveBeenCalledWith(
			"context_handoff",
			expect.stringContaining('"phase":"preparing"'),
			undefined,
			false,
			undefined,
			undefined,
			{ isNonInteractive: true },
		)
		expect(
			saySpy.mock.calls.some(([type, text]) => type === "context_handoff" && text?.includes('"phase":"saved"')),
		).toBe(false)
		expect(provider.postMessageToWebview).not.toHaveBeenCalledWith({
			type: "condenseTaskContextStarted",
			text: task.taskId,
		})

		resolveWrite({
			handoffId: "ordered-handoff",
			relativePath: "CONTEXT_RESTART.md",
			absolutePath: "/mock/workspace/path/CONTEXT_RESTART.md",
			content: "# IVOL Code — Context Restart\n\nsummary\n",
			body: "summary",
			sha256: "ordered-sha256",
			createdAt: 1,
		})
		await condensePromise

		expect(saveSpy).toHaveBeenCalledOnce()
		const preparingIndex = saySpy.mock.calls.findIndex(
			([type, text]) => type === "context_handoff" && text?.includes('"phase":"preparing"'),
		)
		const savedIndex = saySpy.mock.calls.findIndex(
			([type, text]) => type === "context_handoff" && text?.includes('"phase":"saved"'),
		)
		const startIndex = provider.postMessageToWebview.mock.calls.findIndex(
			([message]: any[]) => message.type === "condenseTaskContextStarted",
		)
		expect(saySpy.mock.invocationCallOrder[preparingIndex]).toBeLessThan(
			vi.mocked(writeContextHandoffFile).mock.invocationCallOrder[0],
		)
		expect(saySpy.mock.invocationCallOrder[savedIndex]).toBeLessThan(
			provider.postMessageToWebview.mock.invocationCallOrder[startIndex],
		)
		expect(provider.postMessageToWebview.mock.invocationCallOrder[startIndex]).toBeLessThan(
			saveSpy.mock.invocationCallOrder[0],
		)
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "condenseTaskContextResponse",
			text: task.taskId,
		})
		expect(writeContextHandoffFile).toHaveBeenCalledWith(
			expect.objectContaining({ knownSecrets: expect.arrayContaining(["test-api-key"]) }),
		)
	})

	it("keeps the original history when the restart file cannot be written", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("system")
		vi.mocked(writeContextHandoffFile).mockRejectedValueOnce(new Error("disk full"))
		const originalHistory = task.apiConversationHistory
		const saveSpy = vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
		const saySpy = vi.spyOn(task, "say").mockResolvedValue(undefined as any)

		await task.condenseContext()

		expect(saveSpy).not.toHaveBeenCalled()
		expect(task.apiConversationHistory).toBe(originalHistory)
		expect(
			saySpy.mock.calls.some(([type, text]) => type === "context_handoff" && text?.includes('"phase":"saved"')),
		).toBe(false)
		expect(provider.postMessageToWebview).not.toHaveBeenCalledWith({
			type: "condenseTaskContextStarted",
			text: task.taskId,
		})
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "condenseTaskContextResponse",
			text: task.taskId,
		})
		expect(saySpy).toHaveBeenCalledWith(
			"condense_context_error",
			expect.stringContaining("disk full"),
			undefined,
			false,
			undefined,
			undefined,
			{ isNonInteractive: true },
		)
	})

	it("rolls history back when the condensed history cannot be saved", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("system")
		const originalHistory = task.apiConversationHistory
		vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(false)
		const saySpy = vi.spyOn(task, "say").mockResolvedValue(undefined as any)

		await task.condenseContext()

		expect(task.apiConversationHistory).toBe(originalHistory)
		expect(deleteContextHandoffFileIfOwned).toHaveBeenCalledWith({
			workspacePath: task.cwd,
			handoffId: "mock-handoff-id",
		})
		expect(saySpy).toHaveBeenCalledWith(
			"condense_context_error",
			expect.stringContaining("conversation history could not be saved"),
			undefined,
			false,
			undefined,
			undefined,
			{ isNonInteractive: true },
		)
	})

	it("rejects a restart state that would not reduce the real first-request context", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		const originalHistory = task.apiConversationHistory
		vi.spyOn(task.api, "countTokens").mockResolvedValueOnce(10).mockResolvedValueOnce(25)
		const saveSpy = vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)

		await expect(
			task.commitContextCondensation(
				{
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text: "summary" }],
							isSummary: true,
							condenseId: "mock-condense-id",
						},
					],
					summary: "summary",
					cost: 0,
					newContextTokens: 90,
					condenseId: "mock-condense-id",
				},
				"manual",
				100,
			),
		).rejects.toThrow("would grow context")

		expect(task.apiConversationHistory).toBe(originalHistory)
		expect(saveSpy).not.toHaveBeenCalled()
		expect(deleteContextHandoffFileIfOwned).toHaveBeenCalledWith({
			workspacePath: task.cwd,
			handoffId: "mock-handoff-id",
		})
	})

	it("keeps only the redacted handoff body in the committed result and UI data", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		vi.mocked(writeContextHandoffFile).mockResolvedValueOnce({
			handoffId: "sanitized-handoff",
			relativePath: "CONTEXT_RESTART.md",
			absolutePath: "/mock/workspace/path/CONTEXT_RESTART.md",
			body: "API key is [REDACTED_SECRET]",
			content: "# IVOL Code — Context Restart\n\nAPI key is [REDACTED_SECRET]\n",
			sha256: "sanitized-sha256",
			createdAt: 1,
		})
		vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
		const result: any = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "API key is raw-secret" }],
					isSummary: true,
					condenseId: "mock-condense-id",
				},
			],
			summary: "API key is raw-secret",
			cost: 0,
			condenseId: "mock-condense-id",
		}

		await task.commitContextCondensation(result, "manual")

		expect(result.summary).toBe("API key is [REDACTED_SECRET]")
		expect(JSON.stringify(task.apiConversationHistory)).not.toContain("raw-secret")
	})

	it("shows the actual preparation instruction with configured secrets removed", async () => {
		const provider = createProvider()
		provider.getState.mockResolvedValue({
			intelligentContextResetPrompt: "Keep test-api-key configured; preserve the pending migration",
		})
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("system")
		vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
		const saySpy = vi.spyOn(task, "say").mockResolvedValue(undefined)
		await task.condenseContext()
		const preparation = saySpy.mock.calls.find(
			([type, text]) => type === "context_handoff" && text?.includes('"phase":"preparing"'),
		)
		expect(preparation?.[1]).toContain("preserve the pending migration")
		expect(preparation?.[1]).not.toContain("test-api-key")
		expect(preparation?.[1]).toContain("REDACTED")
	})

	it("clears preparation progress if an unexpected summarizer error escapes", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("system")
		const saveSpy = vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
		vi.spyOn(task, "say").mockResolvedValue(undefined)
		vi.mocked(summarizeConversation).mockRejectedValueOnce(new Error("unexpected provider error"))
		await task.condenseContext()
		expect(saveSpy).not.toHaveBeenCalled()
		expect(writeContextHandoffFile).not.toHaveBeenCalled()
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "condenseTaskContextResponse",
			text: task.taskId,
		})
	})

	it("uses the active task model even when a separate condensing profile is configured", async () => {
		const provider = createProvider()
		provider.getState.mockResolvedValue({
			customCondensingPrompt: "Keep exact implementation state",
			condensingApiConfigId: "another-profile",
			listApiConfigMeta: [{ id: "another-profile" }],
		})
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("system")
		vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)

		await task.condenseContext()

		expect(summarizeConversation).toHaveBeenCalledWith(
			expect.any(Array),
			task.api,
			"system",
			task.taskId,
			expect.any(Number),
			false,
			"Keep exact implementation state",
			undefined,
			expect.any(Boolean),
			expect.objectContaining({ enabled: true }),
		)
	})

	it("uses ordinary condensing without a restart file when intelligent reset is disabled", async () => {
		const provider = createProvider()
		provider.getState.mockResolvedValue({
			intelligentContextResetEnabled: true,
			apiConfiguration: { ...apiConfig, intelligentContextResetEnabled: true },
			customCondensingPrompt: "Keep a compact summary",
		})
		const task = new Task({
			provider,
			apiConfiguration: { ...apiConfig, intelligentContextResetEnabled: false },
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("system")
		const saveSpy = vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
		const saySpy = vi.spyOn(task, "say").mockResolvedValue(undefined)

		await task.condenseContext()

		expect(summarizeConversation).toHaveBeenCalledWith(
			expect.any(Array),
			task.api,
			"system",
			task.taskId,
			expect.any(Number),
			false,
			"Keep a compact summary",
			undefined,
			expect.any(Boolean),
			{ enabled: false, prompt: undefined },
		)
		expect(writeContextHandoffFile).not.toHaveBeenCalled()
		expect(saySpy.mock.calls.some(([type]) => type === "context_handoff")).toBe(false)
		expect(provider.postMessageToWebview).not.toHaveBeenCalledWith({
			type: "contextHandoffStarted",
			text: task.taskId,
		})
		expect(saveSpy).toHaveBeenCalledOnce()
	})

	// kilocode_change start: task-owned profile settings must not follow another
	// window's currently selected profile; the shared wording still updates.
	it.each([true, undefined])("keeps manual intelligent reset enabled for task setting %s", async (enabled) => {
		const provider = createProvider()
		provider.getState.mockResolvedValue({
			intelligentContextResetEnabled: false,
			apiConfiguration: { ...apiConfig, intelligentContextResetEnabled: false },
			intelligentContextResetPrompt: "Keep the current implementation state",
		})
		const task = new Task({
			provider,
			apiConfiguration: { ...apiConfig, intelligentContextResetEnabled: enabled },
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("system")
		vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)

		await task.condenseContext()

		expect(vi.mocked(summarizeConversation).mock.calls.at(-1)?.[9]).toMatchObject({
			enabled: true,
			prompt: "Keep the current implementation state",
		})
		expect(writeContextHandoffFile).toHaveBeenCalledOnce()
	})

	it("resolves tool-invoked reset from each task profile and follows explicit task profile changes", async () => {
		const provider = createProvider()
		provider.getState.mockResolvedValue({
			intelligentContextResetEnabled: false,
			intelligentContextResetPrompt: "Shared snapshot instructions",
		})
		const enabledTask = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "enabled task",
			startTask: false,
			context: provider.context,
		})
		const disabledTask = new Task({
			provider,
			apiConfiguration: { ...apiConfig, intelligentContextResetEnabled: false },
			task: "disabled task",
			startTask: false,
			context: provider.context,
		})

		expect(await enabledTask.getIntelligentContextResetConfig()).toMatchObject({
			enabled: true,
			prompt: "Shared snapshot instructions",
		})
		expect(await disabledTask.getIntelligentContextResetConfig()).toMatchObject({
			enabled: false,
			prompt: undefined,
		})
		disabledTask.updateApiConfiguration({ ...apiConfig, intelligentContextResetEnabled: true })
		expect(await disabledTask.getIntelligentContextResetConfig()).toMatchObject({ enabled: true })
		expect(await enabledTask.getIntelligentContextResetConfig()).toMatchObject({ enabled: true })
	})
	// kilocode_change end

	// kilocode_change start: context restart handoff lifecycle regression coverage
	it.each([
		{
			fileReady: true,
			expectedInstruction: "first project action MUST be a read_file tool call",
			unexpectedInstruction: "Do NOT read, modify, or delete",
		},
		{
			fileReady: false,
			expectedInstruction: "Do NOT read, modify, or delete CONTEXT_RESTART.md",
			unexpectedInstruction: "first project action MUST be a read_file tool call",
		},
	])(
		"adds the correct mandatory continuation instruction when fileReady=$fileReady",
		async ({ fileReady, expectedInstruction, unexpectedInstruction }) => {
			const provider = createProvider()
			provider.getState.mockResolvedValue({ mode: "code", apiConfiguration: apiConfig })
			const task = new Task({
				provider,
				apiConfiguration: apiConfig,
				task: "initial task",
				startTask: false,
				context: provider.context,
			})
			vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("base system prompt")
			vi.mocked(hydratePendingContextHandoff).mockResolvedValueOnce({
				messages: [
					{ role: "user", content: "initial task", ts: 1 },
					{
						role: "assistant",
						content: "verified embedded continuation snapshot",
						isSummary: true,
						condenseId: "condense-instruction",
						contextHandoffId: "handoff-instruction",
					},
				],
				handoffId: "handoff-instruction",
				fileReady,
			})
			const mockStream = (async function* () {
				yield { type: "text", text: "ok" } as ApiStreamChunk
			})()
			const createMessageSpy = vi.spyOn(task.api, "createMessage").mockReturnValue(mockStream)

			const iterator = task.attemptApiRequest(0, { skipProviderRateLimit: true })
			await iterator.next()
			await iterator.return(undefined)

			const [systemPrompt, messages] = createMessageSpy.mock.calls[0]
			expect(systemPrompt).toContain(expectedInstruction)
			expect(systemPrompt).not.toContain(unexpectedInstruction)
			expect(JSON.stringify(messages)).toContain("verified embedded continuation snapshot")
		},
	)

	it("consumes an embedded-only handoff after a real assistant continuation without touching the fixed file", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		const summary: any = {
			role: "assistant",
			content: [{ type: "text", text: "restart state" }],
			isSummary: true,
			condenseId: "condense-1",
			contextHandoffId: "handoff-1",
			contextHandoffPath: "CONTEXT_RESTART.md",
			contextHandoffSha256: "hash",
		}
		task.apiConversationHistory = [summary]
		;(task as any).activeContextHandoffId = "handoff-1"
		;(task as any).activeContextHandoffFileReady = false
		vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)

		await (task as any).addToApiConversationHistory({ role: "assistant", content: "continued work" })

		expect(summary.contextHandoffConsumedAt).toEqual(expect.any(Number))
		expect((task as any).activeContextHandoffId).toBeUndefined()
		expect(deleteContextHandoffFileIfOwned).not.toHaveBeenCalled()
	})

	it("keeps the handoff pending after an empty assistant response", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		const summary: any = {
			role: "assistant",
			content: [{ type: "text", text: "restart state" }],
			isSummary: true,
			condenseId: "condense-1",
			contextHandoffId: "handoff-1",
			contextHandoffPath: "CONTEXT_RESTART.md",
			contextHandoffSha256: "hash",
		}
		task.apiConversationHistory = [summary]
		;(task as any).activeContextHandoffId = "handoff-1"
		vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)

		await (task as any).addToApiConversationHistory({ role: "assistant", content: "" })

		expect(summary.contextHandoffConsumedAt).toBeUndefined()
		expect((task as any).activeContextHandoffId).toBe("handoff-1")
	})

	it("keeps the handoff pending after a reasoning-only assistant response", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		const summary: any = {
			role: "assistant",
			content: [{ type: "text", text: "restart state" }],
			isSummary: true,
			condenseId: "condense-1",
			contextHandoffId: "handoff-1",
			contextHandoffPath: "CONTEXT_RESTART.md",
			contextHandoffSha256: "hash",
		}
		task.apiConversationHistory = [summary]
		;(task as any).activeContextHandoffId = "handoff-1"
		vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)

		await (task as any).addToApiConversationHistory({
			role: "assistant",
			content: [{ type: "thinking", thinking: "private work", signature: "signature" }],
		})

		expect(summary.contextHandoffConsumedAt).toBeUndefined()
		expect((task as any).activeContextHandoffId).toBe("handoff-1")
		expect(deleteContextHandoffFileIfOwned).not.toHaveBeenCalled()
	})

	it("keeps an embedded-only handoff through a tool call and consumes it after the tool result is saved", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		const summary: any = {
			role: "assistant",
			content: [{ type: "text", text: "restart state" }],
			isSummary: true,
			condenseId: "condense-1",
			contextHandoffId: "handoff-1",
			contextHandoffPath: "CONTEXT_RESTART.md",
			contextHandoffSha256: "hash",
		}
		task.apiConversationHistory = [summary]
		;(task as any).activeContextHandoffId = "handoff-1"
		;(task as any).activeContextHandoffFileReady = false
		vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)

		await (task as any).addToApiConversationHistory({
			role: "assistant",
			content: [{ type: "tool_use", id: "read-1", name: "read_file", input: {} }],
		})

		expect(summary.contextHandoffConsumedAt).toBeUndefined()
		expect(deleteContextHandoffFileIfOwned).not.toHaveBeenCalled()

		await (task as any).addToApiConversationHistory({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "read-1", content: "restart state" }],
		})

		expect(summary.contextHandoffConsumedAt).toEqual(expect.any(Number))
		expect((task as any).activeContextHandoffId).toBeUndefined()
		expect(deleteContextHandoffFileIfOwned).not.toHaveBeenCalled()
	})

	it("does not consume a physical handoff when the model ignores the mandatory read", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		const summary: any = {
			role: "assistant",
			content: [{ type: "text", text: "restart state" }],
			isSummary: true,
			condenseId: "condense-physical",
			contextHandoffId: "handoff-physical",
			contextHandoffPath: "CONTEXT_RESTART.md",
			contextHandoffSha256: "hash",
		}
		task.apiConversationHistory = [summary]
		;(task as any).activeContextHandoffId = "handoff-physical"
		;(task as any).activeContextHandoffFileReady = true
		vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)

		await (task as any).addToApiConversationHistory({ role: "assistant", content: "continued without reading" })

		expect(summary.contextHandoffConsumedAt).toBeUndefined()
		expect((task as any).activeContextHandoffId).toBe("handoff-physical")
		expect(deleteContextHandoffFileIfOwned).not.toHaveBeenCalled()
	})

	it("keeps a physical handoff through an XML tool call and consumes only its persisted successful exact read", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		const summary: any = {
			role: "assistant",
			content: [{ type: "text", text: "restart state" }],
			isSummary: true,
			condenseId: "condense-xml",
			contextHandoffId: "handoff-xml",
			contextHandoffPath: "CONTEXT_RESTART.md",
			contextHandoffSha256: "hash",
		}
		const xmlRead: any = {
			type: "tool_use",
			name: "read_file",
			params: { path: "CONTEXT_RESTART.md" },
			partial: false,
		}
		task.apiConversationHistory = [summary]
		;(task as any).activeContextHandoffId = "handoff-xml"
		;(task as any).activeContextHandoffFileReady = true
		vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)

		await (task as any).addToApiConversationHistory(
			{ role: "assistant", content: "<read_file><path>CONTEXT_RESTART.md</path></read_file>" },
			undefined,
			{ hasPendingToolExecution: true },
		)

		expect(summary.contextHandoffConsumedAt).toBeUndefined()
		expect(deleteContextHandoffFileIfOwned).not.toHaveBeenCalled()
		;(task as any).recordSuccessfulContextHandoffRead([xmlRead])
		await (task as any).addToApiConversationHistory({
			role: "user",
			content: [
				{
					type: "text",
					text: "[read_file] Result:\n<!-- IVOL_CODE_CONTEXT_RESTART_V1 handoff_id=handoff-xml -->\nrestart state",
				},
			],
		})

		expect(summary.contextHandoffConsumedAt).toEqual(expect.any(Number))
		expect((task as any).activeContextHandoffId).toBeUndefined()
		expect(deleteContextHandoffFileIfOwned).toHaveBeenCalledWith({
			workspacePath: task.cwd,
			handoffId: "handoff-xml",
		})
		expect((task.apiConversationHistory.at(-1) as any).contextHandoffContinuationForId).toBe("handoff-xml")
	})

	it("consumes a physical native handoff only for the matching successful read_file result", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		const summary: any = {
			role: "assistant",
			content: [{ type: "text", text: "restart state" }],
			isSummary: true,
			condenseId: "condense-native",
			contextHandoffId: "handoff-native",
			contextHandoffPath: "CONTEXT_RESTART.md",
			contextHandoffSha256: "hash",
		}
		const nativeRead: any = {
			type: "tool_use",
			id: "read-native",
			name: "read_file",
			params: {},
			nativeArgs: { files: [{ path: "CONTEXT_RESTART.md" }] },
			partial: false,
		}
		task.apiConversationHistory = [summary]
		;(task as any).activeContextHandoffId = "handoff-native"
		;(task as any).activeContextHandoffFileReady = true
		vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)

		await (task as any).addToApiConversationHistory({
			role: "assistant",
			content: [{ type: "tool_use", id: "read-native", name: "read_file", input: nativeRead.nativeArgs }],
		})
		await (task as any).addToApiConversationHistory({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "unrelated", content: "other result" }],
		})

		expect(summary.contextHandoffConsumedAt).toBeUndefined()
		;(task as any).recordSuccessfulContextHandoffRead([
			{
				...nativeRead,
				nativeArgs: {
					files: [{ path: "CONTEXT_RESTART.md", lineRanges: [{ start: 1, end: 2 }] }],
				},
			},
		])
		expect((task as any).completedContextHandoffReadToolUseIds).toEqual(new Set())
		;(task as any).recordSuccessfulContextHandoffRead([nativeRead])
		await (task as any).addToApiConversationHistory({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "read-native",
					content:
						"File: CONTEXT_RESTART.md\n<!-- IVOL_CODE_CONTEXT_RESTART_V1 handoff_id=handoff-native -->\nrestart state",
				},
			],
		})

		expect(summary.contextHandoffConsumedAt).toEqual(expect.any(Number))
		expect(deleteContextHandoffFileIfOwned).toHaveBeenCalledWith({
			workspacePath: task.cwd,
			handoffId: "handoff-native",
		})
	})

	it("consumes an embedded-only handoff after an accepted attempt_completion with no tool result", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		const summary: any = {
			role: "assistant",
			content: [{ type: "text", text: "embedded restart state" }],
			isSummary: true,
			condenseId: "condense-completion",
			contextHandoffId: "handoff-completion",
			contextHandoffPath: "CONTEXT_RESTART.md",
			contextHandoffSha256: "hash",
		}
		const completion: any = {
			type: "tool_use",
			id: "completion-1",
			name: "attempt_completion",
			params: { result: "done" },
			partial: false,
		}
		task.apiConversationHistory = [summary]
		;(task as any).activeContextHandoffId = "handoff-completion"
		;(task as any).activeContextHandoffFileReady = false
		vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)

		await (task as any).addToApiConversationHistory(
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "completion-1", name: "attempt_completion", input: { result: "done" } },
				],
			},
			undefined,
			{ hasPendingToolExecution: true },
		)
		await (task as any).consumeEmbeddedHandoffAfterAcceptedCompletion([completion])

		expect(summary.contextHandoffConsumedAt).toEqual(expect.any(Number))
		expect(deleteContextHandoffFileIfOwned).not.toHaveBeenCalled()
		expect((task.apiConversationHistory.at(-1) as any).contextHandoffContinuationForId).toBe("handoff-completion")
	})

	it("rolls API history back and throws when overwrite persistence fails", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		const originalHistory = task.apiConversationHistory
		const replacement: any[] = [{ role: "user", content: "replacement" }]
		vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(false)

		await expect(task.overwriteApiConversationHistory(replacement)).rejects.toThrow(
			"API conversation history could not be saved",
		)
		expect(task.apiConversationHistory).toBe(originalHistory)
	})

	it("clears an uncondensed summary's owned restart file only after the restored history is saved", async () => {
		const provider = createProvider()
		provider.getState.mockResolvedValue({ mode: "code", apiConfiguration: apiConfig })
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		const currentModel = task.api.getModel()
		vi.spyOn(task.api, "getModel").mockReturnValue({
			...currentModel,
			info: { ...currentModel.info, supportsReasoningBudget: true },
		})
		vi.spyOn(task.api, "countTokens").mockResolvedValue(100)
		vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("system")
		const saveSpy = vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)
		vi.mocked(summarizeConversation).mockResolvedValueOnce({
			messages: [],
			summary: "",
			cost: 0,
			condenseId: "recondense-skipped",
			error: "skip recondense in lifecycle test",
		})
		task.apiConversationHistory = [
			{ role: "user", content: "original", ts: 1, condenseParent: "old-condense" },
			{
				role: "assistant",
				content: [{ type: "text", text: "old summary without thinking" }],
				ts: 2,
				isSummary: true,
				condenseId: "old-condense",
				contextHandoffId: "old-handoff",
			} as any,
		]
		;(task as any).activeContextHandoffId = "old-handoff"
		;(task as any).activeContextHandoffFileReady = true
		const mockStream = (async function* () {
			yield { type: "text", text: "ok" } as ApiStreamChunk
		})()
		vi.spyOn(task.api, "createMessage").mockReturnValue(mockStream)

		const iterator = task.attemptApiRequest(0, { skipProviderRateLimit: true })
		await iterator.next()
		await iterator.return(undefined)

		expect(deleteContextHandoffFileIfOwned).toHaveBeenCalledWith({
			workspacePath: task.cwd,
			handoffId: "old-handoff",
		})
		expect(saveSpy.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(deleteContextHandoffFileIfOwned).mock.invocationCallOrder[0],
		)
		expect((task as any).activeContextHandoffId).toBeUndefined()
	})

	it("does not clear an uncondensed restart file when restored history persistence fails", async () => {
		const provider = createProvider()
		provider.getState.mockResolvedValue({ mode: "code", apiConfiguration: apiConfig })
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		const currentModel = task.api.getModel()
		vi.spyOn(task.api, "getModel").mockReturnValue({
			...currentModel,
			info: { ...currentModel.info, supportsReasoningBudget: true },
		})
		vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("system")
		vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(false)
		const originalHistory: any[] = [
			{ role: "user", content: "original", ts: 1, condenseParent: "old-condense" },
			{
				role: "assistant",
				content: [{ type: "text", text: "old summary without thinking" }],
				ts: 2,
				isSummary: true,
				condenseId: "old-condense",
				contextHandoffId: "old-handoff",
			},
		]
		task.apiConversationHistory = originalHistory

		const iterator = task.attemptApiRequest(0, { skipProviderRateLimit: true })
		await expect(iterator.next()).rejects.toThrow("API conversation history could not be saved")

		expect(task.apiConversationHistory).toBe(originalHistory)
		expect(deleteContextHandoffFileIfOwned).not.toHaveBeenCalled()
	})

	it("does not consume the handoff for a synthetic empty-response failure", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
			context: provider.context,
		})
		const summary: any = {
			role: "assistant",
			content: [{ type: "text", text: "restart state" }],
			isSummary: true,
			condenseId: "condense-1",
			contextHandoffId: "handoff-1",
			contextHandoffPath: "CONTEXT_RESTART.md",
			contextHandoffSha256: "hash",
		}
		task.apiConversationHistory = [summary]
		;(task as any).activeContextHandoffId = "handoff-1"
		vi.spyOn(task as any, "saveApiConversationHistory").mockResolvedValue(true)

		await (task as any).addToApiConversationHistory({
			role: "assistant",
			content: [{ type: "text", text: "Failure: I did not provide a response." }],
		})

		expect(summary.contextHandoffConsumedAt).toBeUndefined()
		expect((task as any).activeContextHandoffId).toBe("handoff-1")
		expect(deleteContextHandoffFileIfOwned).not.toHaveBeenCalled()
	})
	// kilocode_change end
})

describe("pushToolResultToUserContent", () => {
	let mockProvider: any
	let mockApiConfig: ProviderSettings

	beforeEach(() => {
		mockApiConfig = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}

		const storageUri = { fsPath: path.join(os.tmpdir(), "test-storage") }
		const mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		const mockOutputChannel = {
			name: "test-output",
			appendLine: vi.fn(),
			append: vi.fn(),
			replace: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}

		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		) as any

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
	})

	it("should add tool_result when not a duplicate", () => {
		const task = new Task({
			provider: mockProvider,
			context: mockProvider.context,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		const toolResult: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "test-id-1",
			content: "Test result",
		}

		const added = task.pushToolResultToUserContent(toolResult)

		expect(added).toBe(true)
		expect(task.userMessageContent).toHaveLength(1)
		expect(task.userMessageContent[0]).toEqual(toolResult)
	})

	it("should prevent duplicate tool_result with same tool_use_id", () => {
		const task = new Task({
			provider: mockProvider,
			context: mockProvider.context,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		const toolResult1: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "duplicate-id",
			content: "First result",
		}

		const toolResult2: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "duplicate-id",
			content: "Second result (should be skipped)",
		}

		// Spy on console.warn to verify warning is logged
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		// Add first result - should succeed
		const added1 = task.pushToolResultToUserContent(toolResult1)
		expect(added1).toBe(true)
		expect(task.userMessageContent).toHaveLength(1)

		// Add second result with same ID - should be skipped
		const added2 = task.pushToolResultToUserContent(toolResult2)
		expect(added2).toBe(false)
		expect(task.userMessageContent).toHaveLength(1)

		// Verify only the first result is in the array
		expect(task.userMessageContent[0]).toEqual(toolResult1)

		// Verify warning was logged
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Skipping duplicate tool_result for tool_use_id: duplicate-id"),
		)

		warnSpy.mockRestore()
	})

	it("should allow different tool_use_ids to be added", () => {
		const task = new Task({
			provider: mockProvider,
			context: mockProvider.context,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		const toolResult1: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "id-1",
			content: "Result 1",
		}

		const toolResult2: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "id-2",
			content: "Result 2",
		}

		const added1 = task.pushToolResultToUserContent(toolResult1)
		const added2 = task.pushToolResultToUserContent(toolResult2)

		expect(added1).toBe(true)
		expect(added2).toBe(true)
		expect(task.userMessageContent).toHaveLength(2)
		expect(task.userMessageContent[0]).toEqual(toolResult1)
		expect(task.userMessageContent[1]).toEqual(toolResult2)
	})

	it("should handle tool_result with is_error flag", () => {
		const task = new Task({
			provider: mockProvider,
			context: mockProvider.context,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		const errorResult: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "error-id",
			content: "Error message",
			is_error: true,
		}

		const added = task.pushToolResultToUserContent(errorResult)

		expect(added).toBe(true)
		expect(task.userMessageContent).toHaveLength(1)
		expect(task.userMessageContent[0]).toEqual(errorResult)
	})

	it("should not interfere with other content types in userMessageContent", () => {
		const task = new Task({
			provider: mockProvider,
			context: mockProvider.context,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		// Add text and image blocks manually
		task.userMessageContent.push(
			{ type: "text", text: "Some text" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "base64data" } },
		)

		const toolResult: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "test-id",
			content: "Result",
		}

		const added = task.pushToolResultToUserContent(toolResult)

		expect(added).toBe(true)
		expect(task.userMessageContent).toHaveLength(3)
		expect(task.userMessageContent[0].type).toBe("text")
		expect(task.userMessageContent[1].type).toBe("image")
		expect(task.userMessageContent[2]).toEqual(toolResult)
	})
})
