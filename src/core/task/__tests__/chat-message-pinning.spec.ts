// kilocode_change - new file
import type { ClineMessage } from "@roo-code/types"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { Task } from "../Task"
import { findChatMessageTarget } from "../../kilocode/context-pinning/chat-message-target"

vi.unmock("p-wait-for")

const text = "This is the final completed answer"
const request: ClineMessage = { type: "say", say: "api_req_started", ts: 10 }
const row: ClineMessage = { type: "say", say: "completion_result", ts: 30, text }
function completion(ts = 20): ApiMessage {
	return {
		role: "assistant",
		ts,
		content: [{ type: "tool_use", id: "complete", name: "attempt_completion", input: { result: text } }],
	}
}
function fixture(history: ApiMessage[] = [completion()], chat: ClineMessage[] = [request, row]) {
	const task = Object.create(Task.prototype) as Task
	Object.assign(task, {
		abort: false,
		apiConversationHistory: history,
		clineMessages: chat,
		overwriteApiConversationHistory: vi.fn(async (messages) => {
			task.apiConversationHistory = messages
		}),
		overwriteClineMessages: vi.fn(async (messages) => {
			task.clineMessages = messages
		}),
	})
	return task
}

describe("chat message freezing", () => {
	it("preserves freezing of the initial user task and repeated feedback", () => {
		const first: ClineMessage = { type: "say", say: "text", ts: 1, text }
		const feedback: ClineMessage = { type: "say", say: "user_feedback", ts: 50, text }
		const repeated: ClineMessage = { ...feedback, ts: 70 }
		const history: ApiMessage[] = [
			{ role: "user", ts: 11, content: `<task>${text}</task>` },
			{ role: "user", ts: 55, content: text },
			{ role: "user", ts: 75, content: text },
		]
		const chat = [first, request, row, feedback, repeated]
		expect(findChatMessageTarget(first, chat, history)?.ts).toBe(11)
		expect(findChatMessageTarget(feedback, chat, history)?.ts).toBe(55)
		expect(findChatMessageTarget(repeated, chat, history)?.ts).toBe(75)
	})
	it("freezes and unfreezes the last completion displayed after its API record was saved", async () => {
		const task = fixture()
		await task.setMessagePinned(row.ts, true, "user")
		expect(task.apiConversationHistory[0].pinned).toBe(true)
		expect(task.clineMessages[1].pinned).toBe(true)
		await task.setMessagePinned(row.ts, false, "user")
		expect(task.apiConversationHistory[0].pinned).toBeUndefined()
		expect(task.clineMessages[1].pinned).toBeUndefined()
	})

	it.each([5, 35])("does not attach a completion to another request at %s", (ts) => {
		const next: ClineMessage = { type: "say", say: "api_req_started", ts: 32 }
		expect(findChatMessageTarget(row, [request, row, next], [completion(ts)])).toBeUndefined()
	})

	it("rejects wrong roles and missing content instead of freezing the next arbitrary message", async () => {
		const task = fixture([
			{ role: "user", ts: 40, content: text },
			{ role: "assistant", ts: 50, content: "Other answer" },
		])
		await expect(task.setMessagePinned(row.ts, true, "user")).rejects.toThrow("cannot be matched")
		expect(task.overwriteApiConversationHistory).not.toHaveBeenCalled()
	})

	it.each([text, `<attempt_completion><result>${text}</result></attempt_completion>`])(
		"supports plain and XML assistant history",
		async (content) => {
			const task = fixture([{ role: "assistant", ts: 20, content }])
			await task.setMessagePinned(row.ts, true, "user")
			expect(task.apiConversationHistory[0].pinned).toBe(true)
		},
	)

	it("updates all visible rows sharing an already-pinned assistant response", async () => {
		const other: ClineMessage = { type: "say", say: "text", ts: 15, text: "The implementation is now ready" }
		const message = completion()
		message.content = [
			{ type: "text", text: other.text! },
			...(message.content as Exclude<ApiMessage["content"], string>),
		]
		message.pinned = true
		const task = fixture([message], [request, other, row])
		await task.setMessagePinned(row.ts, true, "user")
		expect(task.clineMessages.slice(1).every((message) => message.pinned)).toBe(true)
		await task.setMessagePinned(other.ts, false, "user")
		expect(task.clineMessages.slice(1).every((message) => !message.pinned)).toBe(true)
	})

	it("restores hidden completion and its native tool result together", async () => {
		const task = fixture([
			{ ...completion(), condenseParent: "summary" },
			{
				role: "user",
				ts: 40,
				condenseParent: "summary",
				content: [{ type: "tool_result", tool_use_id: "complete", content: "Accepted" }],
			},
		])
		await task.setMessagePinned(row.ts, true, "user")
		expect(task.apiConversationHistory.every((message) => !message.condenseParent)).toBe(true)
		expect(task.clineMessages[1].pinRestored).toBe(true)
	})

	it("waits for the ordinary persistence path without adding synthetic history", async () => {
		const task = fixture([])
		Object.assign(task, { isStreaming: true })
		const pending = task.setMessagePinned(row.ts, true, "user")
		task.apiConversationHistory.push(completion(35))
		await pending
		expect(task.apiConversationHistory).toHaveLength(1)
		expect(task.apiConversationHistory[0].pinned).toBe(true)
	})
})
