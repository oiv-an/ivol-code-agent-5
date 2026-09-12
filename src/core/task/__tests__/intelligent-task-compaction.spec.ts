// kilocode_change - new file
import type { ProviderSettings } from "@roo-code/types"
import type { ApiHandler } from "../../../api"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { Task } from "../Task"
import { summarizeConversation, type SummarizeResponse } from "../../condense"
import { resolveTaskDocumentSettings } from "../../task-document/settings"
import { condenseTool } from "../../tools/kilocode/condenseTool"
import { OrdinaryContextPreparation, ORDINARY_TASK_INSTRUCTIONS } from "../kilocode/OrdinaryContextPreparation"
import { saveOrdinaryPreparation } from "../kilocode/ordinaryPreparationStorage"

// Boundary suite only. The companion flow suite uses real tools, loop and storage.
vi.mock("../kilocode/ordinaryPreparationStorage", () => ({ saveOrdinaryPreparation: vi.fn() }))
vi.mock("../../prompts/system", () => ({ SYSTEM_PROMPT: vi.fn().mockResolvedValue("Base project instructions") }))
vi.mock("../../condense", async (original) => ({
	...(await original<typeof import("../../condense")>()),
	summarizeConversation: vi.fn(),
}))

function result(): SummarizeResponse {
	const summary = "# Global goal\nKeep branches A and B.\n\n# Resume here\nFinish branch A, then start B."
	return {
		summary,
		condenseId: "summary-one",
		cost: 0,
		newContextTokens: 100,
		messages: [
			{ role: "user", content: "User's overall requested outcome" },
			{ role: "assistant", content: summary, isSummary: true, condenseId: "summary-one" },
			{ role: "user", content: "Latest correction still applies" },
		],
	}
}

function setup(
	configuration: ProviderSettings = { apiProvider: "openai", intelligentTaskEnabled: true },
	supported = true,
) {
	const task = Object.create(Task.prototype) as Task
	const events: string[] = []
	let written = false
	const provider = {
		context: {},
		getState: vi.fn(async () => ({ mcpEnabled: false, mode: "code", apiConfiguration: task.apiConfiguration })),
		getSkillsManager: vi.fn(),
		getTaskDocumentSettings: (profile: ProviderSettings) =>
			resolveTaskDocumentSettings(profile, {
				appName: "Visual Studio Code",
				workspacePath: supported ? "/test/project" : undefined,
				spawnedAgent: false,
				wrapper: {
					kiloCodeWrapped: false,
					kiloCodeWrapper: null,
					kiloCodeWrapperTitle: null,
					kiloCodeWrapperCode: null,
					kiloCodeWrapperVersion: null,
					kiloCodeWrapperJetbrains: false,
				},
			}),
		postMessageToWebview: vi.fn(),
	}
	const originalHistory: ApiMessage[] = [
		{ role: "user", content: "User's overall requested outcome" },
		{ role: "assistant", content: "Work on branch A" },
		{ role: "user", content: "Latest correction still applies" },
	]
	const todos = [{ id: "stage-one", content: "Current stage action", status: "in_progress" }]
	const overwrite = vi.fn(async (messages: ApiMessage[]) => {
		events.push("history")
		task.apiConversationHistory = messages
	})
	Object.assign(task, {
		taskId: "task-one",
		globalStoragePath: "/boundary-storage",
		workspacePath: "/test/project",
		apiConfiguration: configuration,
		providerRef: new WeakRef(provider),
		abort: false,
		_taskToolProtocol: "native",
		apiConversationHistory: originalHistory,
		clineMessages: [],
		todoList: todos,
		api: {
			getModel: () => ({ id: "test-model", info: { contextWindow: 400_000 } }),
			countTokens: vi.fn(async () => 100),
		} as unknown as ApiHandler,
		getTokenUsage: () => ({ contextTokens: 1_000 }),
		say: vi.fn(),
		ask: vi.fn(),
		fileContextTracker: { observeTaskDocumentWrites: () => ({ wasWritten: () => written, dispose: vi.fn() }) },
		flushPendingToolResultsToHistory: vi.fn(),
		processQueuedMessages: vi.fn(),
		overwriteApiConversationHistory: overwrite,
		saveApiConversationHistory: vi.fn(async () => {
			events.push("durable-results")
			return true
		}),
		addToApiConversationHistory: vi.fn(async (message: ApiMessage) => {
			task.apiConversationHistory.push(message)
		}),
		notifyTaskDocumentPreparing: vi.fn(),
		// Manual startup is tested through the real loop in the companion integration suite.
		recursivelyMakeClineRequests: vi.fn(),
	})
	vi.mocked(summarizeConversation).mockImplementation(async () => {
		events.push("summarize")
		return result()
	})
	const internal = task as unknown as {
		ordinaryContextPreparation?: OrdinaryContextPreparation
		ordinaryPreparationBoundary(): Promise<void>
	}
	const boundary = (completedTurn = false) => {
		if (internal.ordinaryContextPreparation) internal.ordinaryContextPreparation.completedTurn = completedTurn
		return internal.ordinaryPreparationBoundary()
	}
	const ready = async (trigger: "manual" | "automatic" | "forced" | "extended-thinking" | "tool" = "manual") => {
		await task.queueOrdinaryContextPreparation(trigger)
		await boundary()
		written = true
		return boundary(true)
	}
	return {
		task,
		provider,
		events,
		originalHistory,
		todos,
		overwrite,
		boundary,
		ready,
		internal,
		write: () => {
			written = true
		},
	}
}

