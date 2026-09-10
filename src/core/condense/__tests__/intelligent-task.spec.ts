// kilocode_change - new file
import type { ApiHandler } from "../../../api"
import type { ApiStreamChunk } from "../../../api/transform/stream"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { INTELLIGENT_TASK_PREPARATION_PROMPT } from "../../task-document/prompts"
import { MAX_TASK_DOCUMENT_BLOCK_BYTES, isTaskDocumentBodyWithinLimit } from "../../task-document/limits"
import { getEffectiveApiHistory, summarizeConversation, type ContextHandoffGenerationOptions } from "../index"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureContextCondensed: vi.fn() } },
}))
vi.mock("../../../api/transform/image-cleaning", () => ({
	maybeRemoveImageBlocks: (messages: ApiMessage[]) => messages,
}))

function setup() {
	const messages: ApiMessage[] = Array.from({ length: 8 }, (_, index) => ({
		role: index % 2 ? "assistant" : "user",
		content:
			index === 7 ? "Latest correction: preserve the second global branch" : `Earlier task evidence ${index}`,
		ts: index + 1,
	}))
	const createMessage = vi.fn(async function* (): AsyncGenerator<ApiStreamChunk> {
		yield {
			type: "text",
			text: "# Global goal\nPreserve both branches.\n# Resume here\nContinue the current stage.",
		}
	})
	const handler = {
		createMessage,
		countTokens: vi.fn().mockResolvedValue(100),
		getModel: () => ({ id: "test-model", info: { contextWindow: 400_000, supportsImages: false } }),
	} as unknown as ApiHandler
	const run = (options: ContextHandoffGenerationOptions) =>
		summarizeConversation(
			messages,
			handler,
			"Original execution instructions",
			"task-one",
			1_000,
			false,
			"CUSTOM OLD CONVERSATION SUMMARY INSTRUCTIONS",
			undefined,
			false,
			options,
		)
	return { messages, handler, createMessage, run }
}

