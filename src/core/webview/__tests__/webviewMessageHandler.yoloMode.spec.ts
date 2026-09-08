// kilocode_change - new file
import * as vscode from "vscode"
import type { ClineProvider } from "../ClineProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"

describe("explicit YOLO webview controls", () => {
	const now = 1_800_000_000_000
	function createProvider() {
		const values = new Map<string, unknown>([["yoloModeExpiresAt", now - 1]])
		const provider = {
			contextProxy: {
				getValue: vi.fn((key: string) => values.get(key)),
				setValue: vi.fn(async (key: string, value: unknown) => {
					values.set(key, value)
				}),
			},
			getState: vi.fn(async () => ({})),
			getCurrentTask: vi.fn(),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
		}
		return { provider, values, typed: provider as unknown as ClineProvider }
	}

	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(Date, "now").mockReturnValue(now)
		vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)
	})
	afterEach(() => vi.restoreAllMocks())

	it("starts a fresh timer only on the dedicated explicit start action", async () => {
		const { typed, provider, values } = createProvider()
		await webviewMessageHandler(typed, { type: "startYoloModeTimer", value: 60 })
		expect(values.get("yoloMode")).toBe(true)
		expect(values.get("yoloModeExpiresAt")).toBe(now + 3_600_000)
		expect(values.get("yoloModeTimerMinutes")).toBe(60)
		expect(provider.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("handles immediate stop without clearing the deadline", async () => {
		const { typed, values } = createProvider()
		await webviewMessageHandler(typed, { type: "yoloMode", bool: false })
		expect(values.get("yoloMode")).toBe(false)
		expect(values.get("yoloModeExpiresAt")).toBe(now - 1)
	})

	it("handles explicit unlimited enable", async () => {
		const { typed, values } = createProvider()
		await webviewMessageHandler(typed, { type: "yoloMode", bool: true })
		expect(values.get("yoloMode")).toBe(true)
		expect(values.get("yoloModeExpiresAt")).toBeUndefined()
	})

	it("rejects malformed duration and refreshes UI instead of enabling mode", async () => {
		const { typed, provider, values } = createProvider()
		await webviewMessageHandler(typed, { type: "startYoloModeTimer", value: 0 })
		expect(values.get("yoloMode")).toBe(false)
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.any(String))
		expect(provider.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("reports persistence failures and keeps mode disabled", async () => {
		const { typed, provider, values } = createProvider()
		const persist = provider.contextProxy.setValue.getMockImplementation()!
		provider.contextProxy.setValue.mockImplementation(async (key, value) => {
			if (key === "yoloModeExpiresAt") throw new Error("disk unavailable")
			await persist(key, value)
		})
		await webviewMessageHandler(typed, { type: "startYoloModeTimer", value: 60 })
		expect(values.get("yoloMode")).toBe(false)
		expect(provider.log).toHaveBeenCalledWith(expect.stringContaining("disk unavailable"))
		expect(provider.postStateToWebview).toHaveBeenCalledOnce()
	})

	it.each([
		["yoloMode", true],
		["yoloModeExpiresAt", now + 3_600_000],
		["yoloModeTimerMinutes", 60],
		["yoloModeRevocationId", "00000000-0000-4000-8000-000000000001"],
		["yoloModeGrant", { revocationId: "00000000-0000-4000-8000-000000000001" }],
	])("ignores generic global-state changes to %s", async (stateKey, stateValue) => {
		const { typed, provider } = createProvider()
		await webviewMessageHandler(typed, { type: "updateGlobalState", stateKey, stateValue } as never)
		expect(provider.contextProxy.setValue).not.toHaveBeenCalled()
		expect(provider.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("ignores stale YOLO fields in the bulk settings path", async () => {
		const { typed, provider } = createProvider()
		await webviewMessageHandler(typed, {
			type: "updateSettings",
			updatedSettings: { yoloMode: true, yoloModeExpiresAt: undefined, yoloModeTimerMinutes: 60 },
		})
		expect(provider.contextProxy.setValue).not.toHaveBeenCalled()
		expect(provider.postStateToWebview).toHaveBeenCalledOnce()
	})
})
