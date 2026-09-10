// kilocode_change - new file
import type { ProviderSettings, TodoItem } from "@roo-code/types"
import type { ApiHandler } from "../../../api"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { Task } from "../Task"
import { summarizeConversation, type SummarizeResponse } from "../../condense"
import { manageContext, type ContextManagementOptions } from "../../context-management"
import { writeContextHandoffFile, preflightContextHandoff } from "../../context-management/context-handoff"
import { readTaskDocument, saveTaskDocument, type TaskDocumentSnapshot } from "../../task-document/document"
import { resolveTaskDocumentSettings, type TaskDocumentSettingsEnvironment } from "../../task-document/settings"
import { condenseTool } from "../../tools/kilocode/condenseTool"
import { CURRENT_TASK_RESUME_MESSAGE, INTELLIGENT_TASK_INSTRUCTIONS } from "../../task-document/prompts"

vi.mock("../../task-document/document", () => ({
	DEFAULT_TASK_DOCUMENT_FILE: "CURRENT_TASK.md",
	readTaskDocument: vi.fn(),
	saveTaskDocument: vi.fn(),
}))
vi.mock("../../prompts/system", () => ({ SYSTEM_PROMPT: vi.fn().mockResolvedValue("Base project instructions") }))
vi.mock("../../condense", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../condense")>()),
	summarizeConversation: vi.fn(),
}))
vi.mock("../../context-management", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../context-management")>()),
	manageContext: vi.fn(),
}))
vi.mock("../../context-management/context-handoff", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../context-management/context-handoff")>()),
	writeContextHandoffFile: vi.fn(),
	preflightContextHandoff: vi.fn(),
}))

const environment: TaskDocumentSettingsEnvironment = {
	appName: "Visual Studio Code",
	workspacePath: "/test/project",
	spawnedAgent: false,
	wrapper: {
		kiloCodeWrapped: false,
		kiloCodeWrapper: null,
		kiloCodeWrapperTitle: null,
		kiloCodeWrapperCode: null,
		kiloCodeWrapperVersion: null,
		kiloCodeWrapperJetbrains: false,
	},
}

function result(): SummarizeResponse {
	return {
		summary: "# Global goal\nKeep branches A and B.\n\n# Resume here\nFinish branch A, then start B.",
		condenseId: "summary-one",
		cost: 0,
		newContextTokens: 100,
		messages: [
			{ role: "user", content: "User's overall requested outcome" },
			{ role: "assistant", content: "Prepared state", isSummary: true, condenseId: "summary-one" },
			{ role: "user", content: "Latest correction still applies" },
		],
	}
}

