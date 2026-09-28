// npx vitest run __tests__/provider-delegation.spec.ts

import { describe, it, expect, vi } from "vitest"
import { RooCodeEventName } from "@roo-code/types"
import { ClineProvider } from "../core/webview/ClineProvider"
import * as telegram from "../core/kilocode/webview/telegramHandler" // kilocode_change

describe("ClineProvider.delegateParentAndOpenChild()", () => {
	// kilocode_change start
	it("begins Telegram transfer before removal and finishes after child creation", async () => {
		const order: string[] = []
		const child = { taskId: "child" }
		const parent = {
			taskId: "parent",
			flushPendingToolResultsToHistory: async () => {
				order.push("flush")
			},
		}
		const cancel = vi.fn()
		const hook = vi.spyOn(telegram, "beginTelegramTransfer").mockImplementation(async () => {
			order.push("begin")
			return {
				finish: async (task) => {
					expect(task).toBe(child)
					order.push("finish")
				},
				cancel,
			}
		})
		const provider = {
			getCurrentTask: () => parent,
			removeClineFromStack: async () => {
				order.push("unfocus-abort")
			},
			handleModeSwitch: async () => {},
			createTask: async () => {
				order.push("create")
				return child
			},
			getTaskWithId: async () => ({ historyItem: { id: "parent" } }),
			updateTaskHistory: async () => {},
			emit: () => {
				order.push("delegated")
			},
			log: vi.fn(),
		} as unknown as ClineProvider
		try {
			await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent",
				message: "child",
				initialTodos: [],
				mode: "code",
			})
			expect(order).toEqual(["flush", "begin", "unfocus-abort", "create", "finish", "delegated"])
			provider.createTask = vi.fn().mockRejectedValue(new Error("creation failed"))
			await expect(
				ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
					parentTaskId: "parent",
					message: "child",
					initialTodos: [],
					mode: "code",
				}),
			).rejects.toThrow("creation failed")
			expect(cancel).toHaveBeenCalledOnce()
		} finally {
			hook.mockRestore()
		}
	})
	// kilocode_change end
	it("persists parent delegation metadata and emits TaskDelegated", async () => {
		const providerEmit = vi.fn()
		const parentTask = { taskId: "parent-1", emit: vi.fn() } as any

		const updateTaskHistory = vi.fn()
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn().mockResolvedValue({ taskId: "child-1" })
		const handleModeSwitch = vi.fn().mockResolvedValue(undefined)
		const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
			if (id === "parent-1") {
				return {
					historyItem: {
						id: "parent-1",
						task: "Parent",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
						childIds: [],
					},
				}
			}
			// child-1
			return {
				historyItem: {
					id: "child-1",
					task: "Do something",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}
		})

		const provider = {
			emit: providerEmit,
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			getTaskWithId,
			updateTaskHistory,
			handleModeSwitch,
			log: vi.fn(),
		} as unknown as ClineProvider

		const params = {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		}

		const child = await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, params)

		expect(child.taskId).toBe("child-1")

		// Invariant: parent closed before child creation
		expect(removeClineFromStack).toHaveBeenCalledTimes(1)
		// Child task is created with initialStatus: "active" to avoid race conditions
		expect(createTask).toHaveBeenCalledWith("Do something", undefined, parentTask, {
			initialTodos: [],
			initialStatus: "active",
		})

		// Metadata persistence - parent gets "delegated" status (child status is set at creation via initialStatus)
		expect(updateTaskHistory).toHaveBeenCalledTimes(1)

		// Parent set to "delegated"
		const parentSaved = updateTaskHistory.mock.calls[0][0]
		expect(parentSaved).toEqual(
			expect.objectContaining({
				id: "parent-1",
				status: "delegated",
				delegatedToId: "child-1",
				awaitingChildId: "child-1",
				childIds: expect.arrayContaining(["child-1"]),
			}),
		)

		// Event emission (provider-level)
		expect(providerEmit).toHaveBeenCalledWith(RooCodeEventName.TaskDelegated, "parent-1", "child-1")

		// Mode switch
		expect(handleModeSwitch).toHaveBeenCalledWith("code")
	})
})
