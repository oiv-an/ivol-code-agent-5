import { EventEmitter } from "events"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { createExtensionService } from "../../services/extension.js"
import { fetchRouterModels } from "../index.js"

vi.mock("../../services/extension.js", () => ({
	createExtensionService: vi.fn(),
}))

describe("fetchRouterModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it.each(["openai", "openai-codex", "claude-code"] as const)(
		"returns immediately for static provider %s without starting the extension",
		async (provider) => {
			await expect(
				fetchRouterModels({
					providerSettings: { apiProvider: provider },
					timeoutMs: 1,
				}),
			).resolves.toBeNull()

			expect(createExtensionService).not.toHaveBeenCalled()
		},
	)

	it.each(["roo", "openrouter", "kilocode"] as const)(
		"fails closed for hidden router provider %s without starting the extension",
		async (provider) => {
			await expect(
				fetchRouterModels({
					providerSettings: { apiProvider: provider },
					timeoutMs: 1,
				}),
			).resolves.toBeNull()

			expect(createExtensionService).not.toHaveBeenCalled()
		},
	)

	it.each(["ollama", "lmstudio"] as const)("keeps local router discovery enabled for %s", async (provider) => {
		const service = new EventEmitter() as EventEmitter & {
			initialize: ReturnType<typeof vi.fn>
			isReady: ReturnType<typeof vi.fn>
			getExtensionHost: ReturnType<typeof vi.fn>
			sendWebviewMessage: ReturnType<typeof vi.fn>
			dispose: ReturnType<typeof vi.fn>
		}
		service.initialize = vi.fn().mockResolvedValue(undefined)
		service.isReady = vi.fn().mockReturnValue(true)
		service.getExtensionHost = vi.fn().mockReturnValue({
			injectConfiguration: vi.fn().mockResolvedValue(undefined),
		})
		service.sendWebviewMessage = vi.fn().mockImplementation(async () => {
			queueMicrotask(() => {
				service.emit("message", { type: "routerModels", routerModels: { [provider]: {} } })
			})
		})
		service.dispose = vi.fn().mockResolvedValue(undefined)
		vi.mocked(createExtensionService).mockReturnValue(service as never)

		await expect(
			fetchRouterModels({
				providerSettings: { apiProvider: provider },
				timeoutMs: 100,
			}),
		).resolves.toEqual({ [provider]: {} })

		expect(createExtensionService).toHaveBeenCalledTimes(1)
		expect(service.sendWebviewMessage).toHaveBeenCalledWith({
			type: "requestRouterModels",
			values: { provider },
		})
		expect(service.dispose).toHaveBeenCalledTimes(1)
	})
})
