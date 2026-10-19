// kilocode_change - new file
import { OrdinaryContextPreparation } from "../kilocode/OrdinaryContextPreparation"
import { Task } from "../Task"
import { summarizeConversation } from "../../condense"

import {
	readOrdinaryPreparation,
	readOrdinaryPreparationDocumentHash,
	saveOrdinaryPreparation,
} from "../kilocode/ordinaryPreparationStorage"
vi.mock("../kilocode/ordinaryPreparationStorage", () => ({
	saveOrdinaryPreparation: vi.fn(),
	readOrdinaryPreparation: vi.fn(),
	readOrdinaryPreparationDocumentHash: vi.fn(),
}))

vi.mock("../../condense", async (original) => ({
	...(await original<typeof import("../../condense")>()),
	summarizeConversation: vi.fn(),
}))

function fixture() {
	const task = Object.create(Task.prototype) as Task
	let written = false
	const events: string[] = []
	const provider = {
		getTaskDocumentSettings: () => ({ supported: true }),
		getState: async () => ({}),
		postMessageToWebview: vi.fn(),
	}
	Object.assign(task, {
		api: {
			contextWindow: 400_000,
			contextManagementMaxOutputTokens: 64_000,
			getModel: () => ({ id: "test", info: { contextWindow: 400_000 } }),
			countTokens: vi.fn(async () => 100),
		},
		apiConfiguration: { intelligentTaskEnabled: true },
		providerRef: new WeakRef(provider),
		workspacePath: "/project",
		taskId: "task",
		apiConversationHistory: [{ role: "user", content: "Original task" }],
		fileContextTracker: {
			observeTaskDocumentWrites: () => ({ wasWritten: () => written, dispose: vi.fn() }),
		},
		saveApiConversationHistory: vi.fn(async () => {
			events.push("save-history")
			return true
		}),
		addToApiConversationHistory: vi.fn(async (message) => {
			task.apiConversationHistory.push(message)
		}),
		notifyTaskDocumentPreparing: vi.fn(),
		getSystemPrompt: vi.fn(async () => "System"),
		getTokenUsage: () => ({ contextTokens: 1000 }),
		say: vi.fn(),
		ask: vi.fn(),
		overwriteApiConversationHistory: vi.fn(async (messages) => {
			events.push("compact")
			task.apiConversationHistory = messages
		}),
	})
	vi.mocked(summarizeConversation).mockImplementation(async (messages) => {
		events.push("summarize")
		return {
			messages: [
				...messages,
				{ role: "assistant", content: "Ordinary summary", isSummary: true, condenseId: "one" },
			],
			summary: "Ordinary summary",
			condenseId: "one",
			cost: 0,
			newContextTokens: 100,
		}
	})
	return {
		task,
		events,
		provider,
		write: () => {
			written = true
		},
		boundary: (completedTurn = true) => {
			const internal = task as unknown as {
				ordinaryContextPreparation?: OrdinaryContextPreparation
				ordinaryPreparationBoundary(): Promise<void>
			}
			if (internal.ordinaryContextPreparation) internal.ordinaryContextPreparation.completedTurn = completedTurn
			return internal.ordinaryPreparationBoundary()
		},
	}
}

