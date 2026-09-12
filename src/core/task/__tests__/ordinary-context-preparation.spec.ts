// kilocode_change - new file
import { OrdinaryContextPreparation } from "../kilocode/OrdinaryContextPreparation"
import { Task } from "../Task"
import { summarizeConversation } from "../../condense"

vi.mock("../kilocode/ordinaryPreparationStorage", () => ({ saveOrdinaryPreparation: vi.fn() }))

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
		api: { contextWindow: 400_000 },
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
		expect(task.apiConversationHistory.at(-1)?.content).toBe("Ordinary summary")
		expect(vi.mocked(summarizeConversation).mock.calls[0][9]).toMatchObject({ signal: expect.any(AbortSignal) })
		expect(task.isContextCondensationInProgress).toBe(false)
	})

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

	it("requires an explicit continue decision when no write is observed", async () => {
		const { task, boundary } = fixture()
		Object.assign(task, { ask: vi.fn(async () => ({ text: "Continue without updating" })) })
		await task.queueOrdinaryContextPreparation("manual")
		await boundary()
		for (let i = 0; i < 4; i++) await boundary()
		expect(task.ask).toHaveBeenCalledOnce()
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
		preparation.settle({})
		expect(preparation.phase).toBe("waiting")
		expect(preparation.continuedWithoutUpdate).toBe(false)
	})

	it("rejects a profile switch even when the old model wrote the file", () => {
		const preparation = new OrdinaryContextPreparation("manual", {})
		preparation.start({ wasWritten: () => true, dispose: vi.fn() })
		preparation.settle({})
		expect(preparation.phase).toBe("waiting")
	})
})
