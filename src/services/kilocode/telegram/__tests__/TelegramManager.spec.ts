import { EventEmitter } from "node:events"
import * as vscode from "vscode"
import { TelegramManager } from "../TelegramManager"
import { launchTelegramCoordinator } from "../launchCoordinator"
import {
	TelegramStartupError,
	telegramStartupReason,
	isTelegramStartupReason,
	telegramFailure,
	telegramFailureDetails,
	decodeTelegramFailure,
} from "../startupFailure"
import { TelegramApiError } from "../TelegramApi"
import type { ClineProvider } from "../../../../core/webview/ClineProvider"

vi.mock("../launchCoordinator", () => ({ launchTelegramCoordinator: vi.fn() }))
vi.mock("../../../../i18n", () => ({ t: (key: string) => key }))
vi.mock("../../project-task-storage", () => ({ readProjectTaskStorage: () => undefined }))
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
const credentials = JSON.stringify({ token: "123:fixture", ownerId: 123 })
function fixture() {
	const task = Object.assign(new EventEmitter(), {
		taskId: "task",
		cwd: "/project",
		clineMessages: [],
		getRemotePendingAsk: () => undefined,
	})
	const provider = Object.assign(new EventEmitter(), {
		cwd: "/project",
		context: {
			subscriptions: [],
			extensionPath: "/extension",
			secrets: { get: vi.fn(async () => credentials), store: vi.fn(async () => {}) },
		},
		getTaskHistory: () => [],
		getCurrentTask: () => task,
		postMessageToWebview: vi.fn(async () => true),
		log: vi.fn(),
	})
	return { provider, manager: new TelegramManager(provider as unknown as ClineProvider) }
}
function liveClient() {
	const client = Object.assign(new EventEmitter(), {
		close: vi.fn(),
		request: vi.fn(async (request: { operation: string; taskId?: string }) => {
			if (request.operation === "hasTopic") return true
			return {
				key: "key",
				clientId: "client",
				taskId: request.taskId ?? "__project__",
				chatId: 123,
				ownerId: 123,
				threadId: 7,
				activatedAt: Date.now(),
				minimumUpdateId: 0,
				epoch: "fresh",
			}
		}),
	})
	return client
}

beforeEach(() => {
	vi.clearAllMocks()
	Object.defineProperty(vscode.workspace, "isTrusted", { value: true, configurable: true })
})
it("does not restore a stale settings read after saving", async () => {
	const { provider, manager } = fixture()
	const old = deferred<string>()
	provider.context.secrets.get.mockReturnValueOnce(old.promise)
	const load = manager.load()
	await manager.save("456:newfixture", "456")
	old.resolve(credentials)
	await load
	expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
		expect.objectContaining({ telegramState: expect.objectContaining({ ownerId: 456 }) }),
	)
	manager.dispose()
})
it("rejects a duplicate save without cancelling the first and blocks activation during save", async () => {
	const { provider, manager } = fixture()
	const store = deferred<void>()
	provider.context.secrets.store.mockReturnValueOnce(store.promise)
	const saving = manager.save(undefined, "456")
	await expect(manager.save(undefined, "789")).rejects.toThrow("unavailable")
	await manager.activate("task")
	expect(launchTelegramCoordinator).not.toHaveBeenCalled()
	store.resolve()
	await saving
	expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
		expect.objectContaining({ telegramState: expect.objectContaining({ ownerId: 456, status: "inactive" }) }),
	)
	manager.dispose()
})
it("shows a specific, credential-free activation failure and allows retry", async () => {
	const notification = vi.spyOn(vscode.window, "showErrorMessage")
	const { provider, manager } = fixture()
	vi.mocked(launchTelegramCoordinator).mockRejectedValueOnce(new TelegramStartupError("topics-disabled"))
	await manager.activate("task")
	expect(provider.log).toHaveBeenCalledWith("Telegram activation failed (topics-disabled)")
	expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
		expect.objectContaining({
			telegramState: expect.objectContaining({
				status: "error",
				error: "common:telegram.failure.topics-disabled",
			}),
		}),
	)
	expect(notification).toHaveBeenCalledWith("common:telegram.failure.topics-disabled")
	const client = Object.assign(new EventEmitter(), {
		close: vi.fn(),
		request: vi.fn().mockRejectedValue(new Error("unsafe secret")),
	})
	vi.mocked(launchTelegramCoordinator).mockResolvedValueOnce(
		client as unknown as Awaited<ReturnType<typeof launchTelegramCoordinator>>,
	)
	await manager.activate("task")
	expect(provider.log).toHaveBeenLastCalledWith("Telegram activation failed (startup-failed)")
	expect(provider.log).not.toHaveBeenCalledWith(expect.stringContaining("unsafe secret"))
	manager.dispose()
	notification.mockRestore()
})
it("maps API failures to allowlisted reasons without exposing raw errors", () => {
	expect(telegramStartupReason(new TelegramApiError(401))).toBe("token-rejected")
	expect(telegramStartupReason(new TelegramApiError(409))).toBe("polling-conflict")
	expect(telegramStartupReason(new TelegramApiError(503))).toBe("telegram-unreachable")
	expect(telegramStartupReason(new Error("secret token in raw response"))).toBe("local-runtime")
	expect(isTelegramStartupReason("webhook-active")).toBe(true)
	expect(isTelegramStartupReason("secret token in raw response")).toBe(false)
})
it("closes stale activation clients without replacing the newer inactive state", async () => {
	const { provider, manager } = fixture()
	const launch = deferred<Awaited<ReturnType<typeof launchTelegramCoordinator>>>()
	vi.mocked(launchTelegramCoordinator).mockReturnValueOnce(launch.promise)
	const activation = manager.activate("task")
	await vi.waitFor(() => expect(launchTelegramCoordinator).toHaveBeenCalled())
	await manager.deactivate()
	const close = vi.fn()
	launch.resolve(
		Object.assign(new EventEmitter(), { close }) as unknown as Awaited<
			ReturnType<typeof launchTelegramCoordinator>
		>,
	)
	await activation
	expect(close).toHaveBeenCalledOnce()
	expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
		expect.objectContaining({ telegramState: expect.objectContaining({ status: "inactive" }) }),
	)
	manager.dispose()
})