describe("ordinary context preparation", () => {
	it.each(["Retry update", "Retry compression"])(
		"applies the saved preparation choice on resume: %s",
		async (answer) => {
			const { task, boundary } = fixture()
			await task.queueOrdinaryContextPreparation("automatic")
			const internal = task as any
			internal.ordinaryContextPreparation.fail("Interrupted")
			internal.ordinaryContextPreparation.documentUpdated = answer === "Retry compression"
			const message = {
				ask: "followup",
				text: JSON.stringify({ contextPreparationDecision: true, suggest: [{ answer }] }),
			}
			expect(await internal.applyRestoredPreparationDecision(message, answer)).toBe(true)
			await boundary(false)
			expect(task.ask).not.toHaveBeenCalled()
			if (answer === "Retry update") expect(task.notifyTaskDocumentPreparing).toHaveBeenCalledOnce()
			if (answer === "Retry compression") expect(summarizeConversation).toHaveBeenCalledOnce()
		},
	)

	it("does not interpret unrelated resume text as a preparation choice", async () => {
		const { task } = fixture()
		await task.queueOrdinaryContextPreparation("automatic")
		const internal = task as any
		internal.ordinaryContextPreparation.fail("Interrupted")
		expect(await internal.applyRestoredPreparationDecision({ ask: "followup", text: "{}" }, "Retry update")).toBe(
			false,
		)
		expect(internal.ordinaryContextPreparation.phase).toBe("waiting")
	})
	it.each(["automatic", "manual", "forced"] as const)(
		"allows %s memory preparation without a second context ceiling",
		async (trigger) => {
			const { task, boundary, write, events } = fixture()
			Object.assign(task, { getTokenUsage: () => ({ contextTokens: 930_804 }) })
			await task.queueOrdinaryContextPreparation(trigger)
			await boundary(false)
			expect(task.notifyTaskDocumentPreparing).toHaveBeenCalledOnce()
			expect(summarizeConversation).not.toHaveBeenCalled()
			expect(task.ask).not.toHaveBeenCalled()
			write()
			await boundary()
			expect(events).toContain("compact")
			expect(JSON.stringify(task.apiConversationHistory.at(-1)?.content)).toContain("reread CURRENT_TASK.md")
		},
	)

	it("starts preparation at the configured condensation threshold", async () => {
		const { task, boundary } = fixture()
		Object.assign(task, { getTokenUsage: () => ({ contextTokens: 360_000 }) })
		await task.queueOrdinaryContextPreparation("automatic")
		await boundary(false)
		expect(task.notifyTaskDocumentPreparing).toHaveBeenCalledOnce()
	})

	it.each(["manual", "forced", "automatic"] as const)("preserves necessary %s intent on restore", async (trigger) => {
		const { task } = fixture()
		Object.assign(task, { getTokenUsage: () => ({ contextTokens: 360_000 }) })
		vi.mocked(readOrdinaryPreparation).mockResolvedValueOnce(trigger)
		await (task as any).restoreOrdinaryContextPreparation()
		expect((task as any).ordinaryContextPreparation.phase).toBe("waiting")
	})

	it("restores pending delegation as a decision, never as a fresh editing turn", async () => {
		const { task } = fixture()
		vi.mocked(readOrdinaryPreparation).mockResolvedValueOnce("manual")
		const internal = task as any
		await internal.restoreOrdinaryContextPreparation()
		expect(internal.ordinaryContextPreparation.phase).toBe("waiting")
		expect(internal.ordinaryContextPreparation.failure).toContain("interrupted")
		const restored = internal.ordinaryContextPreparation
		await internal.restoreOrdinaryContextPreparation()
		expect(internal.ordinaryContextPreparation).toBe(restored)
		expect(readOrdinaryPreparation).toHaveBeenCalledOnce()
		expect(task.notifyTaskDocumentPreparing).not.toHaveBeenCalled()
	})

	it("offers enabling instead of a retry that cannot work, and that choice proceeds", async () => {
		const { task, boundary, write, provider } = fixture()
		await task.queueOrdinaryContextPreparation("automatic")
		const enable = vi.fn(async () => {
			task.apiConfiguration.intelligentTaskEnabled = true
		})
		Object.assign(provider, { enableIntelligentTaskForCurrentProfile: enable })
		Object.assign(task, {
			apiConfiguration: { intelligentTaskEnabled: false },
			ask: vi.fn(async () => ({ text: "Enable Current Task and retry" })),
		})
		await boundary(false)
		const question = vi.mocked(task.ask).mock.calls[0][1] as string
		expect(JSON.parse(question).suggest).toEqual([{ answer: "Enable Current Task and retry" }])
		expect(enable).toHaveBeenCalledOnce()
		expect(task.notifyTaskDocumentPreparing).toHaveBeenCalledOnce()
		write()
		await boundary()
		expect(summarizeConversation).toHaveBeenCalledOnce()
	})

	it("does not bypass compression when the workspace cannot update the file", async () => {
		const { task, boundary, provider } = fixture()
		await task.queueOrdinaryContextPreparation("automatic")
		Object.assign(provider, { getTaskDocumentSettings: () => ({ supported: false }) })
		Object.assign(task, {
			apiConfiguration: { intelligentTaskEnabled: false },
			ask: vi.fn(async () => {
				task.abort = true
				return { text: "" }
			}),
		})
		await expect(boundary(false)).rejects.toThrow("cancelled")
		const suggestions = JSON.parse(vi.mocked(task.ask).mock.calls[0][1] as string).suggest
		expect(suggestions).toEqual([])
		expect(task.ask).toHaveBeenCalledOnce()
		expect(task.notifyTaskDocumentPreparing).not.toHaveBeenCalled()
		expect(summarizeConversation).not.toHaveBeenCalled()
	})

	it("restores an interrupted compression as compression-only while the file is unchanged", async () => {
		const { task } = fixture()
		const internal = task as any
		Object.assign(task, { hashTaskDocument: vi.fn(async () => "abc") })
		vi.mocked(readOrdinaryPreparation).mockResolvedValueOnce("manual")
		vi.mocked(readOrdinaryPreparationDocumentHash).mockResolvedValueOnce("abc")
		await internal.restoreOrdinaryContextPreparation()
		expect(internal.ordinaryContextPreparation.phase).toBe("waiting")
		expect(internal.ordinaryContextPreparation.documentUpdated).toBe(true)
	})

	it("requires a new update after restore when the file changed", async () => {
		const { task } = fixture()
		const internal = task as any
		Object.assign(task, { hashTaskDocument: vi.fn(async () => "changed") })
		vi.mocked(readOrdinaryPreparation).mockResolvedValueOnce("manual")
		vi.mocked(readOrdinaryPreparationDocumentHash).mockResolvedValueOnce("abc")
		await internal.restoreOrdinaryContextPreparation()
		expect(internal.ordinaryContextPreparation.documentUpdated).toBe(false)
	})

	it("persists the verified file hash before compressing", async () => {
		const { task, boundary, write } = fixture()
		Object.assign(task, { hashTaskDocument: vi.fn(async () => "abc") })
		await task.queueOrdinaryContextPreparation("manual")
		await boundary(false)
		write()
		await boundary()
		expect(saveOrdinaryPreparation).toHaveBeenCalledWith(undefined, "task", "manual", "abc")
		expect(vi.mocked(saveOrdinaryPreparation).mock.calls.at(-1)?.[2]).toBeNull()
	})

	it("retries only compression after a verified file update, never the update turn", async () => {
		const { task, boundary, write, events } = fixture()
		await task.queueOrdinaryContextPreparation("manual")
		await boundary(false)
		expect(task.notifyTaskDocumentPreparing).toHaveBeenCalledOnce()
		write()
		vi.mocked(summarizeConversation).mockRejectedValueOnce(new Error("provider failed"))
		const internal = task as any
		Object.assign(task, {
			ask: vi.fn(async () => {
				expect(internal.ordinaryContextPreparation.phase).toBe("waiting")
				expect(internal.ordinaryContextPreparation.documentUpdated).toBe(true)
				expect(task.abort).not.toBe(true)
				return { text: "Retry compression" }
			}),
		})
		await boundary()
		const question = JSON.parse(vi.mocked(task.ask).mock.calls[0][1] as string)
		expect(question.question).toContain("CURRENT_TASK.md was updated")
		expect(question.suggest).toEqual([{ answer: "Retry compression" }])
		expect(task.notifyTaskDocumentPreparing).toHaveBeenCalledOnce()
		expect(events).toContain("compact")
		expect(internal.ordinaryContextPreparation).toBeUndefined()
	})

	it("waits for a fresh decision after each failed compression retry", async () => {
		const { task, boundary, write, events } = fixture()
		await task.queueOrdinaryContextPreparation("automatic")
		await boundary(false)
		write()
		vi.mocked(summarizeConversation)
			.mockRejectedValueOnce(new Error("first failure"))
			.mockRejectedValueOnce(new Error("second failure"))
		vi.mocked(task.ask)
			.mockResolvedValueOnce({ response: "messageResponse", text: "Retry compression" })
			.mockResolvedValueOnce({ response: "messageResponse", text: "Retry compression" })
		await boundary()
		expect(task.ask).toHaveBeenCalledTimes(2)
		expect(summarizeConversation).toHaveBeenCalledTimes(3)
		expect(task.notifyTaskDocumentPreparing).toHaveBeenCalledOnce()
		expect(events).toContain("compact")
		expect(task.abort).not.toBe(true)
		expect((task as any).ordinaryContextPreparation).toBeUndefined()
	})

	it("rejects obsolete skip answers and stays paused until cancellation", async () => {
		const { task, boundary, write, events } = fixture()
		await task.queueOrdinaryContextPreparation("manual")
		await boundary(false)
		write()
		vi.mocked(summarizeConversation).mockRejectedValueOnce(new Error("provider failed"))
		const internal = task as any
		vi.mocked(task.ask)
			.mockResolvedValueOnce({ response: "messageResponse", text: "Continue without compression" })
			.mockImplementationOnce(async () => {
				task.abort = true
				return { response: "messageResponse", text: "" }
			})
		const history = [...task.apiConversationHistory]
		await expect(boundary()).rejects.toThrow("cancelled")
		expect(task.ask).toHaveBeenCalledTimes(2)
		expect(internal.ordinaryContextPreparation.phase).toBe("waiting")
		expect(events).not.toContain("compact")
		expect(task.apiConversationHistory).toEqual(history)
	})

	it("does not offer a compression retry when the file update was never verified", async () => {
		const { task, boundary } = fixture()
		await task.queueOrdinaryContextPreparation("manual")
		const internal = task as any
		internal.ordinaryContextPreparation.fail("Interrupted")
		Object.assign(task, { ask: vi.fn(async () => ({ text: "Retry update" })) })
		await boundary(false)
		const question = JSON.parse(vi.mocked(task.ask).mock.calls[0][1] as string)
		expect(question.suggest).toEqual([{ answer: "Retry update" }])
		expect(question.question).toContain("CURRENT_TASK.md was not updated")
	})

	it("compares normalized prototypes without accepting changed values", () => {
		const config = { headers: Object.assign(Object.create(null), { tier: "standard" }) }
		const preparation = new OrdinaryContextPreparation("manual", config)
		expect(preparation.matchesConfiguration(config)).toBe(true)
		config.headers.tier = "priority"
		expect(preparation.matchesConfiguration(config)).toBe(false)
	})
	beforeEach(() => vi.clearAllMocks())

	it("waits for file-tool evidence and saved results, preserving the ordinary summary", async () => {
		const { task, boundary, events, write } = fixture()
		await task.queueOrdinaryContextPreparation("automatic")
		await boundary()
		expect(summarizeConversation).not.toHaveBeenCalled()
		await boundary()
		expect(summarizeConversation).not.toHaveBeenCalled()
		write()
		task.apiConversationHistory.push({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "write", content: "Saved" }],
		})
		await boundary()
		expect(events.at(-3)).toBe("save-history")
		expect(events.slice(-2)).toEqual(["summarize", "compact"])
		// kilocode_change: the summary is preserved, and an automatic compaction now ends with an
		// explicit instruction to resume, so the model does not read the summary as a final report.
		expect(task.apiConversationHistory.at(-2)?.content).toBe("Ordinary summary")
		const continuation = task.apiConversationHistory.at(-1)
		expect(continuation?.role).toBe("user")
		expect(JSON.stringify(continuation?.content)).toContain("reread CURRENT_TASK.md")
		expect(vi.mocked(summarizeConversation).mock.calls[0][9]).toMatchObject({ signal: expect.any(AbortSignal) })
		expect(task.isContextCondensationInProgress).toBe(false)
	})

	// kilocode_change start: compaction must hand unfinished work back to the model,
	// except when the user asked for the summary themselves.
	it("requests a fresh memory read after user-requested task compaction too", async () => {
		const { task, boundary, write } = fixture()
		await task.queueOrdinaryContextPreparation("manual")
		await boundary()
		write()
		task.apiConversationHistory.push({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "write", content: "Saved" }],
		})
		await boundary()
		expect(task.apiConversationHistory.at(-2)?.content).toBe("Ordinary summary")
		expect(JSON.stringify(task.apiConversationHistory.at(-1)?.content)).toContain("reread CURRENT_TASK.md")
	})

	it("never breaks a tool call pair to insert the continuation instruction", async () => {
		const { task } = fixture()
		// An assistant tool call still awaiting its result must be answered by that result,
		// never by a plain user note, or native tool pairing breaks. The preparation boundary
		// already refuses to compact in this state; this is the second guard at commit time.
		Object.assign(task, {
			apiConversationHistory: [
				{ role: "user", content: "Original task" },
				{ role: "assistant", content: [{ type: "tool_use", id: "pending", name: "read_file", input: {} }] },
			],
			getContextMemoryMode: () => "standard",
		})
		const internal = task as unknown as { canAppendCondenseContinuation(): boolean }
		expect(internal.canAppendCondenseContinuation()).toBe(false)

		task.apiConversationHistory.push({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "pending", content: "Read" }],
		})
		expect(internal.canAppendCondenseContinuation()).toBe(true)
	})
	// kilocode_change end

	it("does not consume turns or accept a write on recursive transport boundaries", async () => {
		const { task, boundary, write } = fixture()
		await task.queueOrdinaryContextPreparation("manual")
		await boundary(false)
		write()
		for (let i = 0; i < 8; i++) await boundary(false)
		expect(summarizeConversation).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
		await boundary(true)
		expect(summarizeConversation).toHaveBeenCalledOnce()
	})

	it("blocks compaction when durable history saving fails even after a write", async () => {
		const { task, boundary, write } = fixture()
		await task.queueOrdinaryContextPreparation("manual")
		await boundary()
		write()
		Object.assign(task, { saveApiConversationHistory: vi.fn(async () => false) })
		await expect(boundary()).rejects.toThrow("Could not save tool results")
		expect(summarizeConversation).not.toHaveBeenCalled()
	})

	it("allows multiple file pages without a four-turn preparation limit", async () => {
		const { task, boundary, write } = fixture()
		await task.queueOrdinaryContextPreparation("manual")
		await boundary()
		for (let i = 0; i < 8; i++) await boundary()
		expect(task.ask).not.toHaveBeenCalled()
		expect(summarizeConversation).not.toHaveBeenCalled()
		write()
		await boundary()
		expect(summarizeConversation).toHaveBeenCalledOnce()
	})

	it("never compacts with an outstanding native tool result", async () => {
		const { task, boundary, write } = fixture()
		await task.queueOrdinaryContextPreparation("manual")
		await boundary()
		write()
		task.apiConversationHistory.push({
			role: "assistant",
			content: [{ type: "tool_use", id: "pending", name: "write_to_file", input: {} }],
		})
		await expect(boundary()).rejects.toThrow("Pending tool results")
		expect(summarizeConversation).not.toHaveBeenCalled()
	})

	it("a retry cannot reuse a previous observation", () => {
		const config = {}
		const observation = { wasWritten: () => true, dispose: vi.fn() }
		const first = new OrdinaryContextPreparation("forced", config)
		first.start(observation)
		first.fail("cancelled")
		const retry = new OrdinaryContextPreparation("forced", config)
		expect(retry.phase).toBe("queued")
		expect(observation.dispose).toHaveBeenCalledOnce()
	})

	it("does not invalidate an explicit continue decision after a profile switch", () => {
		const preparation = new OrdinaryContextPreparation("manual", {})
		preparation.start({ wasWritten: () => false, dispose: vi.fn() })
		preparation.fail("Provider settings changed during context preparation")
		preparation.continueWithoutUpdate()
		preparation.settle({})
		expect(preparation.phase).toBe("ready")
		expect(preparation.continuedWithoutUpdate).toBe(true)
	})

	it("invalidates saved-file readiness if the profile changes before compaction", () => {
		const configuration = {}
		const preparation = new OrdinaryContextPreparation("manual", configuration)
		preparation.start({ wasWritten: () => true, dispose: vi.fn() })
		preparation.settle(configuration)
		expect(preparation.phase).toBe("ready")
		preparation.settle({ apiModelId: "different-model" })
		expect(preparation.phase).toBe("waiting")
		expect(preparation.continuedWithoutUpdate).toBe(false)
	})

	it("rejects a profile switch even when the old model wrote the file", () => {
		const preparation = new OrdinaryContextPreparation("manual", {})
		preparation.start({ wasWritten: () => true, dispose: vi.fn() })
		preparation.settle({ apiModelId: "different-model" })
		expect(preparation.phase).toBe("waiting")
	})

	it("accepts refreshed equivalent settings at real task boundaries", async () => {
		const { task, boundary, write } = fixture()
		await task.queueOrdinaryContextPreparation("manual")
		Object.assign(task, { apiConfiguration: { intelligentTaskEnabled: true } })
		await boundary(false)
		write()
		Object.assign(task, { apiConfiguration: { intelligentTaskEnabled: true } })
		await boundary()
		expect(task.ask).not.toHaveBeenCalled()
		expect(summarizeConversation).toHaveBeenCalledOnce()
	})

	it("detects in-place mutations of nested provider settings", () => {
		const configuration = { headers: { tier: "standard" } }
		const preparation = new OrdinaryContextPreparation("manual", configuration)
		preparation.start({ wasWritten: () => true, dispose: vi.fn() })
		configuration.headers.tier = "priority"
		preparation.settle(configuration)
		expect(preparation.phase).toBe("waiting")
	})

	it.each(["Retry update"])("resolves %s after a real settings change", async (text) => {
		const { task, boundary, write } = fixture()
		await task.queueOrdinaryContextPreparation("manual")
		await boundary(false)
		Object.assign(task, {
			apiConfiguration: { intelligentTaskEnabled: true, apiModelId: "changed" },
			ask: vi.fn(async () => ({ text })),
		})
		await boundary()
		expect(task.ask).toHaveBeenCalledOnce()
		expect(task.ask).toHaveBeenCalledWith(
			"followup",
			expect.stringContaining('"contextPreparationDecision":true'),
			false,
		)
		if (text === "Retry update") {
			expect(summarizeConversation).not.toHaveBeenCalled()
			write()
			await boundary()
		}
		expect(summarizeConversation).toHaveBeenCalledOnce()
	})
})

describe("checkpoint restore", () => {
	it("discards pending preparation so the rewound task does not ask to compress again", async () => {
		const { task } = fixture()
		Object.defineProperty(task, "globalStoragePath", { value: "/storage" })
		const preparation = new OrdinaryContextPreparation("manual", task.apiConfiguration)
		preparation.documentUpdated = true
		;(task as any).ordinaryContextPreparation = preparation
		vi.mocked(saveOrdinaryPreparation).mockClear()
		await task.discardOrdinaryContextPreparation()
		expect((task as any).ordinaryContextPreparation).toBeUndefined()
		expect(saveOrdinaryPreparation).toHaveBeenCalledWith("/storage", "task", null)
	})
})