describe("intelligent task preparation request", () => {
	it("sends the persistent-plan prompt and current evidence without temporary handoff cleanup instructions", async () => {
		const { createMessage, run } = setup()
		const onBeforeRequest = vi.fn().mockResolvedValue(undefined)
		const controller = new AbortController()
		const result = await run({
			enabled: true,
			taskDocument: true,
			taskDocumentContext: "Saved task evidence: branch B is outstanding",
			onBeforeRequest,
			signal: controller.signal,
		})
		expect(result.error).toBeUndefined()
		expect(result.condenseId).toBeTruthy()
		expect(onBeforeRequest).toHaveBeenCalledWith(INTELLIGENT_TASK_PREPARATION_PROMPT)
		const request = vi.mocked(createMessage).mock.calls[0] as unknown as Parameters<ApiHandler["createMessage"]>
		expect(request[0]).toContain(INTELLIGENT_TASK_PREPARATION_PROMPT)
		expect(request[0]).toContain("Saved task evidence: branch B is outstanding")
		expect(request[0]).toContain("must NOT be deleted or cleared")
		expect(request[0]).not.toContain("CONTEXT_RESTART.md")
		expect(request[0]).not.toContain("IVOL handoff delivery")
		expect(request[0]).not.toContain("CUSTOM OLD CONVERSATION SUMMARY INSTRUCTIONS")
		expect(JSON.stringify(request[1])).toContain("Latest correction: preserve the second global branch")
		expect(request[2]).toEqual({ taskId: "task-one", signal: controller.signal })
		expect(result.messages.some((message) => message.isSummary && message.condenseId === result.condenseId)).toBe(
			true,
		)
	})

	it("task mode remains a preparation even when a stale legacy enablement flag is false", async () => {
		const { createMessage, run } = setup()
		const onBeforeRequest = vi.fn().mockResolvedValue(undefined)
		await run({ taskDocument: true, enabled: false, onBeforeRequest })
		expect(onBeforeRequest).toHaveBeenCalledOnce()
		const request = createMessage.mock.calls[0] as unknown as Parameters<ApiHandler["createMessage"]>
		expect(request[0]).toContain(INTELLIGENT_TASK_PREPARATION_PROMPT)
	})

	it("retains old custom summary mode when both intelligent modes are off", async () => {
		const { createMessage, run } = setup()
		const onBeforeRequest = vi.fn()
		await run({ enabled: false, taskDocument: false, onBeforeRequest })
		const request = createMessage.mock.calls[0] as unknown as Parameters<ApiHandler["createMessage"]>
		expect(request[0]).toBe("CUSTOM OLD CONVERSATION SUMMARY INSTRUCTIONS")
		expect(onBeforeRequest).not.toHaveBeenCalled()
	})

	it("retains the previous editable temporary handoff prompt when only legacy handoff is enabled", async () => {
		const { createMessage, run } = setup()
		await run({ enabled: true, taskDocument: false, prompt: "MY ORIGINAL HANDOFF TASK" })
		const request = createMessage.mock.calls[0] as unknown as Parameters<ApiHandler["createMessage"]>
		expect(request[0]).toContain("MY ORIGINAL HANDOFF TASK")
		expect(request[0]).toContain("CONTEXT_RESTART.md")
		expect(request[0]).toContain("IVOL handoff delivery")
	})

	it("a failed pre-request callback produces no provider call or changed history", async () => {
		const { createMessage, messages, run } = setup()
		const result = await run({
			enabled: true,
			taskDocument: true,
			onBeforeRequest: async () => {
				throw new Error("Task was stopped")
			},
		})
		expect(result.error).toContain("Task was stopped")
		expect(result.messages).toBe(messages)
		expect(result.condenseId).toBeUndefined()
		expect(createMessage).not.toHaveBeenCalled()
	})

	it("a cancelled stream cannot yield a successful prepared summary", async () => {
		const { createMessage, messages, run } = setup()
		const controller = new AbortController()
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "text", text: "Partial state" }
			controller.abort()
		})
		const result = await run({ taskDocument: true, signal: controller.signal })
		expect(result.error).toContain("cancelled")
		expect(result.messages).toBe(messages)
		expect(result.condenseId).toBeUndefined()
	})
})

