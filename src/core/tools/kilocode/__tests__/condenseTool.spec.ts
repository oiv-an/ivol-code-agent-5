import type { Task } from "../../../task/Task"
import type { ToolUse } from "../../../../shared/tools"
import { summarizeConversation } from "../../../condense"
import { condenseTool } from "../condenseTool"

vi.mock("../../../task/Task", () => ({ Task: class {} }))
vi.mock("../../../condense", () => ({ summarizeConversation: vi.fn() }))
vi.mock("../../../prompts/responses", () => ({
	formatResponse: {
		condense: () => "CONDENSATION_COMMITTED",
		toolResult: (text: string) => text,
	},
}))

describe("condenseTool preparation transaction", () => {
	let task: any
	let block: ToolUse
	let controller: AbortController
	let events: string[]
	let handleError: ReturnType<typeof vi.fn>
	let pushToolResult: ReturnType<typeof vi.fn>
	const summarize = vi.mocked(summarizeConversation)

	beforeEach(() => {
		vi.clearAllMocks()
		controller = new AbortController()
		events = []
		block = {
			type: "tool_use",
			name: "condense",
			params: { message: "Please prepare the handoff" },
			partial: false,
		}
		task = {
			taskId: "condense-tool-task",
			api: {},
			apiConversationHistory: [{ role: "user", content: "Continue the task" }],
			consecutiveMistakeCount: 2,
			ask: vi.fn().mockImplementation(async () => {
				events.push("ask")
				return { response: "yesButtonClicked" }
			}),
			getTokenUsage: vi.fn().mockReturnValue({ contextTokens: 150_000 }),
			getIntelligentContextResetConfig: vi.fn().mockResolvedValue({
				enabled: true,
				prompt: "Save precise task handoff",
				useNativeTools: true,
			}),
			getSystemPrompt: vi.fn().mockResolvedValue("System instructions"),
			notifyContextHandoffPreparing: vi.fn().mockResolvedValue(undefined),
			runContextPreparation: vi
				.fn()
				.mockImplementation(async (operation: (signal: AbortSignal) => Promise<void>) => {
					events.push("begin")
					try {
						if (controller.signal.aborted) throw new Error("Context preparation was cancelled")
						return await operation(controller.signal)
					} finally {
						controller.abort()
						events.push("end")
					}
				}),
			commitContextCondensation: vi.fn().mockImplementation(async (result) => {
				if (controller.signal.aborted) throw new Error("Context preparation was cancelled")
				if (result.error) throw new Error(result.error)
				events.push("commit")
			}),
			say: vi.fn().mockImplementation(async (kind: string) => {
				events.push(`say:${kind}`)
			}),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing context"),
			finishContextCondensation: vi.fn().mockImplementation(async () => {
				events.push("finish")
			}),
		}
		summarize.mockReset().mockImplementation(async () => {
			events.push("generate")
			return {
				messages: [],
				summary: "Saved handoff",
				cost: 0.1,
				newContextTokens: 5_000,
				condenseId: "summary-1",
			}
		})
		handleError = vi.fn().mockImplementation(async () => {
			events.push("error")
		})
		pushToolResult = vi.fn().mockImplementation(() => {
			events.push("result")
		})
	})

	async function execute() {
		await condenseTool(task as Task, block, vi.fn(), handleError, pushToolResult, (_tag, content) => content ?? "")
	}

	it("reports success only after preparation, verified commit, and the saved UI result", async () => {
		await execute()
		expect(events).toEqual([
			"ask",
			"begin",
			"generate",
			"commit",
			"say:condense_context",
			"end",
			"result",
			"finish",
		])
		expect(pushToolResult).toHaveBeenCalledExactlyOnceWith("CONDENSATION_COMMITTED")
		expect(handleError).not.toHaveBeenCalled()
		expect(task.consecutiveMistakeCount).toBe(0)
		expect(task.commitContextCondensation).toHaveBeenCalledWith(
			expect.objectContaining({ summary: "Saved handoff", condenseId: "summary-1" }),
			"tool",
			150_000,
			true,
		)
		expect(task.say).toHaveBeenCalledWith(
			"condense_context",
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			{ isNonInteractive: true },
			{
				summary: "Saved handoff",
				cost: 0.1,
				newContextTokens: 5_000,
				prevContextTokens: 150_000,
				condenseId: "summary-1",
			},
		)
	})

	it("passes the preparation's exact AbortSignal and handoff callback to summarization", async () => {
		await execute()
		expect(summarize).toHaveBeenCalledWith(
			task.apiConversationHistory,
			task.api,
			"System instructions",
			task.taskId,
			150_000,
			false,
			undefined,
			undefined,
			true,
			{
				enabled: true,
				signal: controller.signal,
				prompt: "Save precise task handoff",
				onBeforeRequest: task.notifyContextHandoffPreparing,
			},
		)
	})

	it("does not announce success or compression while the commit is pending", async () => {
		let allowCommit!: () => void
		let markCommitStarted!: () => void
		const commitStarted = new Promise<void>((resolve) => {
			markCommitStarted = resolve
		})
		task.commitContextCondensation.mockImplementation(() => {
			markCommitStarted()
			return new Promise<void>((resolve) => {
				allowCommit = resolve
			})
		})
		const pending = execute()
		await commitStarted
		expect(pushToolResult).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		expect(task.finishContextCondensation).not.toHaveBeenCalled()
		allowCommit()
		await pending
		expect(pushToolResult).toHaveBeenCalledExactlyOnceWith("CONDENSATION_COMMITTED")
		expect(task.finishContextCondensation).toHaveBeenCalledOnce()
	})

	it.each(["generation", "structured generation error", "commit", "notification"])(
		"never reports success on a %s failure and always finishes progress",
		async (phase) => {
			const failure = new Error(`${phase} failed`)
			if (phase === "generation") summarize.mockRejectedValue(failure)
			if (phase === "structured generation error") {
				summarize.mockResolvedValue({ messages: [], summary: "", cost: 0, error: failure.message })
			}
			if (phase === "commit") task.commitContextCondensation.mockRejectedValue(failure)
			if (phase === "notification") task.say.mockRejectedValue(failure)
			await execute()
			expect(pushToolResult).not.toHaveBeenCalled()
			expect(handleError).toHaveBeenCalledWith(
				"condensing context window",
				expect.objectContaining({ message: failure.message }),
			)
			expect(task.finishContextCondensation).toHaveBeenCalledOnce()
			expect(events.at(-1)).toBe("finish")
			if (phase === "generation") expect(task.commitContextCondensation).not.toHaveBeenCalled()
		},
	)

	it("cancels an in-flight generation through the supplied signal without committing", async () => {
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		summarize.mockImplementation(async (...args) => {
			const signal = args[9]?.signal
			expect(signal).toBe(controller.signal)
			markStarted()
			return await new Promise<never>((_resolve, reject) => {
				signal!.addEventListener("abort", () => reject(new Error("Context preparation was cancelled")), {
					once: true,
				})
			})
		})
		const pending = execute()
		await started
		controller.abort()
		await pending
		expect(task.commitContextCondensation).not.toHaveBeenCalled()
		expect(pushToolResult).not.toHaveBeenCalled()
		expect(handleError).toHaveBeenCalledWith(
			"condensing context window",
			expect.objectContaining({ message: "Context preparation was cancelled" }),
		)
		expect(task.finishContextCondensation).toHaveBeenCalledOnce()
	})

	it("does not accept a delayed model result after cancellation", async () => {
		summarize.mockImplementation(async () => {
			controller.abort()
			return { messages: [], summary: "Late response", cost: 0, condenseId: "late" }
		})
		await execute()
		expect(pushToolResult).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		expect(handleError).toHaveBeenCalled()
		expect(task.finishContextCondensation).toHaveBeenCalledOnce()
	})

	it("does not start generation for an already cancelled preparation", async () => {
		controller.abort()
		await execute()
		expect(summarize).not.toHaveBeenCalled()
		expect(task.commitContextCondensation).not.toHaveBeenCalled()
		expect(pushToolResult).not.toHaveBeenCalled()
		expect(task.finishContextCondensation).toHaveBeenCalledOnce()
	})

	it("finishes progress even when error reporting itself throws", async () => {
		summarize.mockRejectedValue(new Error("Provider failed"))
		handleError.mockRejectedValue(new Error("Error channel unavailable"))
		await expect(execute()).rejects.toThrow("Error channel unavailable")
		expect(pushToolResult).not.toHaveBeenCalled()
		expect(task.finishContextCondensation).toHaveBeenCalledOnce()
	})

	it("keeps the handoff checkbox disabled without enabling its preflight callback", async () => {
		task.getIntelligentContextResetConfig.mockResolvedValue({ enabled: false, useNativeTools: false })
		await execute()
		expect(summarize.mock.calls[0][9]).toEqual({ enabled: false, signal: controller.signal, prompt: undefined })
		expect(task.commitContextCondensation).toHaveBeenCalledWith(expect.anything(), "tool", 150_000, false)
	})

	it("returns user feedback without performing a context transaction", async () => {
		task.ask.mockResolvedValue({ response: "messageResponse", text: "Keep the unfinished requirement" })
		await execute()
		expect(task.runContextPreparation).not.toHaveBeenCalled()
		expect(summarize).not.toHaveBeenCalled()
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Keep the unfinished requirement"))
		expect(pushToolResult).not.toHaveBeenCalledWith("CONDENSATION_COMMITTED")
		expect(task.finishContextCondensation).toHaveBeenCalledOnce()
	})

	it("handles a missing prompt without preparing context and finishes the request", async () => {
		block.params = {}
		await execute()
		expect(task.consecutiveMistakeCount).toBe(3)
		expect(task.runContextPreparation).not.toHaveBeenCalled()
		expect(pushToolResult).toHaveBeenCalledWith("Missing context")
		expect(task.finishContextCondensation).toHaveBeenCalledOnce()
	})

	it("does not finish an incomplete tool invocation or start generation", async () => {
		block.partial = true
		await execute()
		expect(task.ask).toHaveBeenCalledWith("condense", "Please prepare the handoff", true)
		expect(task.runContextPreparation).not.toHaveBeenCalled()
		expect(pushToolResult).not.toHaveBeenCalled()
		expect(task.finishContextCondensation).not.toHaveBeenCalled()
	})
})
