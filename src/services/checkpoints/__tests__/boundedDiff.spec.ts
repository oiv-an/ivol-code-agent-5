// kilocode_change - new file
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { checkpointGit, DIFF_LIMITS, hasCheckpointChanges, readCheckpointDiff } from "../boundedDiff"

let repo: string
let base: string
const git = async (...args: string[]) => (await checkpointGit(repo, args)).toString().trim()
const commit = async () => {
	await git("add", ".")
	await git("commit", "-qm", "fixture")
	return git("rev-parse", "HEAD")
}

beforeEach(async () => {
	repo = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-checkpoint-"))
	await git("init", "-q")
	await git("config", "user.email", "fixture@example.com")
	await git("config", "user.name", "Fixture")
	await fs.writeFile(path.join(repo, "old.txt"), "before")
	base = await commit()
})
afterEach(async () => {
	vi.restoreAllMocks()
	await fs.rm(repo, { recursive: true, force: true })
})

it("preserves text additions/deletions, unusual paths, and read-only history comparisons", async () => {
	await fs.unlink(path.join(repo, "old.txt"))
	await fs.writeFile(path.join(repo, "new\tфайл.txt"), "after")
	const next = await commit()
	await fs.writeFile(path.join(repo, "untracked.txt"), "do not stage")
	const diff = await readCheckpointDiff(repo, repo, base, next)
	expect(diff.find((d) => d.paths.relative === "old.txt")?.content).toEqual({ before: "before", after: "" })
	expect(diff.find((d) => d.paths.relative === "new\tфайл.txt")?.content).toEqual({ before: "", after: "after" })
	expect(await git("status", "--porcelain")).toContain("?? untracked.txt")
	expect(await hasCheckpointChanges(repo, base, next)).toBe(true)
	expect(await hasCheckpointChanges(repo, base, base)).toBe(false)
})

it("omits oversized, binary, invalid UTF8 and symlink contents without implying deletion", async () => {
	await fs.writeFile(path.join(repo, "large.txt"), Buffer.alloc(DIFF_LIMITS.fileBytes + 1, 65))
	await fs.writeFile(path.join(repo, "binary.dat"), Buffer.from([1, 0, 2]))
	await fs.writeFile(path.join(repo, "invalid.txt"), Buffer.from([255, 254, 128]))
	await fs.symlink("old.txt", path.join(repo, "link.txt"))
	const next = await commit()
	const diff = await readCheckpointDiff(repo, repo, base, next)
	expect(diff).toHaveLength(4)
	for (const entry of diff) {
		expect(entry.omitted).toBeTruthy()
		expect(entry.content.before).toBe(entry.content.after)
		expect(entry.content.after).toContain("restore are unchanged")
	}
})

it("caps combined content and file count", async () => {
	for (let i = 0; i < 10; i++)
		await fs.writeFile(path.join(repo, `${i}.txt`), Buffer.alloc(DIFF_LIMITS.fileBytes, 65))
	for (let i = 0; i < 501; i++) await fs.writeFile(path.join(repo, `small-${i}.txt`), "x")
	const next = await commit()
	const diff = await readCheckpointDiff(repo, repo, base, next)
	expect(diff.length).toBeLessThanOrEqual(DIFF_LIMITS.files + 1)
	const textBytes = diff
		.filter((d) => !d.omitted)
		.reduce((n, d) => n + Buffer.byteLength(d.content.before) + Buffer.byteLength(d.content.after), 0)
	expect(textBytes).toBeLessThanOrEqual(DIFF_LIMITS.totalBytes)
	expect(diff.some((d) => d.omitted?.includes("8 MiB"))).toBe(true)
	expect(diff.at(-1)?.omitted).toContain("File count")
})

it("bounds output and honors cancellation", async () => {
	await expect(checkpointGit(repo, ["show", `${base}:old.txt`], undefined, 1)).rejects.toThrow()
	const abort = new AbortController()
	abort.abort()
	await expect(readCheckpointDiff(repo, repo, base, base, abort.signal)).rejects.toThrow()
})

it("reads modified working files with bounded reads", async () => {
	await fs.writeFile(path.join(repo, "old.txt"), "working")
	const diff = await readCheckpointDiff(repo, repo, base)
	expect(diff[0].content).toEqual({ before: "before", after: "working" })
	await fs.writeFile(path.join(repo, "old.txt"), Buffer.alloc(DIFF_LIMITS.fileBytes + 10))
	expect((await readCheckpointDiff(repo, repo, base))[0].omitted).toContain("1 MiB")
})