describe("bounded CURRENT_TASK preparation recovery", () => {
	const oversizedText = "Rejected oversized draft. " + "x".repeat(MAX_TASK_DOCUMENT_BLOCK_BYTES * 2)
	const validText =
		"# Global goal\nPreserve both requirements.\n# Unfinished branches\n- Branch A: verify.\n- Branch B: implement.\n# Resume here\nVerify branch A."

	it("retries once with the original history and saved evidence, without the rejected draft or thinking", async () => {
		const { messages, createMessage, run } = setup()
		const original = structuredClone(messages)
		const onBeforeRequest = vi.fn()
		const cleanup = vi.fn()
		const afterOversize = vi.fn()
		const controller = new AbortController()
		createMessage.mockImplementationOnce(async function* () {
			try {
				yield { type: "ant_thinking", thinking: "REJECTED PRIVATE THINKING", signature: "rejected-signature" }
				yield { type: "ant_redacted_thinking", data: "rejected-redacted-data" }
				yield { type: "usage", inputTokens: 100, outputTokens: 900, totalCost: 0.1 }
				yield { type: "text", text: oversizedText }
				afterOversize()
			} finally {
				cleanup()
			}
		})
		createMessage.mockImplementationOnce(async function* () {
			expect(cleanup).toHaveBeenCalledOnce()
			yield { type: "text", text: validText }
			yield { type: "usage", inputTokens: 100, outputTokens: 50, totalCost: 0.2 }
		})
		const result = await run({
			taskDocument: true,
			taskDocumentContext: "Saved evidence: both branches remain mandatory",
			onBeforeRequest,
			signal: controller.signal,
		})
		expect(result.error).toBeUndefined()
		expect(result.summary).toBe(validText)
		expect(result.cost).toBeCloseTo(0.3)
		expect(result.newContextTokens).toBe(150)
		expect(createMessage).toHaveBeenCalledTimes(2)
		expect(onBeforeRequest).toHaveBeenCalledOnce()
		expect(afterOversize).not.toHaveBeenCalled()
		expect(messages).toEqual(original)
		const first = createMessage.mock.calls[0] as unknown as Parameters<ApiHandler["createMessage"]>
		const second = createMessage.mock.calls[1] as unknown as Parameters<ApiHandler["createMessage"]>
		expect(second[1]).toBe(first[1])
		expect(second[0]).toContain(first[0])
		expect(second[0]).toContain("48 KiB (49152 UTF-8 bytes)")
		expect(second[0]).toContain("Preserve every user requirement, unfinished branch")
		expect(second[0]).toContain("exact next action")
		expect(second[0]).toContain("Saved evidence: both branches remain mandatory")
		expect(JSON.stringify(second[1])).toContain("Latest correction: preserve the second global branch")
		expect(second[2]).toEqual({ taskId: "task-one", signal: controller.signal })
		for (const rejected of ["Rejected oversized draft", "REJECTED PRIVATE THINKING", "rejected-redacted-data"]) {
			expect(JSON.stringify(second)).not.toContain(rejected)
			expect(JSON.stringify(result.messages)).not.toContain(rejected)
		}
		expect(result.messages.filter((message) => message.isSummary)).toHaveLength(1)
	})

	it("stops after two oversized responses and preserves original messages and reported costs", async () => {
		const { messages, createMessage, run } = setup()
		const original = structuredClone(messages)
		const cleanup = vi.fn()
		createMessage.mockImplementation(async function* () {
			try {
				yield { type: "usage", inputTokens: 100, outputTokens: 900, totalCost: 0.1 }
				yield { type: "usage", inputTokens: 110, outputTokens: 950, totalCost: 0.15 }
				yield { type: "text", text: oversizedText }
			} finally {
				cleanup()
			}
		})
		const result = await run({ taskDocument: true })
		expect(createMessage).toHaveBeenCalledTimes(2)
		expect(cleanup).toHaveBeenCalledTimes(2)
		expect(result.error).toContain("still too large after one automatic retry")
		expect(result.error).toContain("256 KiB")
		expect(result.error).toContain("retaining all requirements and unfinished branches")
		expect(result.summary).toBe("")
		expect(result.messages).toBe(messages)
		expect(messages).toEqual(original)
		expect(result.condenseId).toBeUndefined()
		expect(result.newContextTokens).toBeUndefined()
		expect(result.cost).toBeCloseTo(0.3)
	})

	it("accepts Russian Markdown above the former 24 KiB limit in a single request", async () => {
		const { createMessage, run } = setup()
		const russianText = "# Общая цель\n" + "Сохранить требования и незавершённые ветки задачи.\n".repeat(400)
		expect(Buffer.byteLength(russianText, "utf8")).toBeGreaterThan(24 * 1024)
		expect(isTaskDocumentBodyWithinLimit(russianText, "task-one")).toBe(true)
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "text", text: "  \n" }
			yield { type: "text", text: russianText }
		})
		const result = await run({ taskDocument: true })
		expect(result.error).toBeUndefined()
		expect(result.summary).toBe(russianText.trim())
		expect(createMessage).toHaveBeenCalledOnce()
	})

	it("retries a body that fits raw bytes but exceeds capacity with ownership markers and CRLF", async () => {
		const { createMessage, run } = setup()
		const text = "Дело\n".repeat(27_000)
		expect(Buffer.byteLength(text, "utf8")).toBeLessThan(MAX_TASK_DOCUMENT_BLOCK_BYTES)
		expect(isTaskDocumentBodyWithinLimit(text, "task-one")).toBe(false)
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "text", text }
		})
		const result = await run({ taskDocument: true })
		expect(result.error).toBeUndefined()
		expect(createMessage).toHaveBeenCalledTimes(2)
		expect(result.summary).not.toBe(text.trim())
	})

	it("bounds a stream of small UTF-8 chunks and closes it before receiving its remaining output", async () => {
		const { createMessage, run } = setup()
		const cleanup = vi.fn()
		const afterOversize = vi.fn()
		let yieldedBytes = 0
		createMessage.mockImplementationOnce(async function* () {
			try {
				for (let index = 0; index < 1024; index++) {
					const text = "я".repeat(1024)
					yieldedBytes += Buffer.byteLength(text, "utf8")
					yield { type: "text", text }
				}
				afterOversize()
			} finally {
				cleanup()
			}
		})
		const result = await run({ taskDocument: true })
		expect(result.error).toBeUndefined()
		expect(yieldedBytes).toBe(MAX_TASK_DOCUMENT_BLOCK_BYTES + 2048)
		expect(cleanup).toHaveBeenCalledOnce()
		expect(afterOversize).not.toHaveBeenCalled()
		expect(createMessage).toHaveBeenCalledTimes(2)
	})

	it("does not start the retry when cancelled during cleanup of the oversized first stream", async () => {
		const { messages, createMessage, run } = setup()
		const controller = new AbortController()
		createMessage.mockImplementationOnce(async function* () {
			try {
				yield { type: "text", text: oversizedText }
			} finally {
				controller.abort("private abort reason")
			}
		})
		const result = await run({ taskDocument: true, signal: controller.signal })
		expect(result.error).toBe("Context preparation was cancelled")
		expect(result.messages).toBe(messages)
		expect(result.summary).toBe("")
		expect(result.condenseId).toBeUndefined()
		expect(createMessage).toHaveBeenCalledOnce()
	})

	it("cancels and closes the retry stream without accepting its partial response", async () => {
		const { messages, createMessage, run } = setup()
		const controller = new AbortController()
		const cleanup = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "usage", inputTokens: 100, outputTokens: 900, totalCost: 0.1 }
			yield { type: "text", text: oversizedText }
		})
		createMessage.mockImplementationOnce(async function* () {
			try {
				yield { type: "usage", inputTokens: 100, outputTokens: 50, totalCost: 0.2 }
				yield { type: "text", text: validText }
				controller.abort()
				yield { type: "text", text: "Late provider text" }
			} finally {
				cleanup()
			}
		})
		const result = await run({ taskDocument: true, signal: controller.signal })
		expect(result.error).toContain("cancelled")
		expect(result.messages).toBe(messages)
		expect(result.summary).toBe("")
		expect(result.condenseId).toBeUndefined()
		expect(result.cost).toBeCloseTo(0.3)
		expect(createMessage).toHaveBeenCalledTimes(2)
		expect(cleanup).toHaveBeenCalledOnce()
	})

	it("uses only final-attempt signed thinking and token usage while summing attempt costs", async () => {
		const { handler, createMessage, run } = setup()
		vi.spyOn(handler, "getModel").mockReturnValue({
			id: "thinking-model",
			info: {
				contextWindow: 400_000,
				supportsImages: false,
				supportsPromptCache: false,
				supportsReasoningBudget: true,
				maxTokens: 50_000,
			},
		})
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "ant_thinking", thinking: "rejected thinking", signature: "rejected signature" }
			yield { type: "ant_redacted_thinking", data: "rejected redacted" }
			yield { type: "usage", inputTokens: 100, outputTokens: 900, totalCost: 0.1 }
			yield { type: "text", text: oversizedText }
		})
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "ant_thinking", thinking: "partial final thinking", signature: "partial signature" }
			yield { type: "ant_thinking", thinking: "final thinking", signature: "final signature" }
			yield { type: "ant_redacted_thinking", data: "final redacted" }
			yield { type: "text", text: validText }
			yield { type: "usage", inputTokens: 100, outputTokens: 20, totalCost: 0.1 }
			yield { type: "usage", inputTokens: 110, outputTokens: 50, totalCost: 0.2 }
		})
		const result = await run({ taskDocument: true })
		expect(result.error).toBeUndefined()
		expect(result.messages.find((message) => message.isSummary)?.content).toEqual([
			{ type: "redacted_thinking", data: "final redacted" },
			{ type: "thinking", thinking: "final thinking", signature: "final signature" },
			{ type: "text", text: validText },
		])
		expect(result.cost).toBeCloseTo(0.3)
		expect(result.newContextTokens).toBe(150)
	})

	it("counts the accepted summary when the retry has no usage instead of reusing rejected output tokens", async () => {
		const { handler, createMessage, run } = setup()
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "usage", inputTokens: 100, outputTokens: 900, totalCost: 0.1 }
			yield { type: "text", text: oversizedText }
		})
		const result = await run({ taskDocument: true })
		expect(result.error).toBeUndefined()
		expect(result.newContextTokens).toBe(100)
		expect(result.cost).toBe(0.1)
		expect(vi.mocked(handler.countTokens).mock.calls[0][0]).toContainEqual({ type: "text", text: result.summary })
	})

	it("rejects an empty retry without creating an empty summary or third request", async () => {
		const { messages, createMessage, run } = setup()
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "text", text: oversizedText }
		})
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "text", text: "   \r\n  " }
		})
		const result = await run({ taskDocument: true })
		expect(result.error).toBeTruthy()
		expect(result.messages).toBe(messages)
		expect(result.summary).toBe("")
		expect(result.condenseId).toBeUndefined()
		expect(createMessage).toHaveBeenCalledTimes(2)
	})

	it("does not mistake an empty or malformed first response for a size failure", async () => {
		for (const text of [" \r\n ", "<!-- IVOL_TASK_V1 START task=bad -->", "Invalid\0body"]) {
			const { messages, createMessage, run } = setup()
			createMessage.mockImplementationOnce(async function* () {
				yield { type: "text", text }
			})
			const result = await run({ taskDocument: true })
			expect(result.error).toBeTruthy()
			expect(result.error).not.toContain("too large")
			expect(result.messages).toBe(messages)
			expect(createMessage).toHaveBeenCalledOnce()
		}
	})

	it.each(["signed", "redacted"])(
		"rejects excessive %s thinking without dropping required signed blocks",
		async (kind) => {
			const { messages, createMessage, run } = setup()
			const cleanup = vi.fn()
			createMessage.mockImplementationOnce(async function* () {
				try {
					if (kind === "signed") {
						yield { type: "ant_thinking", thinking: oversizedText, signature: "signature" }
					} else {
						yield { type: "ant_redacted_thinking", data: oversizedText }
					}
					yield { type: "text", text: validText }
				} finally {
					cleanup()
				}
			})
			const result = await run({ taskDocument: true })
			expect(result.error).toContain("reasoning is too large")
			expect(result.messages).toBe(messages)
			expect(result.condenseId).toBeUndefined()
			expect(createMessage).toHaveBeenCalledOnce()
			expect(cleanup).toHaveBeenCalledOnce()
		},
	)

	it.each([{ enabled: true }, { enabled: false }])(
		"keeps legacy large-output behavior unchanged: %j",
		async (options) => {
			const { createMessage, run } = setup()
			createMessage.mockImplementationOnce(async function* () {
				yield { type: "ant_thinking", thinking: oversizedText, signature: "legacy signature" }
				yield { type: "ant_redacted_thinking", data: oversizedText }
				yield { type: "text", text: oversizedText }
			})
			const result = await run(options)
			expect(result.error).toBeUndefined()
			expect(result.summary).toBe(oversizedText)
			expect(result.messages.find((message) => message.isSummary)?.content).toEqual([
				{ type: "redacted_thinking", data: oversizedText },
				{ type: "thinking", thinking: oversizedText, signature: "legacy signature" },
				{ type: "text", text: oversizedText },
			])
			expect(createMessage).toHaveBeenCalledOnce()
		},
	)
})

