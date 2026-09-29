// kilocode_change - new file
import * as fs from "fs"
import * as path from "path"
import { formatResponse } from "../responses"
import { RooIgnoreController, LOCK_TEXT_SYMBOL } from "../../ignore/RooIgnoreController"
import { RooProtectedController } from "../../protect/RooProtectedController"

vi.mock("fs", () => ({ lstatSync: vi.fn(), readFileSync: vi.fn() }))

const root = path.resolve("/test/workspace")
const file = (name: string) => path.join(root, name)
const metadata = (size: number, regular = true) => ({ size, isFile: () => regular }) as fs.Stats

beforeEach(() => {
	vi.resetAllMocks()
	vi.mocked(fs.lstatSync).mockReturnValue(metadata(12))
})

afterEach(() => {
	expect(fs.readFileSync).not.toHaveBeenCalled()
})

it("lists a 49 GB archive using metadata without reading its contents", () => {
	vi.mocked(fs.lstatSync).mockReturnValue(metadata(48_976_652_032))
	expect(formatResponse.formatFilesList(root, [file("large.zip")], false, undefined, false)).toBe(
		"large.zip  # 48976652032 bytes",
	)
	expect(fs.lstatSync).toHaveBeenCalledWith(file("large.zip"))
})

it("skips directories and never follows symlinks or opens special files", () => {
	vi.mocked(fs.lstatSync).mockReturnValue(metadata(0, false))
	const result = formatResponse.formatFilesList(
		root,
		[`${file("directory")}/`, file("link"), file("pipe"), file("device")],
		false,
		undefined,
		false,
	)
	expect(result).toContain("directory/")
	expect(result).not.toContain("bytes")
	expect(fs.lstatSync).toHaveBeenCalledTimes(3)
})

it("keeps inaccessible entries and the truncation notice", () => {
	vi.mocked(fs.lstatSync).mockImplementation(() => {
		throw new Error("ENOENT")
	})
	const result = formatResponse.formatFilesList(root, [file("gone.txt")], true, undefined, false)
	expect(result).toContain("gone.txt")
	expect(result).toContain("File list truncated")
	expect(result).not.toContain("bytes")
})

it("does not inspect ignored files and preserves protection annotations", () => {
	const ignored = { validateAccess: (p: string) => p !== file("secret.txt") } as RooIgnoreController
	const protectedFiles = new RooProtectedController(root)
	const result = formatResponse.formatFilesList(
		root,
		[file("secret.txt"), file("AGENTS.md"), file("plain.txt")],
		false,
		ignored,
		true,
		protectedFiles,
	)
	expect(result).toContain(`${LOCK_TEXT_SYMBOL} secret.txt`)
	expect(result).toContain("🛡️ AGENTS.md  # 12 bytes")
	expect(result).toContain("plain.txt  # 12 bytes")
	expect(fs.lstatSync).not.toHaveBeenCalledWith(file("secret.txt"))
})

it("reports bytes rather than character counts and handles empty files", () => {
	vi.mocked(fs.lstatSync).mockReturnValueOnce(metadata(0)).mockReturnValueOnce(metadata(6))
	const result = formatResponse.formatFilesList(
		root,
		[file("empty.txt"), file("unicode.txt")],
		false,
		undefined,
		false,
	)
	expect(result).toContain("empty.txt  # 0 bytes")
	expect(result).toContain("unicode.txt  # 6 bytes")
	expect(result).not.toContain("chars")
})