function setup(
	configuration: ProviderSettings = { apiProvider: "openai", intelligentTaskEnabled: true },
	supported = true,
) {
	const events: string[] = []
	let saved: TaskDocumentSnapshot = {
		revision: "before",
		body: "# Global plan\nBranch A is active; preserve branch B.",
		promptText: "Existing current work: branch B is still outstanding.",
		exists: true,
	}
	const task = Object.create(Task.prototype) as Task
	const provider = {
		context: {},
		getState: vi.fn(async () => ({ mcpEnabled: false, mode: "code", apiConfiguration: task.apiConfiguration })),
		getSkillsManager: vi.fn(),
		getTaskDocumentSettings: vi.fn((profile: ProviderSettings) =>
			resolveTaskDocumentSettings(
				profile,
				supported ? environment : { ...environment, workspacePath: undefined },
			),
		),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
	}
	const countTokens = vi.fn().mockResolvedValue(100)
	const api = {
		getModel: vi.fn(() => ({ id: "test-model", info: { contextWindow: 400_000, supportsImages: false } })),
		countTokens,
		createMessage: vi.fn(() => {
			throw new Error("Unexpected real model request")
		}),
	} as unknown as ApiHandler
	const originalHistory: ApiMessage[] = [
		{ role: "user", content: "User's overall requested outcome" },
		{ role: "assistant", content: "Work on branch A" },
		{ role: "user", content: "Latest correction still applies" },
	]
	const todos: TodoItem[] = [{ id: "stage-one", content: "Current stage action", status: "in_progress" }]
	const overwrite = vi.fn(async (messages: ApiMessage[]) => {
		events.push("history")
		task.apiConversationHistory = messages
	})
	const say = vi.fn(async (kind: string) => {
		events.push(`say:${kind}`)
	})
	Object.assign(task, {
		taskId: "task-one",
		workspacePath: "/test/project",
		apiConfiguration: configuration,
		providerRef: { deref: () => provider },
		api,
		abort: false,
		_taskToolProtocol: "xml",
		apiConversationHistory: originalHistory,
		todoList: todos,
		getTokenUsage: vi.fn(() => ({ contextTokens: 1_000 })),
		say,
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(undefined),
		processQueuedMessages: vi.fn(),
		overwriteApiConversationHistory: overwrite,
		saveApiConversationHistory: vi.fn().mockResolvedValue(true),
		// This constructor-owned UI callback is not the storage/transaction boundary under test.
		notifyContextHandoffPreparing: vi.fn().mockResolvedValue(undefined),
	})
	vi.mocked(readTaskDocument).mockImplementation(async () => {
		events.push("read-current")
		return saved
	})
	vi.mocked(saveTaskDocument).mockImplementation(async ({ body, assertCurrent }) => {
		assertCurrent?.()
		events.push("save-current")
		saved = { revision: "after", body, promptText: body, exists: true }
		return saved
	})
	vi.mocked(summarizeConversation).mockImplementation(async (...args) => {
		events.push("generate")
		await args[9]?.onBeforeRequest?.("Update CURRENT_TASK.md")
		return result()
	})
	vi.mocked(manageContext).mockImplementation(async () => ({ ...result(), prevContextTokens: 1_000 }))
	vi.mocked(writeContextHandoffFile).mockResolvedValue({
		handoffId: "old-handoff",
		relativePath: "CONTEXT_RESTART.md",
		absolutePath: "/test/project/CONTEXT_RESTART.md",
		body: "Old handoff body",
		content: "Old handoff document",
		sha256: "old-sha256",
		createdAt: 1,
	})
	const options: ContextManagementOptions = {
		messages: originalHistory,
		totalTokens: 1_000,
		contextWindow: 1_000,
		apiHandler: api,
		autoCondenseContext: true,
		autoCondenseContextPercent: 90,
		systemPrompt: "Base instructions",
		taskId: "task-one",
		profileThresholds: {},
		currentProfileId: "profile-one",
		requireContextHandoff: true,
	}
	return { task, provider, events, countTokens, originalHistory, todos, overwrite, say, options }
}

function automatic(task: Task, options: ContextManagementOptions) {
	return (
		task as unknown as {
			prepareManagedContext: (options: ContextManagementOptions, trigger: "automatic") => Promise<unknown>
		}
	).prepareManagedContext(options, "automatic")
}

