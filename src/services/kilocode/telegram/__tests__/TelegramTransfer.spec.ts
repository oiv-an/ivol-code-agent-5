import { EventEmitter } from "node:events"
import * as vscode from "vscode"
import { RooCodeEventName } from "@roo-code/types"
import type { Task } from "../../../../core/task/Task"
import type { ClineProvider } from "../../../../core/webview/ClineProvider"
import { TelegramManager } from "../TelegramManager"
import { launchTelegramCoordinator } from "../launchCoordinator"
import { beginTelegramTransfer } from "../../../../core/kilocode/webview/telegramHandler"

vi.mock("../launchCoordinator", () => ({ launchTelegramCoordinator: vi.fn() }))
vi.mock("../../../../i18n", () => ({ t: (key: string) => key }))
vi.mock("../../project-task-storage", () => ({ readProjectTaskStorage: () => undefined }))

function task(id: string, parent?: Task) {
	return Object.assign(new EventEmitter(), {
		taskId: id,
		instanceId: `${id}-instance`,
		parentTask: parent,
		cwd: "/project",
		abort: false,
		clineMessages: [{ ts: 1, type: "say", say: "text", text: "old history" }],
		getRemotePendingAsk: () => undefined,
		respondToRemoteText: vi.fn(() => true),
		respondToRemoteAsk: vi.fn(),
		messageQueueService: { messages: [], isEmpty: () => true, addMessage: vi.fn() },
	}) as unknown as Task
}
async function fixture() {
	let current = task("root")
	const provider = Object.assign(new EventEmitter(), {
		context: {
			subscriptions: [],
			extensionPath: "/extension",
			secrets: { get: async () => JSON.stringify({ token: "123:fixture", ownerId: 123 }) },
		},
		getCurrentTask: () => current,
		postMessageToWebview: vi.fn(async () => true),
		log: vi.fn(),
	})
	let epoch = 0
	const route = {
		key: "root-key",
		clientId: "client",
		taskId: "root",
		chatId: 123,
		ownerId: 123,
		threadId: 7,
		activatedAt: 0,
		minimumUpdateId: 0,
		epoch: "epoch0",
	}
	const client = Object.assign(new EventEmitter(), {
		close: vi.fn(),
		request: vi.fn(async (request: any) => {
			if (["activate", "beginTransfer", "finishTransfer"].includes(request.operation))
				return { ...route, taskId: request.taskId, epoch: `epoch${++epoch}` }
			return null
		}),
	})
	vi.mocked(launchTelegramCoordinator).mockResolvedValue(
		client as unknown as Awaited<ReturnType<typeof launchTelegramCoordinator>>,
	)
	const manager = new TelegramManager(provider as unknown as ClineProvider)
	await manager.activate("root")
	return {
		manager,
		provider,
		client,
		current: () => current,
		set: (next: Task) => {
			current = next
		},
		task,
	}
}
beforeEach(() => {
	vi.clearAllMocks()
	Object.defineProperty(vscode.workspace, "isTrusted", { value: true, configurable: true })
})
afterEach(() => vi.useRealTimers())

it("keeps root topic through child/grandchild/returns despite unfocus and abort before delegation events", async () => {
	vi.useFakeTimers()
	const f = await fixture()
	const root = f.current()
	for (const [id, returning] of [
		["child", false],
		["grandchild", false],
		["child", true],
		["root", true],
	] as const) {
		const old = f.current()
		const transfer = await f.manager.beginTransfer(old, returning ? id : undefined)
		expect(transfer).toBeDefined()
		f.provider.emit(RooCodeEventName.TaskUnfocused, old.taskId)
		old.emit(RooCodeEventName.TaskUnfocused)
		old.abort = true
		f.provider.emit(RooCodeEventName.TaskAborted, old.taskId)
		const next = task(id, returning ? undefined : old)
		f.provider.emit(RooCodeEventName.TaskCreated, next)
		// Constructor starts before addClineToStack; capture must not require current === next yet.
		next.emit(RooCodeEventName.Message, {
			action: "created",
			message: { ts: 10, type: "say", say: "text", text: `new ${id}` },
		})
		f.set(next)
		f.provider.emit(RooCodeEventName.TaskFocused, id)
		await transfer!.finish(next)
		await vi.advanceTimersByTimeAsync(301)
		expect(f.provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({ telegramState: expect.objectContaining({ status: "active", taskId: id }) }),
		)
	}
	const publishes = f.client.request.mock.calls.map(([r]) => r).filter((r) => r.operation === "publish")
	expect(publishes.map((r) => r.text)).toEqual(["new child", "new grandchild", "new child", "new root"])
	expect(new Set(publishes.map((r) => r.messageId)).size).toBe(4)
	expect(f.client.request.mock.calls.filter(([r]) => r.operation === "activate")).toHaveLength(1)
	expect(f.client.close).not.toHaveBeenCalled()
	f.client.emit("input", {
		kind: "message",
		taskId: "root",
		epoch: "epoch1",
		updateId: 100,
		text: "stale",
		images: ["data:image/png;base64,YQ=="],
	})
	expect(f.current().respondToRemoteText).not.toHaveBeenCalled()
	expect(root.respondToRemoteText).not.toHaveBeenCalled()
	f.provider.emit(RooCodeEventName.TaskUnfocused, "root")
	expect(f.client.close).toHaveBeenCalled()
	f.manager.dispose()
})

