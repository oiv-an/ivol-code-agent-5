import * as fs from "node:fs/promises"
import * as path from "node:path"
import { tmpdir } from "node:os"
import type { ClineMessage } from "@roo-code/types"
import { readTelegramImageAttachment } from "../TelegramAttachments"

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }))

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
const outsidePng = Buffer.from([...png, 2])
const row = (imagePath: string): ClineMessage => ({
	ts: 1,
	type: "say",
	say: "image",
	text: JSON.stringify({ imageUri: "webview:image", imagePath }),
})

describe("Telegram attachment parent-directory races", () => {
	let base: string
	let root: string
	let parent: string
	let outside: string
	let target: string

	beforeEach(async () => {
		base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "telegram-race-")))
		root = path.join(base, "workspace")
		parent = path.join(root, "images")
		outside = path.join(base, "outside")
		target = path.join(parent, "image.png")
		await fs.mkdir(parent, { recursive: true })
		await fs.mkdir(outside)
		await fs.writeFile(target, png)
		await fs.writeFile(path.join(outside, "image.png"), outsidePng)
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(base, { recursive: true, force: true })
	})

	it("never returns the outside PNG after swapping the parent immediately after realpath", async () => {
		const realpath = fs.realpath
		let swapped = false
		vi.spyOn(fs, "realpath").mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
			const result = await realpath(...args)
			if (args[0] === target && !swapped) {
				swapped = true
				await fs.rename(parent, `${parent}-saved`)
				await fs.symlink(outside, parent, "junction")
			}
			return result
		})
		await expect(readTelegramImageAttachment(row(target), root)).rejects.toThrow()
		expect(swapped).toBe(true)
	})

	it.each(["darwin", "win32", "freebsd"])("fails closed on %s before opening any image", async (platform) => {
		vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform)
		const open = vi.spyOn(fs, "open")
		await expect(readTelegramImageAttachment(row(target), root)).rejects.toThrow("unsupported on this platform")
		expect(open).not.toHaveBeenCalled()
	})

	it.skipIf(process.platform !== "linux")("reads an ordinary nested image on Linux", async () => {
		expect(await readTelegramImageAttachment(row(target), root)).toBe(
			`data:image/png;base64,${png.toString("base64")}`,
		)
	})

	it.skipIf(process.platform !== "linux")(
		"keeps the pinned parent when it is swapped before the final open (including ABA)",
		async () => {
			const open = fs.open
			let swapped = false
			vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
				if (String(args[0]).endsWith("/image.png")) {
					swapped = true
					await fs.rename(parent, `${parent}-saved`)
					await fs.symlink(outside, parent, "dir")
					const handle = await open(...args)
					await fs.unlink(parent)
					await fs.rename(`${parent}-saved`, parent)
					return handle
				}
				return open(...args)
			})
			expect(await readTelegramImageAttachment(row(target), root)).toBe(
				`data:image/png;base64,${png.toString("base64")}`,
			)
			expect(swapped).toBe(true)
		},
	)

	it.skipIf(process.platform !== "linux")(
		"rejects a basename symlink and closes every acquired directory handle",
		async () => {
			const open = fs.open
			const handles: fs.FileHandle[] = []
			vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
				if (String(args[0]).endsWith("/image.png")) {
					await fs.unlink(target)
					await fs.symlink(path.join(outside, "image.png"), target)
				}
				const handle = await open(...args)
				handles.push(handle)
				return handle
			})
			await expect(readTelegramImageAttachment(row(target), root)).rejects.toThrow()
			expect(handles.length).toBeGreaterThan(0)
			expect(handles.every((handle) => handle.fd === -1)).toBe(true)
		},
	)
})
