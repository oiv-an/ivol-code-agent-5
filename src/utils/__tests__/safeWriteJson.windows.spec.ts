// kilocode_change - Windows durability regression tests using real temporary files.
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { MockInstance } from "vitest"

import { safeWriteJson } from "../safeWriteJson"

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, open: vi.fn(actual.open) }
})

describe("safeWriteJson Windows file synchronization", () => {
	let tempDir: string
	let filePath: string

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ivol-json-windows-"))
		filePath = path.join(tempDir, "api_conversation_history.json")
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	async function emulateWindowsSync(failure?: { stage: ".new_" | ".bak_"; code: string }) {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const handles: {
			filePath: string
			flags: Parameters<typeof fs.open>[1]
			isFile: boolean
			sync: MockInstance<() => Promise<void>>
			close: MockInstance<() => Promise<void>>
		}[] = []
		let failurePending = Boolean(failure)
		const injectedError = Object.assign(new Error(`${failure?.code}: injected file fsync failure`), {
			code: failure?.code,
			syscall: "fsync",
		})

		vi.mocked(fs.open).mockImplementation(async (...args) => {
			const handle = await actual.open(...args)
			const isFile = (await handle.stat()).isFile()
			const originalSync = handle.sync.bind(handle)
			const sync = vi.spyOn(handle, "sync").mockImplementation(async () => {
				// Windows does not support directory fsync and requires a writable
				// regular-file handle for FlushFileBuffers. Keep all other I/O real.
				if (!isFile || args[1] === "r") {
					throw Object.assign(new Error("EPERM: operation not permitted, fsync"), {
						code: "EPERM",
						syscall: "fsync",
					})
				}
				if (failurePending && failure && String(args[0]).includes(failure.stage)) {
					failurePending = false
					throw injectedError
				}
				await originalSync()
			})
			const close = vi.spyOn(handle, "close")
			handles.push({ filePath: String(args[0]), flags: args[1], isFile, sync, close })
			return handle
		})

		return { handles, injectedError }
	}

	test.each([false, true])("saves history with writable handles (existing history: %s)", async (exists) => {
		const previousHistory = [{ role: "user", content: "Previous task message" }]
		const nextHistory = [...previousHistory, { role: "assistant", content: "Saved response" }]
		if (exists) {
			await fs.writeFile(filePath, JSON.stringify(previousHistory))
		}
		const { handles } = await emulateWindowsSync()

		await safeWriteJson(filePath, nextHistory)

		expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(nextHistory)
		const regularFiles = handles.filter((handle) => handle.isFile)
		expect(regularFiles).toHaveLength(exists ? 2 : 1)
		expect(regularFiles.some((handle) => handle.filePath.includes(".new_"))).toBe(true)
		expect(regularFiles.some((handle) => handle.filePath.includes(".bak_"))).toBe(exists)
		for (const handle of regularFiles) {
			expect(handle.flags).toBe("r+")
			expect(handle.sync).toHaveBeenCalledOnce()
		}
		for (const handle of handles) {
			expect(handle.close).toHaveBeenCalledOnce()
		}
		expect(await fs.readdir(tempDir)).toEqual([path.basename(filePath)])
	})

	test.each([
		{ stage: ".new_" as const, code: "EPERM" },
		{ stage: ".bak_" as const, code: "EPERM" },
		{ stage: ".new_" as const, code: "EIO" },
		{ stage: ".bak_" as const, code: "EIO" },
	])("preserves old history and releases the lock after $stage $code", async (failure) => {
		const previousHistory = [{ role: "user", content: "History must survive a failed commit" }]
		const nextHistory = [...previousHistory, { role: "assistant", content: "Next response" }]
		await fs.writeFile(filePath, JSON.stringify(previousHistory))
		const { handles, injectedError } = await emulateWindowsSync(failure)
		vi.spyOn(console, "error").mockImplementation(() => undefined)

		await expect(safeWriteJson(filePath, nextHistory)).rejects.toBe(injectedError)

		expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(previousHistory)
		expect(await fs.readdir(tempDir)).toEqual([path.basename(filePath)])
		for (const handle of handles) {
			expect(handle.close).toHaveBeenCalledOnce()
		}

		// A real synchronization failure is not ignored; a later retry can commit.
		await safeWriteJson(filePath, nextHistory)
		expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(nextHistory)
		expect(await fs.readdir(tempDir)).toEqual([path.basename(filePath)])
	})
})