it.each(["deactivate", "unrelated", "cancel", "timeout"])(
	"does not resurrect on %s during transfer",
	async (action) => {
		vi.useFakeTimers()
		const f = await fixture()
		const old = f.current()
		const transfer = await f.manager.beginTransfer(old)
		const child = task("child", old)
		if (action === "deactivate") await f.manager.deactivate()
		if (action === "unrelated") f.provider.emit(RooCodeEventName.TaskCreated, task("unrelated"))
		if (action === "cancel") transfer!.cancel()
		if (action === "timeout") await vi.advanceTimersByTimeAsync(15_001)
		f.provider.emit(RooCodeEventName.TaskCreated, child)
		f.set(child)
		await transfer!.finish(child)
		expect(f.client.close).toHaveBeenCalled()
		expect(f.client.request.mock.calls.some(([r]) => r.operation === "finishTransfer")).toBe(false)
		expect(f.provider.listenerCount(RooCodeEventName.TaskCreated)).toBe(0)
		f.manager.dispose()
	},
)

it.each(["beginTransfer", "finishTransfer"])(
	"manual deactivation settles a pending %s without resurrection",
	async (operation) => {
		const f = await fixture()
		let resolve!: (value: any) => void
		const pending = new Promise<any>((done) => {
			resolve = done
		})
		const original = f.client.request.getMockImplementation()!
		f.client.request.mockImplementation((request) =>
			request.operation === operation ? pending : original(request),
		)
		const old = f.current()
		const beginning = f.manager.beginTransfer(old)
		let finishing: Promise<void> | undefined
		if (operation === "finishTransfer") {
			const transfer = await beginning
			const child = task("child", old)
			f.provider.emit(RooCodeEventName.TaskCreated, child)
			f.set(child)
			finishing = transfer!.finish(child)
		}
		await vi.waitFor(() => expect(f.client.request.mock.calls.some(([r]) => r.operation === operation)).toBe(true))
		await f.manager.deactivate()
		await beginning
		await finishing
		resolve({
			key: "root-key",
			clientId: "client",
			taskId: "child",
			chatId: 123,
			ownerId: 123,
			threadId: 7,
			activatedAt: 0,
			minimumUpdateId: 0,
			epoch: "late",
		})
		await Promise.resolve()
		expect(f.provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({ telegramState: expect.objectContaining({ status: "inactive" }) }),
		)
		expect(f.provider.listenerCount(RooCodeEventName.TaskCreated)).toBe(0)
		f.manager.dispose()
	},
)

it("does nothing for a provider without a Telegram manager", () => {
	const provider = {} as ClineProvider
	expect(beginTelegramTransfer(provider, task("root"))).toBeUndefined()
	expect(launchTelegramCoordinator).not.toHaveBeenCalled()
})

it("ignores duplicate activation and unrelated off; root off cancels child handoff", async () => {
	const f = await fixture()
	await f.manager.activate("root")
	expect(launchTelegramCoordinator).toHaveBeenCalledTimes(1)
	await f.manager.deactivate("unrelated")
	expect(f.client.close).not.toHaveBeenCalled()
	const transfer = await f.manager.beginTransfer(f.current())
	const child = task("child", f.current())
	f.provider.emit(RooCodeEventName.TaskCreated, child)
	f.set(child)
	expect(f.provider.postMessageToWebview).toHaveBeenLastCalledWith(
		expect.objectContaining({
			telegramState: expect.objectContaining({ status: "connecting", rootTaskId: "root" }),
		}),
	)
	await f.manager.deactivate("root")
	await transfer!.finish(child)
	expect(f.client.close).toHaveBeenCalled()
	expect(f.provider.postMessageToWebview).toHaveBeenLastCalledWith(
		expect.objectContaining({
			telegramState: expect.objectContaining({ status: "inactive" }),
		}),
	)
	f.manager.dispose()
})
