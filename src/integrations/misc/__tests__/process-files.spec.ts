// kilocode_change - new file
import fs from "fs/promises"
import os from "os"
import * as path from "path"

import * as vscode from "vscode"

import { selectAnyFiles, saveDroppedFiles } from "../process-files"

vi.mock("vscode", () => ({
	window: {
		showOpenDialog: vi.fn(),
	},
}))

describe("selectAnyFiles", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("opens the dialog without any type filters", async () => {
		vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(undefined)

		await selectAnyFiles()

		const options = vi.mocked(vscode.window.showOpenDialog).mock.calls[0][0]
		expect(options).toBeDefined()
		expect(options!.filters).toBeUndefined()
		expect(options!.canSelectMany).toBe(true)
		expect(options!.canSelectFolders).toBe(false)
	})

	it("returns an empty array when the user cancels", async () => {
		vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(undefined)

		await expect(selectAnyFiles()).resolves.toEqual([])
	})

	it("returns absolute file system paths for every selected file", async () => {
		vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([
			{ fsPath: "/tmp/one.bin" },
			{ fsPath: "/tmp/two.csv" },
		] as unknown as vscode.Uri[])

		await expect(selectAnyFiles()).resolves.toEqual(["/tmp/one.bin", "/tmp/two.csv"])
	})
})

describe("saveDroppedFiles", () => {
	const createdPaths: string[] = []

	afterAll(async () => {
		await Promise.all(
			createdPaths.map((p) => fs.rm(path.dirname(p), { recursive: true, force: true }).catch(() => undefined)),
		)
	})

	it("returns an empty array for an empty payload", async () => {
		await expect(saveDroppedFiles([])).resolves.toEqual([])
	})

	it("writes the decoded contents to a temp directory and returns real paths", async () => {
		const contents = "hello from a dropped file"
		const [savedPath] = await saveDroppedFiles([
			{ name: "notes.txt", data: Buffer.from(contents).toString("base64") },
		])

		createdPaths.push(savedPath)

		expect(savedPath.startsWith(path.join(os.tmpdir(), "kilocode-attachments"))).toBe(true)
		await expect(fs.readFile(savedPath, "utf8")).resolves.toBe(contents)
	})

	it("sanitizes path separators in the incoming file name", async () => {
		const [savedPath] = await saveDroppedFiles([
			{ name: "../../escape.txt", data: Buffer.from("x").toString("base64") },
		])

		createdPaths.push(savedPath)

		expect(path.basename(savedPath)).toBe("escape.txt")
	})

	it("skips empty payloads instead of creating empty files", async () => {
		await expect(saveDroppedFiles([{ name: "empty.txt", data: "" }])).resolves.toEqual([])
	})
})