describe("intelligent task ordinary compaction boundaries", () => {
	beforeEach(() => vi.clearAllMocks())

	it("repeats the standing instruction after an in-place opt-in without reading a managed snapshot", async () => {
		const { task, originalHistory } = setup({ apiProvider: "openai", intelligentTaskEnabled: false })
		expect(await task.getSystemPrompt()).not.toContain(ORDINARY_TASK_INSTRUCTIONS)
		task.apiConfiguration.intelligentTaskEnabled = true
		for (let i = 0; i < 3; i++) expect(await task.getSystemPrompt()).toContain(ORDINARY_TASK_INSTRUCTIONS)
		expect(task.apiConversationHistory).toBe(originalHistory)
		task.apiConfiguration.intelligentTaskEnabled = false
		expect(await task.getSystemPrompt()).not.toContain(ORDINARY_TASK_INSTRUCTIONS)
	})

	it("instructs first-response creation, preservation and recovery before the file exists", async () => {
		const { task } = setup()
		const prompt = await task.getSystemPrompt()
		expect(prompt).toContain("Write it on your first response")
		expect(prompt).toContain("constraints, what is done and verified, what is left")
		expect(prompt).toContain("read it again")
		expect(prompt).not.toContain("CURRENT_WORK.md")
	})

	it.each(["manual", "automatic", "forced", "extended-thinking", "tool"] as const)(
		"%s waits for a completed ordinary write and durable outcomes",
		async (trigger) => {
			const { task, ready, events, todos, overwrite } = setup()
			await ready(trigger)
			expect(events.slice(-3)).toEqual(["durable-results", "summarize", "history"])
			expect(overwrite).toHaveBeenCalledOnce()
			expect(task.apiConversationHistory[1].content).toBe(result().summary)
			expect(task.apiConversationHistory[1].content).toBe(result().summary)
			expect(task.todoList).toBe(todos)
			expect(summarizeConversation).toHaveBeenCalledWith(
				expect.anything(),
				task.api,
				expect.any(String),
				task.taskId,
				1000,
				!["manual", "tool"].includes(trigger),
				undefined,
				undefined,
				true,
				expect.objectContaining({ manualTaskCompaction: trigger === "manual" }),
			)
			expect(saveOrdinaryPreparation).toHaveBeenLastCalledWith("/boundary-storage", "task-one", null)
		},
	)

	it("preserves signed thinking and the actual summary instead of a resume pointer", async () => {
		const { task, ready } = setup()
		const prepared = result()
		const thinking = { type: "thinking" as const, thinking: "opaque provider block", signature: "signature" }
		prepared.messages[1].content = [thinking, { type: "text", text: prepared.summary }]
		vi.mocked(summarizeConversation).mockResolvedValueOnce(prepared)
		await ready()
		expect(task.apiConversationHistory[1].content).toEqual([thinking, { type: "text", text: prepared.summary }])
	})

	it("manual startup queues preparation without summarizing or managing a snapshot", async () => {
		const { task, overwrite } = setup()
		await task.condenseContext("task")
		expect(task.recursivelyMakeClineRequests).toHaveBeenCalledOnce()
		expect(summarizeConversation).not.toHaveBeenCalled()
		expect(overwrite).not.toHaveBeenCalled()
	})

	it("the condense tool queues the ordinary turn instead of committing inside a pending tool call", async () => {
		const { task, overwrite } = setup()
		Object.assign(task, { ask: vi.fn(async () => ({ response: "yesButtonClicked" })) })
		const error = vi.fn(),
			push = vi.fn()
		await condenseTool(
			task,
			{ type: "tool_use", name: "condense", params: { message: "Please compact" }, partial: false },
			vi.fn(),
			error,
			push,
			(_name, content) => content ?? "",
		)
		expect(error).not.toHaveBeenCalled()
		expect(push).toHaveBeenCalledOnce()
		expect(overwrite).not.toHaveBeenCalled()
		expect(summarizeConversation).not.toHaveBeenCalled()
		expect(saveOrdinaryPreparation).toHaveBeenCalledWith("/boundary-storage", "task-one", "tool")
	})

	it.each(["unreadable", "concurrent-edit"])(
		"does not treat an external %s file outcome as tool-write authorization",
		async () => {
			const { task, boundary, overwrite, todos } = setup()
			await task.queueOrdinaryContextPreparation("manual")
			await boundary()
			for (let i = 0; i < 3; i++) await boundary(true)
			expect(overwrite).not.toHaveBeenCalled()
			expect(summarizeConversation).not.toHaveBeenCalled()
			expect(task.todoList).toBe(todos)
		},
	)

	it("cannot summarize with outstanding native tool results even if a file was saved", async () => {
		const { task, boundary, write, overwrite } = setup()
		await task.queueOrdinaryContextPreparation("manual")
		await boundary()
		write()
		task.apiConversationHistory.push({
			role: "assistant",
			content: [{ type: "tool_use", id: "pending", name: "edit_file", input: {} }],
		})
		await expect(boundary(true)).rejects.toThrow("Pending tool results")
		expect(overwrite).not.toHaveBeenCalled()
		expect(summarizeConversation).not.toHaveBeenCalled()
	})

	it("write success cannot bypass failure to persist tool results", async () => {
		const { task, boundary, write, overwrite, todos } = setup()
		await task.queueOrdinaryContextPreparation("manual")
		await boundary()
		write()
		Object.assign(task, { saveApiConversationHistory: vi.fn(async () => false) })
		await expect(boundary(true)).rejects.toThrow("Could not save tool results")
		expect(overwrite).not.toHaveBeenCalled()
		expect(summarizeConversation).not.toHaveBeenCalled()
		expect(task.todoList).toBe(todos)
	})

	it.each(["opt-out", "replacement"])("rejects captured preparation after provider %s", async (change) => {
		const { task, ready, overwrite } = setup()
		vi.mocked(summarizeConversation).mockImplementationOnce(async () => {
			if (change === "opt-out") task.apiConfiguration.intelligentTaskEnabled = false
			else task.apiConfiguration = { ...task.apiConfiguration }
			return result()
		})
		await expect(ready()).rejects.toThrow(
			change === "opt-out" ? "Context memory mode changed" : "Provider settings changed",
		)
		expect(task.apiConversationHistory.some((message) => message.isSummary)).toBe(false)
		expect(overwrite).not.toHaveBeenCalled()
	})

	it.each(["before-turn", "after-write", "during-summary"])(
		"cancellation %s preserves uncompressed history",
		async (when) => {
			const { task, boundary, write, overwrite } = setup()
			await task.queueOrdinaryContextPreparation("manual")
			if (when !== "before-turn") {
				await boundary()
				write()
			}
			if (when === "during-summary")
				vi.mocked(summarizeConversation).mockImplementationOnce(async () => {
					task.abort = true
					return result()
				})
			else task.abort = true
			await expect(boundary(true)).rejects.toThrow(/cancelled/i)
			expect(overwrite).not.toHaveBeenCalled()
			expect(task.apiConversationHistory.some((m) => m.isSummary)).toBe(false)
		},
	)

	it("does not consume recursive transport boundaries as completed turns", async () => {
		const { task, boundary, write } = setup()
		await task.queueOrdinaryContextPreparation("automatic")
		await boundary()
		write()
		for (let i = 0; i < 8; i++) await boundary()
		expect(summarizeConversation).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
		await boundary(true)
		expect(summarizeConversation).toHaveBeenCalledOnce()
	})

	it.each(["would not free space", "does not fit"])(
		"preserves history when ordinary summarization rejects context: %s",
		async (error) => {
			const { task, ready, overwrite } = setup()
			vi.mocked(summarizeConversation).mockResolvedValueOnce({ ...result(), error })
			await expect(ready(error === "does not fit" ? "manual" : "automatic")).rejects.toThrow(error)
			expect(overwrite).not.toHaveBeenCalled()
			expect(task.apiConversationHistory.some((m) => m.isSummary)).toBe(false)
		},
	)

	it.each(["empty", "wrong-id", "not-summary"])(
		"rejects invalid summary message %s before replacing history",
		async (kind) => {
			const { task, ready, overwrite } = setup()
			const invalid = result()
			if (kind === "empty") invalid.messages = []
			if (kind === "wrong-id") invalid.messages[1].condenseId = "another-summary"
			if (kind === "not-summary") invalid.messages[1].isSummary = false
			vi.mocked(summarizeConversation).mockResolvedValueOnce(invalid)
			await expect(ready()).rejects.toThrow()
			expect(overwrite).not.toHaveBeenCalled()
			expect(task.apiConversationHistory.some((m) => m.isSummary)).toBe(false)
		},
	)

	it("never silently condenses normally when the manual button explicitly requested the file", async () => {
		const { task, overwrite } = setup({ apiProvider: "openai", intelligentTaskEnabled: false })
		await task.condenseContext("task")
		expect(summarizeConversation).not.toHaveBeenCalled()
		expect(overwrite).not.toHaveBeenCalled()
		expect(task.say).toHaveBeenCalledWith("condense_context_error", expect.stringContaining("mode changed"))
	})

	it.each([false, true])("ordinary mode keeps no-file behavior (unsupported=%s)", async (unsupported) => {
		const { task, overwrite } = setup({ apiProvider: "openai", intelligentTaskEnabled: unsupported }, !unsupported)
		await task.condenseContext()
		expect(overwrite).toHaveBeenCalledOnce()
		expect(vi.mocked(summarizeConversation).mock.calls[0][9]).toMatchObject({ signal: expect.any(AbortSignal) })
	})
})
