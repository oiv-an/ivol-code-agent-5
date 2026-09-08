// kilocode_change - new file
import type * as vscode from "vscode"
import { isYoloModeActive, getYoloModeExpiresAt } from "@roo-code/types"
import { ContextProxy } from "../ContextProxy"
import { updateYoloMode } from "../yoloMode"

const now = 1_800_000_000_000

function createFixture(initial: Record<string, unknown> = {}) {
	const storage = new Map(Object.entries(initial))
	const update = vi.fn(async (key: string, value: unknown) => {
		if (value === undefined) storage.delete(key)
		else storage.set(key, value)
	})
	const context = {
		globalState: { get: (key: string) => storage.get(key), update },
		secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
	} as unknown as vscode.ExtensionContext
	return { storage, update, context, proxy: new ContextProxy(context) }
}

describe("explicit YOLO timer changes", () => {
	beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now))
	afterEach(() => vi.restoreAllMocks())

	it("persists disabled state, the deadline and duration before enabling", async () => {
		const { proxy, update } = createFixture({ yoloMode: true })
		await updateYoloMode(proxy, { type: "timer", minutes: 60 })
		expect(update.mock.calls).toEqual([
			["yoloModeRevocationId", expect.any(String)],
			["yoloMode", false],
			["yoloModeExpiresAt", now + 3_600_000],
			["yoloModeTimerMinutes", 60],
			["yoloModeGrant", { revocationId: expect.any(String), expiresAt: now + 3_600_000 }],
			["yoloMode", true],
		])
		expect(isYoloModeActive(proxy.getValues())).toBe(true)
		vi.mocked(Date.now).mockReturnValue(now + 3_600_000)
		expect(isYoloModeActive(proxy.getValues())).toBe(false)
	})

	it("does not renew on reload or repeated reads", async () => {
		const { proxy, context, storage } = createFixture()
		await updateYoloMode(proxy, { type: "timer", minutes: 1 })
		const restarted = new ContextProxy(context)
		await restarted.initialize()
		vi.mocked(Date.now).mockReturnValue(now + 60_000)
		for (let index = 0; index < 10; index++) expect(isYoloModeActive(restarted.getValues())).toBe(false)
		expect(storage.get("yoloModeExpiresAt")).toBe(now + 60_000)
	})

	it("disables immediately without resetting the deadline or normal approval preferences", async () => {
		const { proxy, storage } = createFixture({ alwaysAllowWrite: true, autoApprovalEnabled: true })
		await updateYoloMode(proxy, { type: "timer", minutes: 60 })
		await updateYoloMode(proxy, { type: "toggle", enabled: false })
		expect(storage.get("yoloMode")).toBe(false)
		expect(storage.get("yoloModeExpiresAt")).toBe(now + 3_600_000)
		expect(storage.get("alwaysAllowWrite")).toBe(true)
		expect(storage.get("autoApprovalEnabled")).toBe(true)
	})

	it("only an explicit unlimited toggle clears a deadline", async () => {
		const { proxy, storage } = createFixture({ yoloMode: true, yoloModeExpiresAt: now - 1 })
		await updateYoloMode(proxy, { type: "toggle", enabled: true })
		expect(storage.has("yoloModeExpiresAt")).toBe(false)
		expect(isYoloModeActive(proxy.getValues())).toBe(true)
	})

	it.each([undefined, null, "60", 0, -1, 1.5, 1441, NaN, Infinity])(
		"rejects malformed duration %s safely",
		async (minutes) => {
			const { proxy, update } = createFixture({ yoloMode: true })
			await expect(updateYoloMode(proxy, { type: "timer", minutes })).rejects.toThrow("whole number")
			expect(isYoloModeActive(proxy.getValues())).toBe(false)
			expect(update).not.toHaveBeenCalledWith("yoloMode", true)
		},
	)

	it.each([1, 2, 3, 4, 5, 6])("fails closed when persistence step %i rejects", async (failureStep) => {
		const { proxy, update } = createFixture({ yoloMode: true })
		const persist = update.getMockImplementation()!
		let calls = 0
		update.mockImplementation(async (key, value) => {
			if (++calls === failureStep) throw new Error("disk unavailable")
			await persist(key, value)
		})
		await expect(updateYoloMode(proxy, { type: "timer", minutes: 60 })).rejects.toThrow("disk unavailable")
		expect(isYoloModeActive(proxy.getValues())).toBe(false)
	})

	it("keeps a local deny override when even emergency disable cannot be saved", async () => {
		const { proxy, update, storage } = createFixture({ yoloMode: true })
		update.mockRejectedValue(new Error("disk unavailable"))
		await expect(updateYoloMode(proxy, { type: "timer", minutes: 60 })).rejects.toThrow("disabled in this session")
		expect(storage.get("yoloMode")).toBe(true)
		expect(isYoloModeActive(proxy.getValues())).toBe(false)
	})

	it("does not grant legacy unlimited permission while a persistence write is pending", async () => {
		const { proxy, update } = createFixture({ yoloMode: true })
		let release!: () => void
		const pause = new Promise<void>((resolve) => (release = resolve))
		const persist = update.getMockImplementation()!
		update.mockImplementationOnce(async (key, value) => {
			await pause
			await persist(key, value)
		})
		const start = updateYoloMode(proxy, { type: "timer", minutes: 60 })
		await Promise.resolve()
		expect(isYoloModeActive(proxy.getValues())).toBe(false)
		release()
		await start
		expect(isYoloModeActive(proxy.getValues())).toBe(true)
	})

	it("serializes starts and a later stop for shared webviews", async () => {
		const { proxy } = createFixture()
		await Promise.all([
			updateYoloMode(proxy, { type: "timer", minutes: 60 }),
			updateYoloMode(proxy, { type: "toggle", enabled: false }),
		])
		expect(isYoloModeActive(proxy.getValues())).toBe(false)
	})

	it("reads another window's absolute deadline and stop through host storage", async () => {
		const { proxy, context } = createFixture({ yoloMode: true })
		const otherWindow = new ContextProxy(context)
		await otherWindow.initialize()
		expect(isYoloModeActive(otherWindow.getValues())).toBe(true)
		await updateYoloMode(proxy, { type: "timer", minutes: 1 })
		vi.mocked(Date.now).mockReturnValue(now + 60_000)
		expect(isYoloModeActive(otherWindow.getValues())).toBe(false)
		await updateYoloMode(proxy, { type: "toggle", enabled: false })
		expect(otherWindow.getValue("yoloMode")).toBe(false)
	})

	it("preserves imported timer metadata without restarting or granting permission", async () => {
		const { proxy, storage } = createFixture({ yoloMode: true })
		await updateYoloMode(proxy, {
			type: "import",
			settings: { yoloMode: true, yoloModeExpiresAt: now - 1, yoloModeTimerMinutes: 60 },
		})
		expect(isYoloModeActive(proxy.getValues())).toBe(false)
		expect(storage.get("yoloModeExpiresAt")).toBe(now - 1)
		expect(storage.get("yoloModeTimerMinutes")).toBe(60)
	})

	it.each(["initial-disable", "deadline", "duration", "grant", "final-enable"])(
		"a durable stop in another proxy revokes a start paused at %s, including after reload",
		async (phase) => {
			const { proxy, context, update, storage } = createFixture({ yoloMode: true })
			const otherProxy = new ContextProxy(context)
			const phases = {
				"initial-disable": "yoloMode",
				deadline: "yoloModeExpiresAt",
				duration: "yoloModeTimerMinutes",
				grant: "yoloModeGrant",
				"final-enable": "yoloMode",
			}
			let reached!: () => void
			const paused = new Promise<void>((resolve) => (reached = resolve))
			let release!: () => void
			const wait = new Promise<void>((resolve) => (release = resolve))
			const persist = update.getMockImplementation()!
			let intercepted = false
			update.mockImplementation(async (key, value) => {
				const matching =
					key === phases[phase as keyof typeof phases] &&
					(phase !== "initial-disable" || value === false) &&
					(phase !== "final-enable" || value === true)
				if (matching && !intercepted) {
					intercepted = true
					reached()
					await wait
				}
				await persist(key, value)
			})
			const lateStart = updateYoloMode(proxy, { type: "timer", minutes: 60 })
			await paused
			await updateYoloMode(otherProxy, { type: "toggle", enabled: false })
			const stoppedId = storage.get("yoloModeRevocationId")
			expect(stoppedId).toEqual(expect.any(String))
			release()
			await lateStart
			// A late boolean true is not an authorization grant once the stop identity changed.
			expect(isYoloModeActive(proxy.getValues())).toBe(false)
			expect(isYoloModeActive(otherProxy.getValues())).toBe(false)
			const restarted = new ContextProxy(context)
			await restarted.initialize()
			expect(isYoloModeActive(restarted.getValues())).toBe(false)
			// A NEW explicit start after the stop captures the new identity, even in the same millisecond.
			await updateYoloMode(restarted, { type: "timer", minutes: 1 })
			expect(isYoloModeActive(restarted.getValues())).toBe(true)
			expect(storage.get("yoloModeRevocationId")).not.toBe(stoppedId)
			expect(storage.get("yoloModeGrant")).toMatchObject({ revocationId: storage.get("yoloModeRevocationId") })
		},
	)

	it("an unlimited start is also revoked when it completes after another window's stop", async () => {
		const { proxy, context, update } = createFixture()
		const otherProxy = new ContextProxy(context)
		let release!: () => void
		let reached!: () => void
		const paused = new Promise<void>((resolve) => (reached = resolve))
		const wait = new Promise<void>((resolve) => (release = resolve))
		const persist = update.getMockImplementation()!
		update.mockImplementation(async (key, value) => {
			if (key === "yoloMode" && value === true) {
				reached()
				await wait
			}
			await persist(key, value)
		})
		const start = updateYoloMode(proxy, { type: "toggle", enabled: true })
		await paused
		await updateYoloMode(otherProxy, { type: "toggle", enabled: false })
		release()
		await start
		expect(isYoloModeActive(proxy.getValues())).toBe(false)
	})

	it("imports rotate local revocation instead of trusting saved foreign grant identities", async () => {
		const { proxy, context, update, storage } = createFixture()
		const otherProxy = new ContextProxy(context)
		let release!: () => void
		let reached!: () => void
		const paused = new Promise<void>((resolve) => (reached = resolve))
		const wait = new Promise<void>((resolve) => (release = resolve))
		const persist = update.getMockImplementation()!
		update.mockImplementation(async (key, value) => {
			if (key === "yoloMode" && value === true) {
				reached()
				await wait
			}
			await persist(key, value)
		})
		const start = updateYoloMode(proxy, { type: "timer", minutes: 60 })
		await paused
		await updateYoloMode(otherProxy, {
			type: "import",
			settings: { yoloMode: true, yoloModeRevocationId: undefined, yoloModeGrant: undefined },
		})
		expect(storage.get("yoloModeRevocationId")).toEqual(expect.any(String))
		release()
		await start
		expect(isYoloModeActive(proxy.getValues())).toBe(false)
	})

	it("a stale long deadline cannot extend a newer short grant while the old write is pending", async () => {
		const { proxy, context, update, storage } = createFixture()
		const otherProxy = new ContextProxy(context)
		let firstReached!: () => void
		const firstPaused = new Promise<void>((resolve) => (firstReached = resolve))
		let releaseFirst!: () => void
		const firstWait = new Promise<void>((resolve) => (releaseFirst = resolve))
		let staleReached!: () => void
		const stalePaused = new Promise<void>((resolve) => (staleReached = resolve))
		let releaseStale!: () => void
		const staleWait = new Promise<void>((resolve) => (releaseStale = resolve))
		const persist = update.getMockImplementation()!
		update.mockImplementation(async (key, value) => {
			if (key === "yoloModeExpiresAt" && value === now + 3_600_000) {
				firstReached()
				await firstWait
			}
			await persist(key, value)
			if (key === "yoloModeExpiresAt" && value === now + 3_600_000) {
				staleReached()
				await staleWait
			}
		})
		const oldLongStart = updateYoloMode(proxy, { type: "timer", minutes: 60 })
		await firstPaused
		await updateYoloMode(otherProxy, { type: "toggle", enabled: false })
		await updateYoloMode(otherProxy, { type: "timer", minutes: 1 })
		expect(isYoloModeActive(otherProxy.getValues())).toBe(true)
		releaseFirst()
		await stalePaused
		expect(storage.get("yoloModeExpiresAt")).toBe(now + 3_600_000)
		expect(getYoloModeExpiresAt(otherProxy.getValues())).toBe(now + 60_000)
		vi.mocked(Date.now).mockReturnValue(now + 60_000)
		expect(isYoloModeActive(otherProxy.getValues())).toBe(false)
		releaseStale()
		await oldLongStart
		expect(isYoloModeActive(otherProxy.getValues())).toBe(false)
	})

	it("a failed partially stored grant cannot be revived by another host's late boolean", async () => {
		const { proxy, context, update } = createFixture()
		const otherProxy = new ContextProxy(context)
		let reached!: () => void
		const paused = new Promise<void>((resolve) => (reached = resolve))
		let release!: () => void
		const wait = new Promise<void>((resolve) => (release = resolve))
		const persist = update.getMockImplementation()!
		let enabledWrites = 0
		update.mockImplementation(async (key, value) => {
			if (key === "yoloMode" && value === true) {
				if (++enabledWrites === 1) {
					reached()
					await wait
				} else throw new Error("cannot persist final enable")
			}
			await persist(key, value)
		})
		const oldStart = updateYoloMode(proxy, { type: "timer", minutes: 60 })
		await paused
		await expect(updateYoloMode(otherProxy, { type: "timer", minutes: 1 })).rejects.toThrow(
			"cannot persist final enable",
		)
		release()
		await oldStart
		expect(isYoloModeActive(proxy.getValues())).toBe(false)
		expect(isYoloModeActive(otherProxy.getValues())).toBe(false)
	})

	it.each(["deadline", "grant", "final-enable"])(
		"an older long start paused at %s cannot extend a newer short start",
		async (phase) => {
			const { proxy, context, update } = createFixture()
			const otherProxy = new ContextProxy(context)
			let reached!: () => void
			const paused = new Promise<void>((resolve) => (reached = resolve))
			let release!: () => void
			const wait = new Promise<void>((resolve) => (release = resolve))
			const persist = update.getMockImplementation()!
			let intercepted = false
			update.mockImplementation(async (key, value) => {
				const matching =
					(phase === "deadline" && key === "yoloModeExpiresAt") ||
					(phase === "grant" && key === "yoloModeGrant") ||
					(phase === "final-enable" && key === "yoloMode" && value === true)
				if (matching && !intercepted) {
					intercepted = true
					reached()
					await wait
				}
				await persist(key, value)
			})
			const oldLongStart = updateYoloMode(proxy, { type: "timer", minutes: 60 })
			await paused
			await updateYoloMode(otherProxy, { type: "timer", minutes: 1 })
			expect(isYoloModeActive(otherProxy.getValues())).toBe(true)
			release()
			await oldLongStart
			vi.mocked(Date.now).mockReturnValue(now + 60_000)
			expect(isYoloModeActive(proxy.getValues())).toBe(false)
			expect(isYoloModeActive(otherProxy.getValues())).toBe(false)
		},
	)

	it("does not revoke a newer grant when an obsolete grant write fails", async () => {
		const { proxy, context, update, storage } = createFixture()
		const otherProxy = new ContextProxy(context)
		let reached!: () => void
		const paused = new Promise<void>((resolve) => (reached = resolve))
		let release!: () => void
		const wait = new Promise<void>((resolve) => (release = resolve))
		const persist = update.getMockImplementation()!
		let intercepted = false
		update.mockImplementation(async (key, value) => {
			if (key === "yoloModeGrant" && !intercepted) {
				intercepted = true
				reached()
				await wait
				throw new Error("obsolete write failed")
			}
			await persist(key, value)
		})
		const oldStart = updateYoloMode(proxy, { type: "timer", minutes: 60 })
		await paused
		await updateYoloMode(otherProxy, { type: "timer", minutes: 1 })
		const newestId = storage.get("yoloModeRevocationId")
		release()
		await oldStart
		expect(storage.get("yoloModeRevocationId")).toBe(newestId)
		expect(isYoloModeActive(otherProxy.getValues())).toBe(true)
		expect(getYoloModeExpiresAt(otherProxy.getValues())).toBe(now + 60_000)
	})

	it("supersedes an older queued local start before it can grant longer permission", async () => {
		const { proxy } = createFixture()
		await Promise.all([
			updateYoloMode(proxy, { type: "timer", minutes: 60 }),
			updateYoloMode(proxy, { type: "timer", minutes: 1 }),
		])
		expect(getYoloModeExpiresAt(proxy.getValues())).toBe(now + 60_000)
		expect(isYoloModeActive(proxy.getValues())).toBe(true)
	})
})
