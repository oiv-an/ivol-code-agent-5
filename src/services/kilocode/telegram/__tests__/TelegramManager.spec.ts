import { EventEmitter } from "node:events"
import * as vscode from "vscode"
import { TelegramManager } from "../TelegramManager"
import { launchTelegramCoordinator } from "../launchCoordinator"
import { TelegramStartupError, telegramStartupReason, isTelegramStartupReason } from "../startupFailure"
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
		context: {
			subscriptions: [],
			extensionPath: "/extension",
			secrets: { get: vi.fn(async () => credentials), store: vi.fn(async () => {}) },
		},
		getCurrentTask: () => task,
		postMessageToWebview: vi.fn(async () => true),
		log: vi.fn(),
	})
	return { provider, manager: new TelegramManager(provider as unknown as ClineProvider) }
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
