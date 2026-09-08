// kilocode_change - task-isolated continuation snapshot storage regressions
import crypto from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as lockfile from "proper-lockfile"

import type { ApiMessage } from "../../task-persistence/apiMessages"
import {
	CONTEXT_HANDOFF_RELATIVE_PATH,
	CONTEXT_HANDOFF_ARCHIVE_DIRECTORY,
	attachContextHandoffToSummary,
	buildContextHandoffPrompt,
	deleteContextHandoffFileIfOwned,
	findPendingContextHandoff,
	hydratePendingContextHandoff,
	preflightContextHandoff,
	readTaskContextHandoff,
	redactPotentialSecrets,
	writeContextHandoffFile,
} from "../context-handoff"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, link: vi.fn(actual.link), open: vi.fn(actual.open) }
})

describe("context restart handoff", () => {
	const temporaryDirectories: string[] = []

	afterEach(async () => {
		vi.restoreAllMocks()
		await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })))
	})

	async function createWorkspace(): Promise<string> {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ivol-context-handoff-"))
		temporaryDirectories.push(workspace)
		return workspace
	}

	function archivePath(workspace: string, record: { handoffId: string; sha256: string }): string {
		return path.join(workspace, CONTEXT_HANDOFF_ARCHIVE_DIRECTORY, `${record.handoffId}.${record.sha256}.md`)
	}

	function writeSnapshot(workspacePath: string, taskId = "task-1", summary = "Task-specific continuation") {
		return writeContextHandoffFile({
			workspacePath,
			taskId,
			condenseId: crypto.randomUUID(),
			modelId: "gpt-test",
			summary,
			trigger: "automatic",
		})
	}

	function summaryMessage(condenseId: string, summary: string): ApiMessage {
		return {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "signed reasoning", signature: "signature" },
				{ type: "text", text: summary },
			],
			isSummary: true,
			condenseId,
			ts: 1,
		}
	}

	it("writes and verifies the fixed UTF-8 workspace file", async () => {
		const workspace = await createWorkspace()
		const summary = "## Current work\nРусский текст 🚀\n\n```ts\nconst ready = true\n```"

		const record = await writeContextHandoffFile({
			workspacePath: workspace,
			taskId: "task-1",
			condenseId: "condense-1",
			modelId: "gpt-test",
			summary,
			trigger: "automatic",
		})

		expect(record.relativePath).toBe(CONTEXT_HANDOFF_RELATIVE_PATH)
		expect(record.absolutePath).toBe(path.join(workspace, "CONTEXT_RESTART.md"))
		expect(record.body).toBe(summary)
		expect(await fs.readFile(record.absolutePath, "utf8")).toBe(record.content)
		expect(record.content).toContain(summary)
		expect(record.content).toContain("read it before any other project file")
		expect(await fs.readFile(path.join(workspace, ".gitignore"), "utf8")).toContain("/CONTEXT_RESTART.md")
		expect((await fs.readdir(workspace)).sort()).toEqual([
			".gitignore",
			CONTEXT_HANDOFF_ARCHIVE_DIRECTORY,
			"CONTEXT_RESTART.md",
		])
		expect(await fs.readFile(archivePath(workspace, record), "utf8")).toBe(record.content)
		expect(await fs.readFile(path.join(workspace, ".gitignore"), "utf8")).toContain(
			`/${CONTEXT_HANDOFF_ARCHIVE_DIRECTORY}/`,
		)
		if (process.platform !== "win32") {
			expect((await fs.lstat(record.absolutePath)).mode & 0o777).toBe(0o600)
		}
	})

	it("atomically adds the handoff rule to an existing local ignore file without losing its content", async () => {
		const workspace = await createWorkspace()
		const directoryPath = workspace
		const ignorePath = path.join(directoryPath, ".gitignore")
		await fs.writeFile(ignorePath, "# user-owned rules\n/CONTEXT_RESTART.md\n", "utf8")
		await fs.chmod(ignorePath, 0o664)

		await writeContextHandoffFile({
			workspacePath: workspace,
			taskId: "task-1",
			condenseId: "condense-1",
			modelId: "gpt-test",
			summary: "summary",
			trigger: "automatic",
		})

		const ignoreContent = await fs.readFile(ignorePath, "utf8")
		expect(ignoreContent.startsWith("# user-owned rules\n")).toBe(true)
		expect(ignoreContent.split(/\r?\n/)).toContain("/CONTEXT_RESTART.md")
		expect(ignoreContent.split(/\r?\n/)).toContain("/CONTEXT_RESTART.md.*.tmp")
		expect(ignoreContent.split(/\r?\n/)).toContain("/CONTEXT_RESTART.md.lock")
		expect(ignoreContent.match(/^\/CONTEXT_RESTART.md$/gm)).toHaveLength(1)
		if (process.platform !== "win32") {
			expect((await fs.stat(ignorePath)).mode & 0o777).toBe(0o664)
		}
		expect((await fs.readdir(directoryPath)).filter((entry) => entry.includes(".gitignore."))).toEqual([])
	})

	it("does not overwrite a user-owned file at the reserved path", async () => {
		const workspace = await createWorkspace()
		const filePath = path.join(workspace, CONTEXT_HANDOFF_RELATIVE_PATH)
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, "my own notes", "utf8")

		await expect(
			writeContextHandoffFile({
				workspacePath: workspace,
				taskId: "task-1",
				condenseId: "condense-1",
				modelId: "gpt-test",
				summary: "summary",
				trigger: "manual",
			}),
		).rejects.toThrow("was not created by IVOL Code")
		expect(await fs.readFile(filePath, "utf8")).toBe("my own notes")
	})

	it("archives the exact prior task before replacing a managed handoff", async () => {
		const workspace = await createWorkspace()
		const first = await writeContextHandoffFile({
			workspacePath: workspace,
			taskId: "task-1",
			condenseId: "condense-1",
			modelId: "gpt-test",
			summary: "first pending summary",
			trigger: "automatic",
		})

		const second = await writeContextHandoffFile({
			workspacePath: workspace,
			taskId: "task-2",
			condenseId: "condense-2",
			modelId: "gpt-test",
			summary: "second pending summary",
			trigger: "automatic",
		})
		expect(await fs.readFile(first.absolutePath, "utf8")).toBe(second.content)
		expect(await fs.readFile(archivePath(workspace, first), "utf8")).toBe(first.content)
		expect(await fs.readFile(archivePath(workspace, second), "utf8")).toBe(second.content)
	})

	it("rejects symbolic links and non-regular files at the reserved path", async () => {
		if (process.platform === "win32") {
			return
		}

		const workspace = await createWorkspace()
		const filePath = path.join(workspace, CONTEXT_HANDOFF_RELATIVE_PATH)
		const outsideFile = path.join(workspace, "outside-notes.md")
		await fs.writeFile(outsideFile, "must stay unchanged", "utf8")
		await fs.symlink(outsideFile, filePath)

		await expect(
			writeContextHandoffFile({
				workspacePath: workspace,
				taskId: "task-1",
				condenseId: "condense-1",
				modelId: "gpt-test",
				summary: "summary",
				trigger: "automatic",
			}),
		).rejects.toThrow("symbolic link or non-regular file")
		expect(await fs.readFile(outsideFile, "utf8")).toBe("must stay unchanged")

		await fs.unlink(filePath)
		await fs.mkdir(filePath)
		await expect(
			writeContextHandoffFile({
				workspacePath: workspace,
				taskId: "task-1",
				condenseId: "condense-2",
				modelId: "gpt-test",
				summary: "summary",
				trigger: "automatic",
			}),
		).rejects.toThrow("symbolic link or non-regular file")
	})

	it("rejects a symbolic workspace directory instead of writing through it", async () => {
		if (process.platform === "win32") {
			return
		}

		const workspace = await createWorkspace()
		const outsideDirectory = await createWorkspace()
		const linkedWorkspace = path.join(workspace, "linked-project")
		await fs.symlink(outsideDirectory, linkedWorkspace)

		await expect(
			writeContextHandoffFile({
				workspacePath: linkedWorkspace,
				taskId: "task-1",
				condenseId: "condense-1",
				modelId: "gpt-test",
				summary: "summary",
				trigger: "automatic",
			}),
		).rejects.toThrow("symbolic link or non-directory")
	})

	it("waits for an interprocess lock even when the target does not exist yet", async () => {
		const workspace = await createWorkspace()
		const filePath = path.join(workspace, CONTEXT_HANDOFF_RELATIVE_PATH)
		const release = await lockfile.lock(filePath, { realpath: false })
		let released = false
		let settled = false

		try {
			const writePromise = writeContextHandoffFile({
				workspacePath: workspace,
				taskId: "task-1",
				condenseId: "condense-1",
				modelId: "gpt-test",
				summary: "summary",
				trigger: "automatic",
			}).then((record) => {
				settled = true
				return record
			})

			await new Promise((resolve) => setTimeout(resolve, 75))
			expect(settled).toBe(false)
			await release()
			released = true
			await expect(writePromise).resolves.toMatchObject({ body: "summary" })
		} finally {
			if (!released) {
				await release()
			}
		}
	})

	it("serializes concurrent writers and preserves every task's independent snapshot", async () => {
		const workspace = await createWorkspace()
		const results = await Promise.allSettled(
			["A".repeat(20_000), "B".repeat(20_000), "C".repeat(20_000)].map((summary, index) =>
				writeContextHandoffFile({
					workspacePath: workspace,
					taskId: `task-${index}`,
					condenseId: `condense-${index}`,
					modelId: "gpt-test",
					summary,
					trigger: "automatic",
				}),
			),
		)
		const finalContent = await fs.readFile(path.join(workspace, CONTEXT_HANDOFF_RELATIVE_PATH), "utf8")
		const fulfilled = results.filter(
			(result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof writeContextHandoffFile>>> =>
				result.status === "fulfilled",
		)
		const rejected = results.filter((result) => result.status === "rejected")

		expect(fulfilled).toHaveLength(3)
		expect(rejected).toHaveLength(0)
		expect(fulfilled.map((result) => result.value.content)).toContain(finalContent)
		for (const { value: record } of fulfilled) {
			expect(await fs.readFile(archivePath(workspace, record), "utf8")).toBe(record.content)
			expect(await readTaskContextHandoff({ workspacePath: workspace, ...record })).toBe(record.content)
		}
		expect((await fs.readdir(workspace)).sort()).toEqual([
			".gitignore",
			CONTEXT_HANDOFF_ARCHIVE_DIRECTORY,
			"CONTEXT_RESTART.md",
		])
	})

	it("preflights safely without reserving root ownership or leaving probe files", async () => {
		const workspace = await createWorkspace()
		await preflightContextHandoff(workspace)
		await expect(fs.stat(path.join(workspace, CONTEXT_HANDOFF_RELATIVE_PATH))).rejects.toMatchObject({
			code: "ENOENT",
		})
		expect(await fs.readdir(path.join(workspace, CONTEXT_HANDOFF_ARCHIVE_DIRECTORY))).toEqual([])
		const first = await writeSnapshot(workspace)
		await preflightContextHandoff(workspace)
		expect(await fs.readFile(first.absolutePath, "utf8")).toBe(first.content)
		expect(await fs.readdir(path.join(workspace, CONTEXT_HANDOFF_ARCHIVE_DIRECTORY))).toEqual([
			path.basename(archivePath(workspace, first)),
		])
	})

	it("preflight rejects unmanaged root content before any model work", async () => {
		const workspace = await createWorkspace()
		const rootPath = path.join(workspace, CONTEXT_HANDOFF_RELATIVE_PATH)
		await fs.writeFile(rootPath, "important user notes")
		await expect(preflightContextHandoff(workspace)).rejects.toThrow("was not created by IVOL Code")
		expect(await fs.readFile(rootPath, "utf8")).toBe("important user notes")
	})

	it("rechecks root ownership when committing after a successful preflight", async () => {
		const workspace = await createWorkspace()
		await preflightContextHandoff(workspace)
		const rootPath = path.join(workspace, CONTEXT_HANDOFF_RELATIVE_PATH)
		await fs.writeFile(rootPath, "notes added while the model prepared its summary")
		await expect(writeSnapshot(workspace)).rejects.toThrow("was not created by IVOL Code")
		expect(await fs.readFile(rootPath, "utf8")).toBe("notes added while the model prepared its summary")
	})

	it("preserves a v230 root-only snapshot exactly before a new task rotates it", async () => {
		const workspace = await createWorkspace()
		const legacy = await writeSnapshot(workspace, "task-old", "Previous version's pending work")
		await fs.unlink(archivePath(workspace, legacy))
		await writeSnapshot(workspace, "task-new")
		expect(await fs.readFile(archivePath(workspace, legacy), "utf8")).toBe(legacy.content)
		expect(await readTaskContextHandoff({ workspacePath: workspace, ...legacy })).toBe(legacy.content)
	})

	it("supports another condensation in the same task without losing the earlier revision", async () => {
		const workspace = await createWorkspace()
		const first = await writeSnapshot(workspace, "same-task", "first checkpoint")
		const second = await writeSnapshot(workspace, "same-task", "second checkpoint")
		expect(first.handoffId).not.toBe(second.handoffId)
		expect(await readTaskContextHandoff({ workspacePath: workspace, ...first })).toBe(first.content)
		expect(await readTaskContextHandoff({ workspacePath: workspace, ...second })).toBe(second.content)
		await deleteContextHandoffFileIfOwned({
			workspacePath: workspace,
			handoffId: first.handoffId,
			sha256: first.sha256,
		})
		expect(await fs.readFile(second.absolutePath, "utf8")).toBe(second.content)
		expect(await fs.readFile(archivePath(workspace, second), "utf8")).toBe(second.content)
		await expect(fs.stat(archivePath(workspace, first))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("preserves managed user edits as a separate immutable revision when rotating the root", async () => {
		const workspace = await createWorkspace()
		const first = await writeSnapshot(workspace)
		const editedContent = `${first.content}\nImportant user correction, preserve it exactly.\n`
		const editedHash = crypto.createHash("sha256").update(editedContent).digest("hex")
		await fs.writeFile(first.absolutePath, editedContent)
		const second = await writeSnapshot(workspace, "task-2")
		expect(
			await fs.readFile(archivePath(workspace, { handoffId: first.handoffId, sha256: editedHash }), "utf8"),
		).toBe(editedContent)
		await deleteContextHandoffFileIfOwned({
			workspacePath: workspace,
			handoffId: first.handoffId,
			sha256: first.sha256,
		})
		expect(
			await fs.readFile(archivePath(workspace, { handoffId: first.handoffId, sha256: editedHash }), "utf8"),
		).toBe(editedContent)
		expect(await fs.readFile(second.absolutePath, "utf8")).toBe(second.content)
	})

	it("does not delete an edited root or edited archive when consuming an original hash", async () => {
		const workspace = await createWorkspace()
		const record = await writeSnapshot(workspace)
		const editedContent = `${record.content}\nUser changes`
		await fs.writeFile(record.absolutePath, editedContent)
		await fs.writeFile(archivePath(workspace, record), editedContent)
		expect(
			await deleteContextHandoffFileIfOwned({
				workspacePath: workspace,
				handoffId: record.handoffId,
				sha256: record.sha256,
			}),
		).toBe(false)
		expect(await fs.readFile(record.absolutePath, "utf8")).toBe(editedContent)
		expect(await fs.readFile(archivePath(workspace, record), "utf8")).toBe(editedContent)
	})

	it("does not overwrite a corrupted archive while rotating the root", async () => {
		const workspace = await createWorkspace()
		const first = await writeSnapshot(workspace)
		await fs.writeFile(archivePath(workspace, first), "user-modified archive")
		await expect(preflightContextHandoff(workspace)).rejects.toThrow("integrity verification")
		await expect(writeSnapshot(workspace, "task-2")).rejects.toThrow("integrity verification")
		expect(await fs.readFile(first.absolutePath, "utf8")).toBe(first.content)
		expect(await fs.readFile(archivePath(workspace, first), "utf8")).toBe("user-modified archive")
	})

	it("falls back only to its own verified embedded snapshot when archive data is damaged", async () => {
		const workspace = await createWorkspace()
		const first = await writeSnapshot(workspace, "task-a", "A private task state")
		const second = await writeSnapshot(workspace, "task-b", "B private task state")
		await fs.writeFile(archivePath(workspace, first), second.content)
		expect(await readTaskContextHandoff({ workspacePath: workspace, ...first })).toBe(first.content)
		await expect(
			readTaskContextHandoff({ workspacePath: workspace, ...first, content: second.content }),
		).rejects.toThrow("integrity verification")
		expect(await fs.readFile(second.absolutePath, "utf8")).toBe(second.content)
	})

	it("uses an intact own archive even when the embedded snapshot is damaged", async () => {
		const workspace = await createWorkspace()
		const first = await writeSnapshot(workspace, "task-a")
		await writeSnapshot(workspace, "task-b")
		expect(
			await readTaskContextHandoff({ workspacePath: workspace, ...first, content: "damaged history snapshot" }),
		).toBe(first.content)
	})

	it("keeps the correct task read after another window rotates the hydrated root", async () => {
		const workspace = await createWorkspace()
		const first = await writeSnapshot(workspace, "task-a", "Continue task A only")
		const messages = attachContextHandoffToSummary([summaryMessage("condense-a", first.body)], "condense-a", first)
		expect((await hydratePendingContextHandoff({ messages, workspacePath: workspace })).fileReady).toBe(true)
		const second = await writeSnapshot(workspace, "task-b", "Continue task B only")
		expect(await readTaskContextHandoff({ workspacePath: workspace, ...first })).toBe(first.content)
		expect(await fs.readFile(second.absolutePath, "utf8")).toBe(second.content)
		expect((await hydratePendingContextHandoff({ messages, workspacePath: workspace })).fileReady).toBe(true)
	})

	it.each(["../outside", "a/b", "a".repeat(200), "00000000-0000-0000-0000-00000000000x"])(
		"rejects unsafe snapshot identity %s",
		async (handoffId) => {
			const workspace = await createWorkspace()
			await expect(
				writeContextHandoffFile({
					workspacePath: workspace,
					taskId: "task",
					condenseId: "condense",
					modelId: "gpt-test",
					summary: "summary",
					trigger: "manual",
					handoffId,
				}),
			).rejects.toThrow("ownership metadata")
			await expect(
				readTaskContextHandoff({
					workspacePath: workspace,
					handoffId,
					sha256: "a".repeat(64),
					content: "invalid",
				}),
			).rejects.toThrow("identity metadata")
			expect(
				await deleteContextHandoffFileIfOwned({ workspacePath: workspace, handoffId, sha256: "a".repeat(64) }),
			).toBe(false)
		},
	)

	it("fails preflight and commit when atomic archive publication is unavailable", async () => {
		const workspace = await createWorkspace()
		const first = await writeSnapshot(workspace)
		vi.spyOn(fs, "link").mockRejectedValue(
			Object.assign(new Error("Archive writes are denied"), { code: "EACCES" }),
		)
		await expect(preflightContextHandoff(workspace)).rejects.toThrow("Archive writes are denied")
		await expect(writeSnapshot(workspace, "task-2")).rejects.toThrow("Archive writes are denied")
		expect(await fs.readFile(first.absolutePath, "utf8")).toBe(first.content)
		expect(await fs.readdir(path.join(workspace, CONTEXT_HANDOFF_ARCHIVE_DIRECTORY))).toEqual([
			path.basename(archivePath(workspace, first)),
		])
	})

	it("does not publish a new root when the archived snapshot fails read-back verification", async () => {
		const workspace = await createWorkspace()
		const first = await writeSnapshot(workspace)
		vi.spyOn(fs, "link").mockImplementation(async (_source, target) => {
			await fs.writeFile(target, "damaged archive bytes", { flag: "wx" })
		})
		await expect(writeSnapshot(workspace, "task-2")).rejects.toThrow("read-back verification")
		expect(await fs.readFile(first.absolutePath, "utf8")).toBe(first.content)
		expect(await fs.readFile(archivePath(workspace, first), "utf8")).toBe(first.content)
	})

	it("does not overwrite a root edited externally while its replacement is archived", async () => {
		const workspace = await createWorkspace()
		const first = await writeSnapshot(workspace)
		const realFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const editedContent = `${first.content}\nNew user notes while the writer was running`
		vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
			await realFs.writeFile(first.absolutePath, editedContent)
			await realFs.link(source, target)
		})
		await expect(writeSnapshot(workspace, "task-2")).rejects.toThrow("changed while its replacement was prepared")
		expect(await fs.readFile(first.absolutePath, "utf8")).toBe(editedContent)
		expect(await fs.readFile(archivePath(workspace, first), "utf8")).toBe(first.content)
		expect((await fs.readdir(workspace)).filter((name) => name.endsWith(".tmp"))).toEqual([])
	})

	it.each(["after-open", "during-link"])(
		"fails closed when the archive directory is swapped %s and does not unlink foreign temporaries",
		async (phase) => {
			if (process.platform === "win32") return
			const workspace = await createWorkspace()
			const outside = await createWorkspace()
			const first = await writeSnapshot(workspace)
			const directoryPath = path.join(workspace, CONTEXT_HANDOFF_ARCHIVE_DIRECTORY)
			const realFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
			let foreignTemporaryPath: string | undefined
			const swapDirectory = async (temporaryPath: string) => {
				await realFs.rename(directoryPath, `${directoryPath}-preserved`)
				await realFs.symlink(outside, directoryPath)
				foreignTemporaryPath = path.join(outside, path.basename(temporaryPath))
				await realFs.writeFile(foreignTemporaryPath, "foreign temporary content must remain")
			}
			if (phase === "after-open") {
				vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
					const handle = await realFs.open(filePath, flags, mode)
					if (
						String(filePath).startsWith(`${directoryPath}${path.sep}`) &&
						String(filePath).endsWith(".tmp")
					) {
						await swapDirectory(String(filePath))
					}
					return handle
				})
			} else {
				vi.spyOn(fs, "link").mockImplementation(async (source) => swapDirectory(String(source)))
			}
			await expect(writeSnapshot(workspace, "task-2")).rejects.toThrow("directory changed")
			expect(foreignTemporaryPath).toBeDefined()
			expect(await realFs.readFile(foreignTemporaryPath!, "utf8")).toBe("foreign temporary content must remain")
			expect(await realFs.readFile(first.absolutePath, "utf8")).toBe(first.content)
			expect(await realFs.readdir(outside)).toEqual([path.basename(foreignTemporaryPath!)])
		},
	)

	it("detects an archive directory replaced by another regular directory before link completion", async () => {
		const workspace = await createWorkspace()
		const first = await writeSnapshot(workspace)
		const directoryPath = path.join(workspace, CONTEXT_HANDOFF_ARCHIVE_DIRECTORY)
		const realFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.spyOn(fs, "link").mockImplementation(async () => {
			await realFs.rename(directoryPath, `${directoryPath}-preserved`)
			await realFs.mkdir(directoryPath)
		})
		await expect(writeSnapshot(workspace, "task-2")).rejects.toThrow("directory changed")
		expect(await fs.readFile(first.absolutePath, "utf8")).toBe(first.content)
		expect(await fs.readdir(directoryPath)).toEqual([])
	})

	it("keeps a root changed between the first ownership check and cleanup's read-back", async () => {
		const workspace = await createWorkspace()
		const record = await writeSnapshot(workspace)
		const realFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const edited = `${record.content}\nUser edits made during cleanup`
		let rootOpens = 0
		vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
			if (String(filePath) === record.absolutePath && ++rootOpens === 2) {
				await realFs.writeFile(record.absolutePath, edited)
			}
			return realFs.open(filePath, flags, mode)
		})
		expect(
			await deleteContextHandoffFileIfOwned({
				workspacePath: workspace,
				handoffId: record.handoffId,
				sha256: record.sha256,
			}),
		).toBe(false)
		expect(await realFs.readFile(record.absolutePath, "utf8")).toBe(edited)
	})

	it("rejects oversized visible and new snapshots without loading or replacing them", async () => {
		const workspace = await createWorkspace()
		const first = await writeSnapshot(workspace)
		const huge = `${first.content}${"X".repeat(2 * 1024 * 1024)}`
		await fs.writeFile(first.absolutePath, huge)
		await expect(preflightContextHandoff(workspace)).rejects.toThrow("2 MiB safety limit")
		await expect(writeSnapshot(workspace, "task-2")).rejects.toThrow("2 MiB safety limit")
		expect((await fs.stat(first.absolutePath)).size).toBe(Buffer.byteLength(huge))
		await fs.writeFile(first.absolutePath, first.content)
		await expect(writeSnapshot(workspace, "task-2", "X".repeat(2 * 1024 * 1024))).rejects.toThrow(
			"2 MiB safety limit",
		)
		expect(await fs.readFile(first.absolutePath, "utf8")).toBe(first.content)
	})

	it("handles long unbroken model output without quadratic credential-prefix scanning", () => {
		const longWord = "X".repeat(500_000)
		const input = `${longWord}\nOPENAI_API_KEY=opaque-secret\nhttps://user:password-value@example.test\nopenAiApiKey=camel-secret\n"proxyPassword": "camel-password"\n`
		const output = redactPotentialSecrets(input)
		expect(output.startsWith(longWord)).toBe(true)
		expect(output).not.toContain("opaque-secret")
		expect(output).not.toContain("password-value")
		expect(output).not.toContain("camel-secret")
		expect(output).not.toContain("camel-password")
	})

	it.each(["archive-directory", "root-lock", "archive-file"])(
		"rejects symbolic links for %s without touching their target",
		async (kind) => {
			if (process.platform === "win32") return
			const workspace = await createWorkspace()
			const outside = await createWorkspace()
			const first = await writeSnapshot(workspace)
			if (kind === "archive-directory") {
				await fs.rename(
					path.join(workspace, CONTEXT_HANDOFF_ARCHIVE_DIRECTORY),
					path.join(workspace, "preserved-archives"),
				)
				await fs.symlink(outside, path.join(workspace, CONTEXT_HANDOFF_ARCHIVE_DIRECTORY))
			} else if (kind === "root-lock") {
				await fs.symlink(outside, `${first.absolutePath}.lock`)
			} else {
				const outsideFile = path.join(outside, "important.md")
				await fs.writeFile(outsideFile, "Do not touch")
				await fs.unlink(archivePath(workspace, first))
				await fs.symlink(outsideFile, archivePath(workspace, first))
			}
			await expect(preflightContextHandoff(workspace)).rejects.toThrow("symbolic link")
			await expect(writeSnapshot(workspace, "task-2")).rejects.toThrow("symbolic link")
			expect(await fs.readFile(first.absolutePath, "utf8")).toBe(first.content)
			expect(await fs.readdir(outside)).toEqual(kind === "archive-file" ? ["important.md"] : [])
			if (kind === "archive-file")
				expect(await fs.readFile(path.join(outside, "important.md"), "utf8")).toBe("Do not touch")
		},
	)

	it("redacts raw credentials before placing the model state in the workspace", async () => {
		const workspace = await createWorkspace()
		const knownSecret = "custom:proxy/credential+with=punctuation"
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature_value"
		const privateKey = "-----BEGIN PRIVATE KEY-----\nvery-secret-key-material\n-----END PRIVATE KEY-----"
		const opaqueBearer = "opaque-token-that-does-not-match-a-provider-prefix"
		const opaqueBasic = "dXNlcjpwYXNzd29yZA=="
		const githubToken = "github_pat_11AA22BB33CC44DD55EE66FF77GG88HH"
		const npmToken = "npm_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8"
		const awsTemporaryAccessKey = "ASIA1234567890ABCDEF"
		const record = await writeContextHandoffFile({
			workspacePath: workspace,
			taskId: "task-1",
			condenseId: "condense-1",
			modelId: "gpt-test",
			summary: [
				"Configured ivol-managed-0000000000000000000000000000000000000000.",
				'JSON: "password": "quoted-password-value"',
				"OPENAI_API_KEY=opaque-proxy-value",
				"refresh_token='refresh-token-value'",
				"Cookie: session=session-cookie-value; csrf=csrf-value",
				`Authorization: Bearer ${opaqueBearer}`,
				`Authorization: Basic ${opaqueBasic}`,
				`GitHub: ${githubToken}`,
				`npm: ${npmToken}`,
				`AWS: ${awsTemporaryAccessKey}`,
				`JWT: ${jwt}`,
				privateKey,
				`Known: ${knownSecret}`,
			].join("\n"),
			trigger: "automatic",
			knownSecrets: [knownSecret],
		})

		expect(record.content).not.toContain("ivol-managed-0000000000000000000000000000000000000000")
		expect(record.content).not.toContain("quoted-password-value")
		expect(record.content).not.toContain("opaque-proxy-value")
		expect(record.content).not.toContain("refresh-token-value")
		expect(record.content).not.toContain("session-cookie-value")
		expect(record.content).not.toContain(opaqueBearer)
		expect(record.content).not.toContain(opaqueBasic)
		expect(record.content).not.toContain(githubToken)
		expect(record.content).not.toContain(npmToken)
		expect(record.content).not.toContain(awsTemporaryAccessKey)
		expect(record.content).not.toContain(jwt)
		expect(record.content).not.toContain("very-secret-key-material")
		expect(record.content).not.toContain(knownSecret)
		expect(record.body).not.toContain(knownSecret)
		expect(record.content).toContain("[REDACTED_SECRET]")
	})

	it("does not treat very short known values as secrets", async () => {
		const workspace = await createWorkspace()
		const record = await writeContextHandoffFile({
			workspacePath: workspace,
			taskId: "task-1",
			condenseId: "condense-1",
			modelId: "gpt-test",
			summary: "a valid continuation",
			trigger: "automatic",
			knownSecrets: ["a"],
		})

		expect(record.body).toBe("a valid continuation")
	})

	it("clears only the file owned by the completed handoff", async () => {
		const workspace = await createWorkspace()
		const record = await writeContextHandoffFile({
			workspacePath: workspace,
			taskId: "task-1",
			condenseId: "condense-1",
			modelId: "gpt-test",
			summary: "summary",
			trigger: "automatic",
		})

		expect(await deleteContextHandoffFileIfOwned({ workspacePath: workspace, handoffId: "another-handoff" })).toBe(
			false,
		)
		expect(await fs.readFile(record.absolutePath, "utf8")).toBe(record.content)
		expect(await deleteContextHandoffFileIfOwned({ workspacePath: workspace, handoffId: record.handoffId })).toBe(
			true,
		)
		await expect(fs.readFile(record.absolutePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
		expect((await fs.readdir(path.dirname(record.absolutePath))).sort()).toEqual([
			".gitignore",
			CONTEXT_HANDOFF_ARCHIVE_DIRECTORY,
		])
		expect(await fs.readdir(path.join(workspace, CONTEXT_HANDOFF_ARCHIVE_DIRECTORY))).toEqual([])
	})

	it("attaches the verified file without changing signed thinking blocks", async () => {
		const workspace = await createWorkspace()
		const source = summaryMessage("condense-1", "summary")
		const record = await writeContextHandoffFile({
			workspacePath: workspace,
			taskId: "task-1",
			condenseId: "condense-1",
			modelId: "claude-test",
			summary: "summary",
			trigger: "manual",
		})

		const sourceMessages = [source]
		const attached = attachContextHandoffToSummary(sourceMessages, "condense-1", record)
		const content = attached[0].content as any[]
		expect(attached).not.toBe(sourceMessages)
		expect((source.content as any[])[1].text).toBe("summary")
		expect(content[0]).toEqual({ type: "thinking", thinking: "signed reasoning", signature: "signature" })
		expect(content[1]).toEqual({ type: "text", text: record.body })
		expect(attached[0].contextHandoffContent).toBe(record.content)
		expect(attached[0].contextHandoffConsumedAt).toBeUndefined()
	})

	it("resumes a legacy handoff at the project root and retires its identical old copy only after consumption", async () => {
		const workspace = await createWorkspace()
		const record = await writeContextHandoffFile({
			workspacePath: workspace,
			taskId: "task-legacy",
			condenseId: "condense-legacy",
			modelId: "gpt-test",
			summary: "Verified continuation from the previous plugin version",
			trigger: "manual",
		})
		const legacyPath = path.join(workspace, ".ivol-code", "CONTEXT_RESTART.md")
		await fs.mkdir(path.dirname(legacyPath))
		await fs.rename(record.absolutePath, legacyPath)
		const messages = attachContextHandoffToSummary(
			[summaryMessage("condense-legacy", record.body)],
			"condense-legacy",
			{ ...record, relativePath: ".ivol-code/CONTEXT_RESTART.md" },
		)
		const hydrated = await hydratePendingContextHandoff({ messages, workspacePath: workspace })
		expect(hydrated.fileReady).toBe(true)
		expect(await fs.readFile(path.join(workspace, "CONTEXT_RESTART.md"), "utf8")).toBe(record.content)
		expect(await fs.readFile(legacyPath, "utf8")).toBe(record.content)
		await deleteContextHandoffFileIfOwned({ workspacePath: workspace, handoffId: record.handoffId })
		await expect(fs.stat(record.absolutePath)).rejects.toMatchObject({ code: "ENOENT" })
		await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("does not remove edited or unrelated legacy notes while consuming the root handoff", async () => {
		const workspace = await createWorkspace()
		const record = await writeContextHandoffFile({
			workspacePath: workspace,
			taskId: "task-1",
			condenseId: "condense-1",
			modelId: "gpt-test",
			summary: "Verified continuation",
			trigger: "manual",
		})
		const legacyPath = path.join(workspace, ".ivol-code", "CONTEXT_RESTART.md")
		await fs.mkdir(path.dirname(legacyPath))
		const editedContent = `${record.content}\nUser added an important note`
		await fs.writeFile(legacyPath, editedContent)
		await deleteContextHandoffFileIfOwned({ workspacePath: workspace, handoffId: record.handoffId })
		expect(await fs.readFile(legacyPath, "utf8")).toBe(editedContent)
	})

	it("writes into the selected nested project root, not its parent", async () => {
		const workspace = await createWorkspace()
		const project = path.join(workspace, "current-project")
		await fs.mkdir(project)
		const record = await writeContextHandoffFile({
			workspacePath: project,
			taskId: "task-1",
			condenseId: "condense-1",
			modelId: "gpt-test",
			summary: "Nested project continuation",
			trigger: "manual",
		})
		expect(record.absolutePath).toBe(path.join(project, "CONTEXT_RESTART.md"))
		expect((await fs.readdir(workspace)).sort()).toEqual(["current-project"])
	})

	it("injects the correct snapshot without replacing another task's pending workspace file", async () => {
		const sourceWorkspace = await createWorkspace()
		const targetWorkspace = await createWorkspace()
		const recordA = await writeContextHandoffFile({
			workspacePath: sourceWorkspace,
			taskId: "task-a",
			condenseId: "condense-a",
			modelId: "gpt-a",
			summary: "A continuation state",
			trigger: "automatic",
		})
		const messagesA = attachContextHandoffToSummary(
			[summaryMessage("condense-a", "A continuation state")],
			"condense-a",
			recordA,
		)

		const recordB = await writeContextHandoffFile({
			workspacePath: targetWorkspace,
			taskId: "task-b",
			condenseId: "condense-b",
			modelId: "gpt-b",
			summary: "B continuation state",
			trigger: "automatic",
		})
		const messagesB = attachContextHandoffToSummary(
			[summaryMessage("condense-b", "B continuation state")],
			"condense-b",
			recordB,
		)

		const hydratedA = await hydratePendingContextHandoff({ messages: messagesA, workspacePath: targetWorkspace })
		expect(hydratedA.handoffId).toBe(recordA.handoffId)
		expect(hydratedA.fileReady).toBe(false)
		expect((messagesA[0].content as any[])[1].text).toBe(recordA.body)
		expect((hydratedA.messages[0].content as any[])[1].text).toBe(recordA.content)
		expect(await fs.readFile(path.join(targetWorkspace, CONTEXT_HANDOFF_RELATIVE_PATH), "utf8")).toBe(
			recordB.content,
		)

		const hydratedB = await hydratePendingContextHandoff({ messages: messagesB, workspacePath: targetWorkspace })
		expect(hydratedB.handoffId).toBe(recordB.handoffId)
		expect(hydratedB.fileReady).toBe(true)
		expect((messagesB[0].content as any[])[1].text).toBe(recordB.body)
		expect((hydratedB.messages[0].content as any[])[1].text).toBe(recordB.content)
	})

	it("never restores or injects a tampered embedded snapshot", async () => {
		const workspace = await createWorkspace()
		const record = await writeContextHandoffFile({
			workspacePath: workspace,
			taskId: "task-1",
			condenseId: "condense-1",
			modelId: "gpt-test",
			summary: "verified continuation",
			trigger: "automatic",
		})
		const messages = attachContextHandoffToSummary(
			[summaryMessage("condense-1", "verified continuation")],
			"condense-1",
			record,
		)
		messages[0].contextHandoffContent = record.content.replace("verified continuation", "tampered instructions")
		await fs.unlink(record.absolutePath)
		await fs.unlink(archivePath(workspace, record))

		const hydrated = await hydratePendingContextHandoff({ messages, workspacePath: workspace })
		expect(hydrated.handoffId).toBeUndefined()
		expect((hydrated.messages[0].content as any[])[1].text).toBe(record.body)
		expect((hydrated.messages[0].content as any[])[1].text).not.toContain("tampered instructions")
		await expect(fs.readFile(record.absolutePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("ignores stale files unless an effective summary is pending", async () => {
		const workspace = await createWorkspace()
		await writeContextHandoffFile({
			workspacePath: workspace,
			taskId: "old-task",
			condenseId: "old-condense",
			modelId: "gpt-test",
			summary: "stale",
			trigger: "automatic",
		})

		const messages: ApiMessage[] = [{ role: "user", content: "new task" }]
		const hydrated = await hydratePendingContextHandoff({ messages, workspacePath: workspace })
		expect(hydrated).toEqual({ messages })
	})

	it("stops selecting a handoff after its first continuation is consumed", () => {
		const messages: ApiMessage[] = [
			{
				...summaryMessage("condense-1", "summary"),
				contextHandoffId: "handoff-1",
				contextHandoffPath: CONTEXT_HANDOFF_RELATIVE_PATH,
				contextHandoffSha256: "hash",
				contextHandoffContent: "full snapshot",
				contextHandoffConsumedAt: Date.now(),
			},
		]
		expect(findPendingContextHandoff(messages)).toBeUndefined()
	})

	it("injects the complete document once while retaining only the body in persisted history", async () => {
		const workspace = await createWorkspace()
		const record = await writeContextHandoffFile({
			workspacePath: workspace,
			taskId: "task-1",
			condenseId: "condense-1",
			modelId: "gpt-test",
			summary: "body-only continuation",
			trigger: "automatic",
		})
		const persisted = attachContextHandoffToSummary(
			[summaryMessage("condense-1", "body-only continuation")],
			"condense-1",
			record,
		)

		const firstRequest = await hydratePendingContextHandoff({ messages: persisted, workspacePath: workspace })
		expect(firstRequest.fileReady).toBe(true)
		expect((firstRequest.messages[0].content as any[])[1].text).toBe(record.content)
		expect((persisted[0].content as any[])[1].text).toBe(record.body)

		persisted[0].contextHandoffConsumedAt = Date.now()
		const secondRequest = await hydratePendingContextHandoff({ messages: persisted, workspacePath: workspace })
		expect(secondRequest.handoffId).toBeUndefined()
		expect((secondRequest.messages[0].content as any[])[1].text).toBe(record.body)
		expect((secondRequest.messages[0].content as any[])[1].text).not.toContain("IVOL_CODE_CONTEXT_RESTART_V1")
	})

	// kilocode_change start
	it("adds only file delivery and safety rules without replacing the handoff structure", () => {
		const prompt = buildContextHandoffPrompt("My custom condensing command")
		expect(prompt.startsWith("My custom condensing command")).toBe(true)
		expect(prompt).toContain(CONTEXT_HANDOFF_RELATIVE_PATH)
		expect(prompt).toContain("Never include API keys")
		expect(prompt).toContain("or private reasoning")
		expect(prompt).toContain("IVOL Code saves your output")
		expect(prompt).toContain("verifies the file before compaction")
		expect(prompt).toContain("Do not call tools")
		expect(prompt).toContain("Do not continue the underlying task")
		expect(prompt).toContain("IVOL Code manages reading and cleanup")
		expect(prompt).not.toContain("full working-memory snapshot")
		expect(prompt).not.toContain("more important than brevity")
		expect(prompt).not.toContain("code snippets")
		expect(prompt).not.toContain("End with an explicit note")
	})
	// kilocode_change end
})
