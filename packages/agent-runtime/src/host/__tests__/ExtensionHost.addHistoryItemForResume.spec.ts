// kilocode_change - new file
import { afterEach, describe, expect, it, vi } from "vitest"
import { ExtensionHost } from "../ExtensionHost.js"

describe("ExtensionHost.addHistoryItemForResume", () => {
	let host: ExtensionHost | undefined

	const createHost = () =>
		new ExtensionHost({
			workspacePath: "/workspace/project",
			extensionBundlePath: "/tmp/extension.js",
			extensionRootPath: "/tmp",
		})

	afterEach(() => {
		vi.restoreAllMocks()
		if (host) {
			;(host as unknown as { removeGlobalErrorHandlers: () => void }).removeGlobalErrorHandlers()
			host = undefined
		}
	})

	it("merges resume bootstrap fields without dropping lineage metadata", async () => {
		host = createHost()

		const existingHistoryItem = {
			id: "task-123",
			number: 7,
			ts: 1700000000000,
			task: "Existing task title",
			tokensIn: 120,
			tokensOut: 340,
			totalCost: 0.42,
			size: 2048,
			mode: "architect",
			workspace: "/existing/workspace",
			mentionCount: 9,
			isFavorited: true,
			rootTaskId: "root-1",
			parentTaskId: "parent-1",
			childIds: ["child-1"],
			status: "delegated",
			delegatedToId: "child-1",
			awaitingChildId: "child-1",
			completedByChildId: "child-1",
			completionResultSummary: "done",
			cacheWrites: 3,
			cacheReads: 4,
		}

		const taskHistory = [existingHistoryItem]
		const updateMock = vi.fn().mockResolvedValue(undefined)
		const getMock = vi.fn().mockReturnValue(taskHistory)

		;(host as unknown as { vscodeAPI: unknown }).vscodeAPI = {
			context: {
				globalState: {
					get: getMock,
					update: updateMock,
				},
			},
		}

		await host.addHistoryItemForResume("task-123", "Resume title", 1711111111111, "code")

		expect(updateMock).toHaveBeenCalledTimes(1)
		const updatedHistory = updateMock.mock.calls[0][1] as Array<Record<string, unknown>>
		const mergedItem = updatedHistory[0]

		expect(mergedItem.id).toBe("task-123")
		expect(mergedItem.number).toBe(7)
		expect(mergedItem.ts).toBe(1700000000000)
		expect(mergedItem.task).toBe("Existing task title")
		expect(mergedItem.tokensIn).toBe(120)
		expect(mergedItem.tokensOut).toBe(340)
		expect(mergedItem.totalCost).toBe(0.42)
		expect(mergedItem.size).toBe(2048)
		expect(mergedItem.mode).toBe("architect")
		expect(mergedItem.workspace).toBe("/existing/workspace")
		expect(mergedItem.mentionCount).toBe(9)
		expect(mergedItem.isFavorited).toBe(true)

		expect(mergedItem.rootTaskId).toBe("root-1")
		expect(mergedItem.parentTaskId).toBe("parent-1")
		expect(mergedItem.childIds).toEqual(["child-1"])
		expect(mergedItem.status).toBe("delegated")
		expect(mergedItem.delegatedToId).toBe("child-1")
		expect(mergedItem.awaitingChildId).toBe("child-1")
		expect(mergedItem.completedByChildId).toBe("child-1")
		expect(mergedItem.completionResultSummary).toBe("done")
		expect(mergedItem.cacheWrites).toBe(3)
		expect(mergedItem.cacheReads).toBe(4)
	})

	it("forwards two incremental messages created in the same millisecond", () => {
		host = createHost()
		;(host as unknown as { vscodeAPI: unknown }).vscodeAPI = { context: {} }
		;(
			host as unknown as {
				setupExtensionMessageListener: () => void
			}
		).setupExtensionMessageListener()

		vi.spyOn(Date, "now").mockReturnValue(1700000000000)
		const forwarded: unknown[] = []
		host.on("message", (message) => forwarded.push(message))

		host.emit("extensionWebviewMessage", {
			type: "messageCreated",
			taskId: "task-123",
			clineMessage: { ts: 1, type: "say", say: "text", text: "first" },
		})
		host.emit("extensionWebviewMessage", {
			type: "messageCreated",
			taskId: "task-123",
			clineMessage: { ts: 2, type: "say", say: "text", text: "second" },
		})

		expect(forwarded).toHaveLength(2)
		expect(forwarded).toEqual([
			expect.objectContaining({ type: "messageCreated", chatMessage: expect.objectContaining({ ts: 1 }) }),
			expect.objectContaining({ type: "messageCreated", chatMessage: expect.objectContaining({ ts: 2 }) }),
		])
	})

	it("keeps getState synchronized with task-aware incremental updates", () => {
		host = createHost()
		;(host as unknown as { vscodeAPI: unknown }).vscodeAPI = { context: {} }
		;(host as unknown as { currentState: unknown }).currentState = {
			version: "1.0.0",
			apiConfiguration: { apiProvider: "openai" },
			chatMessages: [],
			currentTaskId: "task-123",
			mode: "code",
			customModes: [],
			taskHistoryFullLength: 0,
			taskHistoryVersion: 0,
			telemetrySetting: "disabled",
			renderContext: "cli",
		}
		;(
			host as unknown as {
				setupExtensionMessageListener: () => void
			}
		).setupExtensionMessageListener()

		host.emit("extensionWebviewMessage", {
			type: "messageCreated",
			taskId: "task-123",
			clineMessage: { ts: 1, type: "say", say: "text", text: "draft" },
		})
		host.emit("extensionWebviewMessage", {
			type: "messageUpdated",
			taskId: "task-123",
			clineMessage: { ts: 1, type: "say", say: "text", text: "final" },
		})
		host.emit("extensionWebviewMessage", {
			type: "currentTaskStateUpdated",
			taskId: "task-123",
			taskState: {
				currentTaskTodos: [{ id: "todo-1", content: "Finish", status: "pending" }],
				currentTaskCumulativeCost: 1.25,
				messageQueue: [{ id: "queued-1", text: "next", timestamp: 2 }],
			},
		})
		host.emit("extensionWebviewMessage", {
			type: "messageCreated",
			taskId: "different-task",
			clineMessage: { ts: 2, type: "say", say: "text", text: "wrong task" },
		})

		const state = host.getAPI().getState()
		expect(state?.chatMessages).toEqual([{ ts: 1, type: "say", say: "text", text: "final" }])
		expect(state?.currentTaskTodos).toEqual([{ id: "todo-1", content: "Finish", status: "pending" }])
		expect(state?.currentTaskCumulativeCost).toBe(1.25)
		expect(state?.messageQueue).toEqual([{ id: "queued-1", text: "next", timestamp: 2 }])
	})
})
