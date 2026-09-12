// kilocode_change - new file
import { freezeMessagesTool, parseMessageNumbers } from "../freezeMessagesTool"
import type { ToolUse } from "../../../../shared/tools"
import type { ApiMessage } from "../../../task-persistence/apiMessages"

vi.mock("../../../prompts/responses", () => ({
	formatResponse: {
		toolResult: (text: string) => text,
		toolError: (text: string) => `ERROR: ${text}`,
	},
}))

const message = (ts: number, seq: number, extra: Partial<ApiMessage> = {}): ApiMessage => ({
	role: "user",
	content: [{ type: "text", text: `message ${seq}` }],
	ts,
	seq,
	...extra,
})

const buildTask = (history: ApiMessage[]) => {
	const pinned = new Set<number>()

	return {
		apiConversationHistory: history,
		consecutiveMistakeCount: 0,
		setMessagePinned: vi.fn(async (ts: number, freeze: boolean) => {
			const target = history.find((item) => item.ts === ts)
			if (!target) return undefined
			if (freeze === Boolean(target.pinned)) return undefined
			target.pinned = freeze || undefined
			if (freeze) {
				pinned.add(ts)
			} else {
				pinned.delete(ts)
			}
			return { ts, restored: false, restoredPartners: [] }
		}),
		say: vi.fn(async () => undefined),
		sayAndCreateMissingParamError: vi.fn(async (_tool: string, param: string) => `missing:${param}`),
	}
}

const run = async (task: any, params: Record<string, string | undefined>, partial = false) => {
	const results: string[] = []
	const block = { name: "freeze_messages", params, partial } as unknown as ToolUse

	await freezeMessagesTool(
		task,
		block,
		vi.fn(async () => true) as any,
		vi.fn(async () => undefined) as any,
		((text: string) => results.push(text)) as any,
		((_tag: string, value?: string) => value ?? "") as any,
	)

	return results.join("\n")
}

describe("parseMessageNumbers", () => {
	it("reads the shapes a model actually writes", () => {
		expect(parseMessageNumbers("42").numbers).toEqual([42])
		expect(parseMessageNumbers("#42").numbers).toEqual([42])
		expect(parseMessageNumbers("[#42]").numbers).toEqual([42])
		expect(parseMessageNumbers("12, 15 18").numbers).toEqual([12, 15, 18])
	})

	it("drops duplicates", () => {
		expect(parseMessageNumbers("7, 7, #7").numbers).toEqual([7])
	})

	it("reports what it could not read", () => {
		const { numbers, invalid } = parseMessageNumbers("12, abc, #15")

		expect(numbers).toEqual([12, 15])
		expect(invalid).toEqual(["abc"])
	})

	it("handles empty input", () => {
		expect(parseMessageNumbers(undefined).numbers).toEqual([])
	})
})

describe("freezeMessagesTool", () => {
	it("freezes the messages the model addressed by number", async () => {
		const history = [message(10, 1), message(20, 2), message(30, 3)]
		const task = buildTask(history)

		const result = await run(task, { messages: "1, 3" })

		expect(history[0].pinned).toBe(true)
		expect(history[2].pinned).toBe(true)
		expect(history[1].pinned).toBeUndefined()
		expect(result).toContain("#1, #3")
		expect(result).toContain("2 messages frozen in total")
	})

	it("unfreezes on request", async () => {
		const history = [message(10, 1, { pinned: true })]
		const task = buildTask(history)

		const result = await run(task, { messages: "#1", action: "unfreeze" })

		expect(history[0].pinned).toBeUndefined()
		expect(result).toContain("Unfroze #1")
		expect(result).toContain("0 messages frozen in total")
	})

	it("reports numbers that match no message instead of failing silently", async () => {
		const history = [message(10, 1)]
		const task = buildTask(history)

		const result = await run(task, { messages: "1, 99" })

		expect(result).toContain("No message found for: #99")
	})

	it("reports messages that were already in the requested state", async () => {
		const history = [message(10, 1, { pinned: true })]
		const task = buildTask(history)

		const result = await run(task, { messages: "1" })

		expect(result).toContain("Already frozen: #1")
	})

	it("refuses an unreadable message list", async () => {
		const task = buildTask([message(10, 1)])

		const result = await run(task, { messages: "the first one" })

		expect(result).toContain("ERROR:")
		expect(task.setMessagePinned).not.toHaveBeenCalled()
		expect(task.consecutiveMistakeCount).toBe(1)
	})

	it("refuses an unknown action", async () => {
		const task = buildTask([message(10, 1)])

		const result = await run(task, { messages: "1", action: "delete" })

		expect(result).toContain("Unknown action")
		expect(task.setMessagePinned).not.toHaveBeenCalled()
	})

	it("asks for the missing parameter", async () => {
		const task = buildTask([message(10, 1)])

		const result = await run(task, {})

		expect(result).toBe("missing:messages")
	})

	it("does nothing while the call is still streaming", async () => {
		const task = buildTask([message(10, 1)])

		await run(task, { messages: "1" }, true)

		expect(task.setMessagePinned).not.toHaveBeenCalled()
	})

	it("refuses to exceed the freeze limit", async () => {
		const history = Array.from({ length: 100 }, (_, index) =>
			message((index + 1) * 10, index + 1, { pinned: true }),
		)
		history.push(message(2000, 101))
		const task = buildTask(history)

		const result = await run(task, { messages: "101" })

		expect(result).toContain("ERROR:")
		expect(result).toContain("limit")
		expect(history[100].pinned).toBeUndefined()
	})

	it("undoes the freeze when it would exceed the token budget", async () => {
		const history = [message(10, 1)]
		const task = {
			...buildTask(history),
			// 900 tokens against a 1000 token window: over the 50% default budget.
			api: {
				contextWindow: 1000,
				getModel: () => ({ info: { contextWindow: 1000 } }),
				countTokens: vi.fn(async () => 900),
			},
			providerRef: { deref: () => ({ getState: async () => ({}) }) },
		}

		const result = await run(task, { messages: "1" })

		expect(result).toContain("above the 500 allowed")
		expect(history[0].pinned).toBeUndefined()
	})

	it("keeps the freeze when it fits the token budget", async () => {
		const history = [message(10, 1)]
		const task = {
			...buildTask(history),
			api: {
				contextWindow: 1000,
				getModel: () => ({ info: { contextWindow: 1000 } }),
				countTokens: vi.fn(async () => 100),
			},
			providerRef: { deref: () => ({ getState: async () => ({}) }) },
		}

		const result = await run(task, { messages: "1" })

		expect(result).toContain("Froze #1")
		expect(history[0].pinned).toBe(true)
	})
})
