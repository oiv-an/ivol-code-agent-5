// kilocode_change - new file
import type { ApiHandler } from "../../../api"
import type { ApiStreamChunk } from "../../../api/transform/stream"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { getEffectiveApiHistory, summarizeConversation, type ContextPreparationOptions } from "../index"

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
	const run = (options: ContextPreparationOptions) =>
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

describe("ordinary summary streaming", () => {
	it("honors the custom summary and sends only the ordinary summary slice", async () => {
		const { messages, createMessage, run } = setup()
		const controller = new AbortController()
		const result = await run({ signal: controller.signal })
		expect(result.error).toBeUndefined()
		const request = createMessage.mock.calls[0] as unknown as Parameters<ApiHandler["createMessage"]>
		expect(request[0]).toBe("CUSTOM OLD CONVERSATION SUMMARY INSTRUCTIONS")
		expect(request[1]).toEqual(messages.slice(0, -3).map(({ role, content }) => ({ role, content })))
		expect(request[2]).toEqual({ taskId: "task-one", signal: controller.signal })
		expect(result.messages.filter((message) => message.isSummary)).toHaveLength(1)
	})

	it("accepts large UTF-8 summaries and opaque signed blocks without managed limits or retries", async () => {
		const { messages, createMessage, run } = setup()
		const original = structuredClone(messages)
		const text = "Summary 🚀\n".repeat(30_000)
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "ant_thinking", thinking: text, signature: "original signature" }
			yield { type: "ant_redacted_thinking", data: text }
			yield { type: "text", text }
		})
		const result = await run({})
		expect(result.error).toBeUndefined()
		expect(result.summary).toBe(text.trim())
		expect(result.messages.find((message) => message.isSummary)?.content).toEqual([
			{ type: "redacted_thinking", data: text },
			{ type: "thinking", thinking: text, signature: "original signature" },
			{ type: "text", text: text.trim() },
		])
		expect(createMessage).toHaveBeenCalledOnce()
		expect(messages).toEqual(original)
	})

	it("keeps the final complete thinking signature and latest usage, not partial chunks", async () => {
		const { createMessage, run } = setup()
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "ant_thinking", thinking: "partial", signature: "partial signature" }
			yield { type: "ant_thinking", thinking: "final", signature: "final signature" }
			yield { type: "ant_thinking", thinking: "unsigned", signature: "" }
			yield { type: "ant_redacted_thinking", data: "opaque" }
			yield { type: "text", text: "Summary" }
			yield { type: "usage", inputTokens: 100, outputTokens: 20, totalCost: 0.1 }
			yield { type: "usage", inputTokens: 110, outputTokens: 50, totalCost: 0.2 }
		})
		const result = await run({})
		expect(result.error).toBeUndefined()
		expect(result.cost).toBe(0.2)
		expect(result.newContextTokens).toBe(150)
		expect(result.messages.find((message) => message.isSummary)?.content).toEqual([
			{ type: "redacted_thinking", data: "opaque" },
			{ type: "thinking", thinking: "final", signature: "final signature" },
			{ type: "text", text: "Summary" },
		])
	})

	it("counts the summary itself when the provider reports no usage", async () => {
		const { handler, run } = setup()
		const result = await run({})
		expect(result.error).toBeUndefined()
		expect(result.newContextTokens).toBe(100)
		expect(vi.mocked(handler.countTokens).mock.calls[0][0]).toContainEqual({ type: "text", text: result.summary })
	})

	it("closes a cancelled stream, preserves usage and never retries or accepts late text", async () => {
		const { messages, createMessage, run } = setup()
		const controller = new AbortController()
		const cleanup = vi.fn()
		const afterLateChunk = vi.fn()
		createMessage.mockImplementationOnce(async function* () {
			try {
				yield { type: "usage", inputTokens: 100, outputTokens: 20, totalCost: 0.1 }
				yield { type: "text", text: "Partial" }
				controller.abort("private reason")
				yield { type: "text", text: "Late" }
				afterLateChunk()
			} finally {
				cleanup()
			}
		})
		const result = await run({ signal: controller.signal })
		expect(result.error).toBe("Context preparation was cancelled")
		expect(result.messages).toBe(messages)
		expect(result.summary).toBe("")
		expect(result.condenseId).toBeUndefined()
		expect(result.cost).toBe(0.1)
		expect(cleanup).toHaveBeenCalledOnce()
		expect(afterLateChunk).not.toHaveBeenCalled()
		expect(createMessage).toHaveBeenCalledOnce()
	})

	it("preserves history and reported cost on provider failure without retry", async () => {
		const { messages, createMessage, run } = setup()
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "usage", inputTokens: 100, outputTokens: 20, totalCost: 0.1 }
			throw new Error("provider offline")
		})
		const result = await run({})
		expect(result.error).toContain("provider offline")
		expect(result.messages).toBe(messages)
		expect(result.summary).toBe("")
		expect(result.cost).toBe(0.1)
		expect(createMessage).toHaveBeenCalledOnce()
	})
})

describe("explicit manual intelligent task compaction before the context fills", () => {
	const first: ApiMessage = { role: "user", content: "Implement both branches; do not deploy.", ts: 1 }
	const answer: ApiMessage = { role: "assistant", content: "Branch A is implemented but not verified.", ts: 2 }
	const correction: ApiMessage = { role: "user", content: "Correction: verify branch A before branch B.", ts: 3 }
	const manualOptions: ContextPreparationOptions = { manualTaskCompaction: true }

	function shortSetup(messages: ApiMessage[]) {
		const { handler, createMessage } = setup()
		const run = (
			options: ContextPreparationOptions = manualOptions,
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

	it("retains the latest correction verbatim in a three-message exchange outside the summary slice", async () => {
		const { createMessage, run } = shortSetup([first, answer, correction])
		const result = await run()
		expect(result.error).toBeUndefined()
		const effective = getEffectiveApiHistory(result.messages)
		expect(effective).toHaveLength(3)
		expect(effective[0]).toBe(first)
		expect(effective[1].isSummary).toBe(true)
		expect(effective[2]).toBe(correction)
		const request = createMessage.mock.calls[0] as unknown as Parameters<ApiHandler["createMessage"]>
		expect(JSON.stringify(request[1])).not.toContain(String(correction.content))
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

	it.each([{}, { manualTaskCompaction: false }])(
		"retains the normal minimum message guard without the explicit manual opt-in: %j",
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
			const result = await run(automatic ? manualOptions : {}, automatic, 50)
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
