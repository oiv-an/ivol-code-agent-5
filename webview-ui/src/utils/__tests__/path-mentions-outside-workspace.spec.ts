// kilocode_change - new file
import { convertToMentionPath } from "../path-mentions"

describe("convertToMentionPath with allowOutsideWorkspace", () => {
	const CWD = "/Users/test/project"

	it("keeps the legacy behaviour by default for paths outside the workspace", () => {
		expect(convertToMentionPath("/Users/other/notes.txt", CWD)).toBe("/Users/other/notes.txt")
	})

	it("turns outside absolute POSIX paths into mentions when enabled", () => {
		expect(convertToMentionPath("/Users/other/notes.txt", CWD, true)).toBe("@/Users/other/notes.txt")
	})

	it("escapes spaces for outside paths", () => {
		expect(convertToMentionPath("/Users/other/my notes.txt", CWD, true)).toBe("@/Users/other/my\\ notes.txt")
	})

	it("adds a leading slash to Windows drive paths so the mention regex matches", () => {
		expect(convertToMentionPath("D:\\data\\report.csv", "C:\\Users\\test\\project", true)).toBe(
			"@/D:/data/report.csv",
		)
	})

	it("still prefers workspace-relative mentions for files inside the workspace", () => {
		expect(convertToMentionPath("/Users/test/project/src/index.ts", CWD, true)).toBe("@/src/index.ts")
	})

	it("handles file:// URIs from drag and drop", () => {
		expect(convertToMentionPath("file:///Users/other/archive.zip", CWD, true)).toBe("@/Users/other/archive.zip")
	})

	it("produces a mention even when no workspace is open", () => {
		expect(convertToMentionPath("/Users/other/notes.txt", undefined, true)).toBe("@/Users/other/notes.txt")
	})
})