describe("intelligent task compaction integration", () => {
	beforeEach(() => vi.clearAllMocks())

	it("adds the standing instruction to an existing conversation when enabled and repeats it on every request", async () => {
		const { task, originalHistory } = setup({ apiProvider: "openai", intelligentTaskEnabled: false })
		expect(await task.getSystemPrompt()).not.toContain(INTELLIGENT_TASK_INSTRUCTIONS)
		task.apiConfiguration = { ...task.apiConfiguration, intelligentTaskEnabled: true }
		vi.mocked(readTaskDocument).mockResolvedValue({ exists: false, revision: null, promptText: "" })
		for (let request = 0; request < 3; request++) {
			const prompt = await task.getSystemPrompt()
			expect(prompt).toContain(INTELLIGENT_TASK_INSTRUCTIONS)
			expect(prompt).toContain("CURRENT_TASK.md is missing")
			expect(prompt).toContain("available conversation")
		}
		expect(readTaskDocument).toHaveBeenCalledTimes(3)
		expect(task.apiConversationHistory).toBe(originalHistory)
		expect(saveTaskDocument).not.toHaveBeenCalled()
		task.apiConfiguration = { ...task.apiConfiguration, intelligentTaskEnabled: false }
		expect(await task.getSystemPrompt()).not.toContain(INTELLIGENT_TASK_INSTRUCTIONS)
	})

	it("includes creation and global-block instructions in the first system prompt even before the file exists", async () => {
		const { task } = setup()
		vi.mocked(readTaskDocument).mockResolvedValueOnce({ exists: false, revision: null, promptText: "" })
		const prompt = await task.getSystemPrompt()
		expect(prompt).toContain("On the FIRST response")
		expect(prompt).toContain("stable identifier (A, B, C...)")
		expect(prompt).toContain("CURRENT_TASK.md")
		expect(prompt).not.toContain("CURRENT_WORK.md")
		expect(saveTaskDocument).not.toHaveBeenCalled()
	})

	it.each(["unreadable", "concurrent-edit"])(
		"preserves history if the saved plan cannot be restored: %s",
		async (failure) => {
			const { task, originalHistory, overwrite } = setup()
			const save = vi.mocked(saveTaskDocument).getMockImplementation()!
			vi.mocked(saveTaskDocument).mockImplementationOnce(async (options) => {
				const saved = await save(options)
				if (failure === "unreadable") {
					vi.mocked(readTaskDocument).mockRejectedValueOnce(new Error("EACCES"))
				} else {
					vi.mocked(readTaskDocument).mockResolvedValueOnce({ ...saved, revision: "external-change" })
				}
				return saved
			})
			await task.condenseContext()
			expect(saveTaskDocument).toHaveBeenCalledOnce()
			expect(overwrite).not.toHaveBeenCalled()
			expect(task.apiConversationHistory).toBe(originalHistory)
		},
	)

	it("keeps non-text blocks intact when replacing the duplicate plan with a resume pointer", async () => {
		const { task } = setup()
		const prepared = result()
		const thinking = { type: "thinking" as const, thinking: "opaque provider block", signature: "signature" }
		prepared.messages[1].content = [thinking, { type: "text", text: prepared.summary }]
		vi.mocked(summarizeConversation).mockResolvedValueOnce(prepared)
		await task.condenseContext()
		expect(task.apiConversationHistory[1].content).toEqual([
			thinking,
			{ type: "text", text: CURRENT_TASK_RESUME_MESSAGE },
		])
	})

	it("manual compaction saves CURRENT_TASK before changing history, then refreshes the actual system prompt", async () => {
		const { task, events, todos, overwrite } = setup()
		const before = await task.getSystemPrompt()
		expect(before).toContain("branch B is still outstanding")
		await task.condenseContext()
		expect(overwrite).toHaveBeenCalledOnce()
		expect(events.indexOf("save-current")).toBeLessThan(events.indexOf("history"))
		const after = await task.getSystemPrompt()
		expect(after).toContain("Finish branch A, then start B")
		const compacted = task.apiConversationHistory.find((message) => message.condenseId === "summary-one")
		expect(compacted?.content).toBe(CURRENT_TASK_RESUME_MESSAGE)
		expect(compacted?.content).not.toContain(result().summary)
		expect(events.lastIndexOf("read-current")).toBeGreaterThan(events.indexOf("save-current"))
		expect(after).not.toContain("branch B is still outstanding")
		expect(task.todoList).toBe(todos)
		expect(writeContextHandoffFile).not.toHaveBeenCalled()
		expect(preflightContextHandoff).not.toHaveBeenCalled()
		expect(vi.mocked(summarizeConversation).mock.calls[0][9]).toMatchObject({
			taskDocument: true,
			enabled: true,
			taskDocumentContext: expect.stringContaining("Current-stage checklist (not the global plan)"),
		})
	})

	it("automatic compaction routes preparation evidence and saves before history", async () => {
		const { task, events, options, overwrite, todos } = setup()
		await automatic(task, options)
		expect(manageContext).toHaveBeenCalledWith(
			expect.objectContaining({ taskDocument: true, taskDocumentContext: expect.stringContaining("branch B") }),
		)
		expect(overwrite).toHaveBeenCalledOnce()
		expect(events.indexOf("save-current")).toBeLessThan(events.indexOf("history"))
		expect(task.todoList).toBe(todos)
		expect(writeContextHandoffFile).not.toHaveBeenCalled()
	})

	it("captured task mode overrides stale automatic fallback options before context management", async () => {
		const { task, options, events, overwrite } = setup()
		await automatic(task, { ...options, requireContextHandoff: false })
		expect(manageContext).toHaveBeenCalledWith(
			expect.objectContaining({
				taskDocument: true,
				requireContextHandoff: true,
				contextHandoffPrompt: expect.stringContaining("CURRENT_TASK.md"),
				onBeforeContextHandoff: task.notifyContextHandoffPreparing,
			}),
		)
		expect(overwrite).toHaveBeenCalledOnce()
		expect(events.indexOf("save-current")).toBeLessThan(events.indexOf("history"))
	})

	it("the model-invoked condense tool uses the same verified persistent-file transaction", async () => {
		const { task, events, overwrite } = setup()
		const handleError = vi.fn()
		const pushToolResult = vi.fn()
		await condenseTool(
			task,
			{ type: "tool_use", name: "condense", params: { message: "Please compact" }, partial: false },
			vi.fn(),
			handleError,
			pushToolResult,
			(_name, content) => content ?? "",
		)
		expect(handleError).not.toHaveBeenCalled()
		expect(pushToolResult).toHaveBeenCalledOnce()
		expect(overwrite).toHaveBeenCalledOnce()
		expect(events.indexOf("save-current")).toBeLessThan(events.indexOf("history"))
		expect(vi.mocked(summarizeConversation).mock.calls[0][9]).toMatchObject({ taskDocument: true })
		expect(writeContextHandoffFile).not.toHaveBeenCalled()
	})

	it("write failure during manual compaction leaves history and current-stage TODO unchanged", async () => {
		const { task, originalHistory, todos, overwrite, say } = setup()
		vi.mocked(saveTaskDocument).mockRejectedValueOnce(new Error("disk full"))
		await task.condenseContext()
		expect(task.apiConversationHistory).toBe(originalHistory)
		expect(task.todoList).toBe(todos)
		expect(overwrite).not.toHaveBeenCalled()
		expect(say).toHaveBeenCalledWith(
			"condense_context_error",
			expect.stringContaining("disk full"),
			undefined,
			false,
			undefined,
			undefined,
			{ isNonInteractive: true },
		)
	})

	it("an in-place opt-out cannot bypass a captured task preparation by falling back to legacy handoff", async () => {
		const { task, originalHistory, overwrite } = setup()
		await task.runContextPreparation(async () => {
			task.apiConfiguration.intelligentTaskEnabled = false
			await expect(task.commitContextCondensation(result(), "manual", 1_000)).rejects.toThrow()
		})
		expect(task.apiConversationHistory).toBe(originalHistory)
		expect(saveTaskDocument).not.toHaveBeenCalled()
		expect(writeContextHandoffFile).not.toHaveBeenCalled()
		expect(overwrite).not.toHaveBeenCalled()
	})

	it("a provider replacement during generation rejects the captured preparation without saving or changing history", async () => {
		const { task, originalHistory, overwrite } = setup()
		await task.runContextPreparation(async () => {
			task.apiConfiguration = { ...task.apiConfiguration }
			await expect(task.commitContextCondensation(result(), "manual", 1_000)).rejects.toThrow(
				"Provider settings changed",
			)
		})
		expect(task.apiConversationHistory).toBe(originalHistory)
		expect(saveTaskDocument).not.toHaveBeenCalled()
		expect(overwrite).not.toHaveBeenCalled()
	})

	it.each(["before-save", "inside-save", "after-save"])("cancellation %s preserves history", async (when) => {
		const { task, originalHistory, overwrite } = setup()
		await task.runContextPreparation(async () => {
			if (when === "before-save") task.abort = true
			else if (when === "inside-save")
				vi.mocked(saveTaskDocument).mockImplementationOnce(async ({ assertCurrent }) => {
					task.abort = true
					assertCurrent?.()
					throw new Error("Unreachable commit")
				})
			else
				vi.mocked(saveTaskDocument).mockImplementationOnce(async ({ body, assertCurrent }) => {
					assertCurrent?.()
					task.abort = true
					return { revision: "saved-before-stop", body, promptText: body, exists: true }
				})
			await expect(task.commitContextCondensation(result(), "manual", 1_000)).rejects.toThrow("cancelled")
		})
		expect(task.apiConversationHistory).toBe(originalHistory)
		expect(overwrite).not.toHaveBeenCalled()
	})

	it("automatic compaction still requires shrinking the complete prompt", async () => {
		const { task, originalHistory, overwrite, countTokens } = setup()
		countTokens.mockResolvedValue(2_000)
		await task.runContextPreparation(async () => {
			await expect(task.commitContextCondensation(result(), "automatic", 1_000)).rejects.toThrow(
				"would not free space",
			)
		})
		expect(saveTaskDocument).toHaveBeenCalledOnce()
		expect(task.apiConversationHistory).toBe(originalHistory)
		expect(overwrite).not.toHaveBeenCalled()
	})

	it("manual task reset works below the threshold even if the durable note is larger than the short history", async () => {
		const { task, overwrite, countTokens } = setup()
		countTokens.mockResolvedValue(2_000)
		await task.condenseContext("task")
		expect(overwrite).toHaveBeenCalledOnce()
		expect(saveTaskDocument).toHaveBeenCalledOnce()
		expect(writeContextHandoffFile).not.toHaveBeenCalled()
		expect(vi.mocked(summarizeConversation).mock.calls[0][9]).toMatchObject({
			taskDocument: true,
			manualTaskCompaction: true,
		})
	})

	it("manual task reset still refuses context that exceeds the actual model window", async () => {
		const { task, overwrite, countTokens, say } = setup()
		countTokens.mockResolvedValue(400_000)
		await task.condenseContext("task")
		expect(saveTaskDocument).toHaveBeenCalledOnce()
		expect(overwrite).not.toHaveBeenCalled()
		expect(say).toHaveBeenCalledWith(
			"condense_context_error",
			expect.stringContaining("does not fit"),
			undefined,
			false,
			undefined,
			undefined,
			{ isNonInteractive: true },
		)
	})

	it("never silently runs legacy handoff when the manual button explicitly requested task mode", async () => {
		const { task, overwrite, say } = setup({ apiProvider: "openai", intelligentTaskEnabled: false })
		await task.condenseContext("task")
		expect(summarizeConversation).not.toHaveBeenCalled()
		expect(writeContextHandoffFile).not.toHaveBeenCalled()
		expect(saveTaskDocument).not.toHaveBeenCalled()
		expect(overwrite).not.toHaveBeenCalled()
		expect(say).toHaveBeenCalledWith("condense_context_error", expect.stringContaining("mode changed"))
	})

	it.each(["empty", "wrong-id", "not-summary"])(
		"rejects invalid summary message %s before replacing history",
		async (kind) => {
			const { task, originalHistory, overwrite } = setup()
			const invalid = result()
			if (kind === "empty") invalid.messages = []
			if (kind === "wrong-id") invalid.messages[1].condenseId = "another-summary"
			if (kind === "not-summary") invalid.messages[1].isSummary = false
			await expect(
				task.runContextPreparation(() => task.commitContextCondensation(invalid, "manual", 1_000)),
			).rejects.toThrow()
			expect(task.apiConversationHistory).toBe(originalHistory)
			expect(overwrite).not.toHaveBeenCalled()
			expect(saveTaskDocument).not.toHaveBeenCalled()
		},
	)

	it("standard mode preserves the old no-file behavior", async () => {
		const { task, overwrite } = setup({
			apiProvider: "openai",
			intelligentTaskEnabled: false,
			intelligentContextResetEnabled: false,
		})
		await task.condenseContext()
		expect(overwrite).toHaveBeenCalledOnce()
		expect(readTaskDocument).not.toHaveBeenCalled()
		expect(saveTaskDocument).not.toHaveBeenCalled()
		expect(writeContextHandoffFile).not.toHaveBeenCalled()
		expect(vi.mocked(summarizeConversation).mock.calls[0][9]).toMatchObject({ enabled: false, taskDocument: false })
	})

	it.each([false, true])(
		"legacy handoff remains available when task mode is unavailable (unsupported=%s)",
		async (unsupported) => {
			const { task } = setup({ apiProvider: "openai", intelligentTaskEnabled: unsupported }, !unsupported)
			await task.condenseContext()
			expect(readTaskDocument).not.toHaveBeenCalled()
			expect(saveTaskDocument).not.toHaveBeenCalled()
			expect(writeContextHandoffFile).toHaveBeenCalledOnce()
			expect(vi.mocked(summarizeConversation).mock.calls[0][9]).toMatchObject({
				enabled: true,
				taskDocument: false,
			})
		},
	)
})