it("does not resurrect after cancelling an activation request already sent to the coordinator", async () => {
	const { provider, manager } = fixture()
	const response = deferred<unknown>()
	const client = Object.assign(new EventEmitter(), { close: vi.fn(), request: vi.fn(() => response.promise) })
	vi.mocked(launchTelegramCoordinator).mockResolvedValueOnce(
		client as unknown as Awaited<ReturnType<typeof launchTelegramCoordinator>>,
	)
	const activation = manager.activate("task")
	await vi.waitFor(() => expect(client.request).toHaveBeenCalled())
	await manager.deactivate("task")
	response.resolve({
		key: "key",
		clientId: "client",
		taskId: "task",
		chatId: 123,
		ownerId: 123,
		threadId: 7,
		activatedAt: 0,
		minimumUpdateId: 0,
		epoch: "late",
	})
	await activation
	expect(client.close).toHaveBeenCalled()
	expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
		expect.objectContaining({
			telegramState: expect.objectContaining({ status: "inactive" }),
		}),
	)
	manager.dispose()
})

it("preserves safe API stages and codes across IPC without response secrets", () => {
	const failure = telegramFailure(new TelegramApiError(403, undefined, "createForumTopic"), "operation")
	expect(decodeTelegramFailure(JSON.parse(JSON.stringify(failure)))).toMatchObject({
		reason: "telegram-rejected",
		stage: "createForumTopic",
		code: "403",
	})
	expect(telegramFailureDetails(failure)).toBe(" [createForumTopic; 403]")
	expect(telegramFailureDetails({ reason: "local-runtime", stage: "secret-token", code: "secret-token" })).toBe("")
	expect(telegramFailure(Object.assign(new Error("secret-token"), { code: "ENOENT" }), "bundle")).toMatchObject({
		stage: "bundle",
		code: "ENOENT",
	})
})
it("shows operation and safe code directly in the activation notification", async () => {
	const notification = vi.spyOn(vscode.window, "showErrorMessage")
	const { manager, provider } = fixture()
	vi.mocked(launchTelegramCoordinator).mockRejectedValueOnce(
		new TelegramStartupError("telegram-rejected", "createForumTopic", "403"),
	)
	await manager.activate("task")
	expect(provider.log).toHaveBeenCalledWith("Telegram activation failed (telegram-rejected) [createForumTopic; 403]")
	expect(notification).toHaveBeenCalledWith("common:telegram.failure.telegram-rejected [createForumTopic; 403]")
	notification.mockRestore()
	manager.dispose()
})