describe("explicit manual intelligent task compaction before the context fills", () => {
	const first: ApiMessage = { role: "user", content: "Implement both branches; do not deploy.", ts: 1 }
	const answer: ApiMessage = { role: "assistant", content: "Branch A is implemented but not verified.", ts: 2 }
	const correction: ApiMessage = { role: "user", content: "Correction: verify branch A before branch B.", ts: 3 }
	const manualOptions: ContextHandoffGenerationOptions = { taskDocument: true, manualTaskCompaction: true }

	function shortSetup(messages: ApiMessage[]) {
		const { handler, createMessage } = setup()
		const run = (
			options: ContextHandoffGenerationOptions = manualOptions,
			isAutomaticTrigger: boolean | undefined = false,
			prevContextTokens = 1_000,
			useNativeTools = false,
		) =>
			summarizeConversation(
				messages,
				handler,
				"Original execution instructions",
				"task-one",
				prevContextTokens,
				isAutomaticTrigger,
				undefined,
				undefined,
				useNativeTools,
				options,
			)
		return { handler, createMessage, run }
	}

	it("prepares and non-destructively replaces a two-message exchange while retaining the original task", async () => {
		const messages = [first, answer]
		const before = structuredClone(messages)
		const { createMessage, run } = shortSetup(messages)
		const result = await run()
		expect(result.error).toBeUndefined()
		expect(createMessage).toHaveBeenCalledOnce()
		expect(messages).toEqual(before)
		expect(result.messages[0]).toBe(first)
		expect(result.messages[1]).toEqual({ ...answer, condenseParent: result.condenseId })
		const effective = getEffectiveApiHistory(result.messages)
		expect(effective).toHaveLength(2)
		expect(effective[0]).toBe(first)
		expect(effective[1]).toMatchObject({ isSummary: true, condenseId: result.condenseId })
		const request = createMessage.mock.calls[0] as unknown as Parameters<ApiHandler["createMessage"]>
		expect(JSON.stringify(request[1])).toContain(String(first.content))
		expect(JSON.stringify(request[1])).toContain(String(answer.content))
	})

	it("retains the latest correction verbatim in a three-message exchange and sends it as task evidence", async () => {
		const { createMessage, run } = shortSetup([first, answer, correction])
		const result = await run()
		expect(result.error).toBeUndefined()
		const effective = getEffectiveApiHistory(result.messages)
		expect(effective).toHaveLength(3)
		expect(effective[0]).toBe(first)
		expect(effective[1].isSummary).toBe(true)
		expect(effective[2]).toBe(correction)
		const request = createMessage.mock.calls[0] as unknown as Parameters<ApiHandler["createMessage"]>
		expect(JSON.stringify(request[1])).toContain(String(correction.content))
	})

	it("preserves native tool-use/result pairing and the latest correction in a short task", async () => {
		const toolUse = { type: "tool_use" as const, id: "read-1", name: "read_file", input: { path: "src/a.ts" } }
		const toolResult = { type: "tool_result" as const, tool_use_id: "read-1", content: "The file contents" }
		const toolRequest: ApiMessage = { role: "assistant", content: [toolUse], ts: 2 }
		const toolResponse: ApiMessage = {
			role: "user",
			content: [toolResult, { type: "text", text: String(correction.content) }],
			ts: 3,
		}
		const messages = [first, toolRequest, toolResponse]
		const { createMessage, run } = shortSetup(messages)
		const result = await run(manualOptions, false, 1_000, true)
		expect(result.error).toBeUndefined()
		const effective = getEffectiveApiHistory(result.messages)
		expect(effective).toHaveLength(3)
		expect(effective[0]).toBe(first)
		expect(effective[1].content).toEqual(expect.arrayContaining([toolUse]))
		expect(effective[2]).toBe(toolResponse)
		expect(messages[1]).toBe(toolRequest)
		expect(toolRequest.condenseParent).toBeUndefined()
		const request = createMessage.mock.calls[0] as unknown as Parameters<ApiHandler["createMessage"]>
		expect(request[1].slice(0, 3)).toEqual(messages.map(({ role, content }) => ({ role, content })))
	})

	it.each([{ messages: [] }, { messages: [first] }])(
		"rejects an empty or not-yet-started task without a provider request: %j",
		async ({ messages }) => {
			const { createMessage, run } = shortSetup(messages)
			const result = await run()
			expect(result.error).toBeTruthy()
			expect(result.messages).toBe(messages)
			expect(result.condenseId).toBeUndefined()
			expect(createMessage).not.toHaveBeenCalled()
		},
	)

	it("does not summarize an unresolved tool call as if the tool completed", async () => {
		const pending: ApiMessage = {
			role: "assistant",
			content: [{ type: "tool_use", id: "pending", name: "execute_command", input: { command: "test" } }],
			ts: 2,
		}
		const messages = [first, pending]
		const { createMessage, run } = shortSetup(messages)
		const result = await run(manualOptions, false, 1_000, true)
		expect(result.error).toBeTruthy()
		expect(result.messages).toBe(messages)
		expect(createMessage).not.toHaveBeenCalled()
	})

	it.each([{ taskDocument: true }, { taskDocument: false, manualTaskCompaction: true }])(
		"retains the normal minimum message guard without the explicit task-only opt-in: %j",
		async (options) => {
			const { createMessage, run } = shortSetup([first, answer, correction])
			const result = await run(options)
			expect(result.error).toBeTruthy()
			expect(createMessage).not.toHaveBeenCalled()
		},
	)

	it("does not relax automatic compression when a manual flag is accidentally supplied", async () => {
		const { createMessage, run } = shortSetup([first, answer, correction])
		const result = await run(manualOptions, true)
		expect(result.error).toBeTruthy()
		expect(createMessage).not.toHaveBeenCalled()
	})

	it("requires an explicitly manual trigger, not merely an omitted automatic flag", async () => {
		const { handler, createMessage } = shortSetup([first, answer, correction])
		const result = await summarizeConversation(
			[first, answer, correction],
			handler,
			"Original instructions",
			"task-one",
			1_000,
			undefined,
			undefined,
			undefined,
			false,
			manualOptions,
		)
		expect(result.error).toBeTruthy()
		expect(createMessage).not.toHaveBeenCalled()
	})

	it("reports real token counts when an explicit small-context reset does not shrink", async () => {
		const { run } = shortSetup([first, answer])
		const result = await run(manualOptions, false, 50)
		expect(result.error).toBeUndefined()
		expect(result.summary).not.toBe("")
		expect(result.newContextTokens).toBe(100)
		expect(result.condenseId).toBeTruthy()
	})

	it.each([true, false])(
		"retains the shrink requirement for a normal long task (automatic=%s)",
		async (automatic) => {
			const { messages } = setup()
			const { run } = shortSetup(messages)
			const result = await run(automatic ? manualOptions : { taskDocument: true }, automatic, 50)
			expect(result.error).toBeTruthy()
			expect(result.summary).toBe("")
			expect(result.messages).toBe(messages)
		},
	)

	it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
		"rejects an invalid token estimate (%s)",
		async (estimate) => {
			const messages = [first, answer]
			const { handler, run } = shortSetup(messages)
			vi.mocked(handler.countTokens).mockResolvedValueOnce(estimate)
			const result = await run()
			expect(result.error).toContain("invalid token estimate")
			expect(result.messages).toBe(messages)
			expect(result.condenseId).toBeUndefined()
		},
	)

	it("does not commit a short task when the provider returns no task state", async () => {
		const messages = [first, answer]
		const { createMessage, run } = shortSetup(messages)
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "text", text: " \n " }
		})
		const result = await run()
		expect(result.error).toBeTruthy()
		expect(result.messages).toBe(messages)
		expect(result.summary).toBe("")
		expect(result.condenseId).toBeUndefined()
	})

	it("rejects cancellation during a short task's provider stream", async () => {
		const messages = [first, answer]
		const { createMessage, run } = shortSetup(messages)
		const controller = new AbortController()
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "text", text: "Partial current work" }
			controller.abort()
		})
		const result = await run({ ...manualOptions, signal: controller.signal })
		expect(result.error).toContain("cancelled")
		expect(result.messages).toBe(messages)
		expect(result.summary).toBe("")
		expect(result.condenseId).toBeUndefined()
	})
})