it("keeps the button enabled after startup failure, retries and stops retries on manual off", async () => {
	vi.useFakeTimers()
	const { provider, manager } = fixture()
	const notification = vi.spyOn(vscode.window, "showErrorMessage")
	try {
		vi.mocked(launchTelegramCoordinator).mockRejectedValue(new TelegramStartupError("telegram-unreachable"))
		await manager.activateAll("task")
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				telegramState: expect.objectContaining({
					enabled: true,
					status: "connecting",
					projectStatus: "connecting",
				}),
			}),
		)
		expect(notification).not.toHaveBeenCalled()
		const calls = vi.mocked(launchTelegramCoordinator).mock.calls.length
		await vi.advanceTimersByTimeAsync(2000)
		expect(launchTelegramCoordinator).toHaveBeenCalledTimes(calls + 2)
		await manager.deactivateAll()
		const stoppedCalls = vi.mocked(launchTelegramCoordinator).mock.calls.length
		await vi.advanceTimersByTimeAsync(120_000)
		expect(launchTelegramCoordinator).toHaveBeenCalledTimes(stoppedCalls)
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				telegramState: expect.objectContaining({
					enabled: false,
					status: "inactive",
					projectStatus: "inactive",
				}),
			}),
		)
	} finally {
		manager.dispose()
		notification.mockRestore()
		vi.useRealTimers()
	}
})

it("recovers both topics after a runtime fault without another button press", async () => {
	vi.useFakeTimers()
	const { provider, manager } = fixture()
	const clients: ReturnType<typeof liveClient>[] = []
	vi.mocked(launchTelegramCoordinator).mockImplementation(async () => {
		const client = liveClient()
		clients.push(client)
		return client as unknown as Awaited<ReturnType<typeof launchTelegramCoordinator>>
	})
	try {
		await manager.activateAll("task")
		expect(clients).toHaveLength(2)
		const fault = JSON.stringify(new TelegramStartupError("telegram-unreachable", "getUpdates", "503"))
		for (const client of clients.slice()) client.emit("fault", fault)
		await vi.advanceTimersByTimeAsync(2000)
		expect(clients).toHaveLength(4)
		expect(provider.log).toHaveBeenCalledWith(
			"Telegram project activation failed (telegram-unreachable) [getUpdates; 503]",
		)
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				telegramState: expect.objectContaining({ enabled: true, status: "active", projectStatus: "active" }),
			}),
		)
		await manager.deactivateAll()
		await vi.advanceTimersByTimeAsync(60_000)
		expect(clients).toHaveLength(4)
	} finally {
		manager.dispose()
		vi.useRealTimers()
	}
})

it("follows the current task when it changes during a pending connection", async () => {
	vi.useFakeTimers()
	const { provider, manager } = fixture()
	const old = provider.getCurrentTask()
	const next = Object.assign(new EventEmitter(), { ...old, taskId: "next" })
	let current = old
	provider.getCurrentTask = () => current
	const pending = deferred<Awaited<ReturnType<typeof launchTelegramCoordinator>>>()
	vi.mocked(launchTelegramCoordinator).mockReturnValue(pending.promise)
	try {
		const first = manager.activateAll("task")
		await vi.advanceTimersByTimeAsync(0)
		current = next
		pending.resolve(liveClient() as unknown as Awaited<ReturnType<typeof launchTelegramCoordinator>>)
		await first
		vi.mocked(launchTelegramCoordinator).mockImplementation(
			async () => liveClient() as unknown as Awaited<ReturnType<typeof launchTelegramCoordinator>>,
		)
		await vi.advanceTimersByTimeAsync(3000)
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				telegramState: expect.objectContaining({ enabled: true, status: "active", taskId: "next" }),
			}),
		)
	} finally {
		manager.dispose()
		vi.useRealTimers()
	}
})

it("does not revive old launches or schedule retries after off, including off/on during a pending launch", async () => {
	vi.useFakeTimers()
	const { provider, manager } = fixture()
	const pending = deferred<Awaited<ReturnType<typeof launchTelegramCoordinator>>>()
	vi.mocked(launchTelegramCoordinator).mockReturnValue(pending.promise)
	try {
		const first = manager.activateAll("task")
		await vi.advanceTimersByTimeAsync(0)
		expect(launchTelegramCoordinator).toHaveBeenCalledTimes(2)
		await manager.deactivateAll()
		vi.mocked(launchTelegramCoordinator).mockImplementation(
			async () => liveClient() as unknown as Awaited<ReturnType<typeof launchTelegramCoordinator>>,
		)
		await manager.activateAll("task")
		const late = liveClient()
		pending.resolve(late as unknown as Awaited<ReturnType<typeof launchTelegramCoordinator>>)
		await first
		expect(late.close).toHaveBeenCalledTimes(2)
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				telegramState: expect.objectContaining({ enabled: true, status: "active", projectStatus: "active" }),
			}),
		)
		await manager.deactivateAll()
		const calls = vi.mocked(launchTelegramCoordinator).mock.calls.length
		await vi.advanceTimersByTimeAsync(60_000)
		expect(launchTelegramCoordinator).toHaveBeenCalledTimes(calls)
	} finally {
		manager.dispose()
		vi.useRealTimers()
	}
})
