// kilocode_change - new file: real filesystem regression coverage for persistent task documents
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as lockfile from "proper-lockfile"

import {
	DEFAULT_TASK_DOCUMENT_FILE,
	readTaskDocument,
	saveTaskDocument,
	validateTaskDocumentFileName,
} from "../document"
import { MAX_TASK_DOCUMENT_BLOCK_BYTES, isTaskDocumentBodyWithinLimit } from "../limits"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename), link: vi.fn(actual.link) }
})

describe("persistent task document", () => {
	const temporaryDirectories: string[] = []
	const body =
		"## Задача\nДобавить настройку без потери данных.\n\n## Общий план\n1. Исследовать текущий код.\n2. Реализовать настройку.\n3. Проверить оба редактора.\n\n## Продолжить\nС этапа 2: ещё не проверено."

	afterEach(async () => {
		vi.restoreAllMocks()
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
		)
	})

	async function workspace(): Promise<string> {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ivol-task-document-"))
		temporaryDirectories.push(directory)
		return directory
	}

	function options(workspacePath: string, taskId = "task-1") {
		return { workspacePath, taskId }
	}

	async function create(workspacePath: string, taskId = "task-1") {
		const readOptions = options(workspacePath, taskId)
		const previous = await readTaskDocument(readOptions)
		return saveTaskDocument({ ...readOptions, expectedRevision: previous.revision, body })
	}

	it("reads a missing document without creating files, locks or directories", async () => {
		const directory = await workspace()
		expect(await readTaskDocument(options(directory))).toEqual({
			revision: null,
			exists: false,
			body: undefined,
			promptText: "",
		})
		expect(await fs.readdir(directory)).toEqual([])
	})

	it("creates readable root Markdown and hydrates the entire active task body after restart", async () => {
		const directory = await workspace()
		const snapshot = await create(directory)
		expect(await readTaskDocument(options(directory))).toEqual(snapshot)
		expect(snapshot.body).toBe(body)
		expect(snapshot.revision).toMatch(/^[a-f0-9]{64}$/)
		const saved = await fs.readFile(path.join(directory, DEFAULT_TASK_DOCUMENT_FILE), "utf8")
		expect(saved.startsWith("# CURRENT TASK\n\n> ПЕРВОЕ ДЕЙСТВИЕ ПРИ СБРОСЕ КОНТЕКСТА:")).toBe(true)
		expect(saved).toContain("прочитать `AI_INSTRUCTIONS.md` (если он существует)")
		expect(saved).toContain(body)
		expect(await fs.readdir(directory)).toEqual([DEFAULT_TASK_DOCUMENT_FILE])
	})

	it("uses only CURRENT_TASK.md and never imports, rewrites or deletes the former experimental file", async () => {
		const directory = await workspace()
		const oldPath = path.join(directory, "CURRENT_WORK.md")
		const oldContent = "# Old experiment\nPrivate previous project notes must stay untouched."
		await fs.writeFile(oldPath, oldContent)
		expect(DEFAULT_TASK_DOCUMENT_FILE).toBe("CURRENT_TASK.md")
		expect(await readTaskDocument(options(directory))).toMatchObject({ exists: false, revision: null })
		await create(directory)
		expect(await fs.readFile(oldPath, "utf8")).toBe(oldContent)
		const current = await fs.readFile(path.join(directory, "CURRENT_TASK.md"), "utf8")
		expect(current).toContain(body)
		expect(current).not.toContain(oldContent)
	})

	it("keeps arbitrary Markdown including indentation, headings, nested lists and manual notes", async () => {
		const directory = await workspace()
		const markdown =
			"    indented code\n\n# Freeform heading\n\n- [ ] Global stage\n  - not an internal TodoItem\n\n| State | Action |\n| --- | --- |\n| Done | Verified |\n\n### Goal\nManual extra note"
		const saved = await saveTaskDocument({ ...options(directory), expectedRevision: null, body: markdown })
		expect(saved.body).toBe(markdown)
		expect(await readTaskDocument(options(directory))).toEqual(saved)
		expect(saved).not.toHaveProperty("todos")
		expect(saved).not.toHaveProperty("taskContent")
	})

	it("creates and reloads a complete Russian task section larger than the former 24 KiB limit", async () => {
		const directory = await workspace()
		const taskId = "9466b984-0240-4f41-9b4a-ffbde0c3f2e4"
		const russianBody =
			"## Цель\nСохранить все требования пользователя.\n\n" +
			Array.from(
				{ length: 650 },
				(_, index) => `${index + 1}. Не завершено: проверить ветку ${index + 1} 🚀.`,
			).join("\n") +
			"\n\n## Продолжить здесь\nСначала проверить незавершённый запуск, затем продолжить общий план."
		expect(Buffer.byteLength(russianBody, "utf8")).toBeGreaterThan(24 * 1024)
		const saved = await saveTaskDocument({
			...options(directory, taskId),
			expectedRevision: null,
			body: russianBody,
		})
		expect(saved.body).toBe(russianBody)
		expect(await readTaskDocument(options(directory, taskId))).toEqual(saved)
		expect(await fs.readdir(directory)).toEqual([DEFAULT_TASK_DOCUMENT_FILE])
	})

	it.each(["\n", "\r\n"] as const)(
		"accepts an exact 256 KiB UTF-8 block with %j line endings and preserves surrounding bytes",
		async (newline) => {
			const directory = await workspace()
			const file = path.join(directory, DEFAULT_TASK_DOCUMENT_FILE)
			const taskId = "9466b984-0240-4f41-9b4a-ffbde0c3f2e4"
			const taskKey = Buffer.from(taskId, "utf8").toString("hex")
			const start = `<!-- IVOL_TASK_V1 START task=${taskKey} -->${newline}`
			const end = `${newline}<!-- IVOL_TASK_V1 END task=${taskKey} -->`
			const bodyPrefix = "## Цель\nСохранить все обязательства 🚀\n"
			const remainingBytes =
				MAX_TASK_DOCUMENT_BLOCK_BYTES -
				Buffer.byteLength(start + bodyPrefix.replace(/\n/g, newline) + end, "utf8")
			const exactBody = bodyPrefix + "я".repeat(Math.floor(remainingBytes / 2)) + "a".repeat(remainingBytes % 2)
			const prefix = `\ufeff# Ручной план${newline}Не удалять требования пользователя.${newline}${newline}`
			const suffix =
				`${newline}${newline}Ручная заметка после блока${newline}` +
				`<!-- IVOL_TASK_V1 START task=6f74686572 -->${newline}Другая задача${newline}<!-- IVOL_TASK_V1 END task=6f74686572 -->${newline}`
			await fs.writeFile(file, prefix + start + "Старый блок" + end + suffix, "utf8")
			const before = await readTaskDocument(options(directory, taskId))
			const saved = await saveTaskDocument({
				...options(directory, taskId),
				expectedRevision: before.revision,
				body: exactBody,
			})
			const exactBlock = start + exactBody.replace(/\n/g, newline) + end
			expect(Buffer.byteLength(exactBlock, "utf8")).toBe(MAX_TASK_DOCUMENT_BLOCK_BYTES)
			expect(await fs.readFile(file, "utf8")).toBe(prefix + exactBlock + suffix)
			expect(saved.body).toBe(exactBody)
			expect(await readTaskDocument(options(directory, taskId))).toEqual(saved)
			expect((await readTaskDocument(options(directory, "other"))).body).toBe("Другая задача")
			// Existing LF blocks are measured as stored; only the generation policy reserves CRLF overhead.
			expect(isTaskDocumentBodyWithinLimit(exactBody, taskId)).toBe(newline === "\r\n")
			vi.mocked(fs.open).mockClear()
			vi.mocked(fs.rename).mockClear()
			vi.mocked(fs.link).mockClear()
			await expect(
				saveTaskDocument({
					...options(directory, taskId),
					expectedRevision: saved.revision,
					body: exactBody + "a",
				}),
			).rejects.toThrow("256 KiB safety limit")
			expect(vi.mocked(fs.open).mock.calls.every(([, flags]) => flags !== "wx")).toBe(true)
			expect(fs.rename).not.toHaveBeenCalled()
			expect(fs.link).not.toHaveBeenCalled()
			expect(await fs.readFile(file, "utf8")).toBe(prefix + exactBlock + suffix)
			expect(await fs.readdir(directory)).toEqual([DEFAULT_TASK_DOCUMENT_FILE])
			await fs.writeFile(file, prefix + start + exactBody.replace(/\n/g, newline) + "a" + end + suffix, "utf8")
			await expect(readTaskDocument(options(directory, taskId))).rejects.toThrow("256 KiB safety limit")
		},
	)

	it("rejects an oversized first update without creating a document or temporary file", async () => {
		const directory = await workspace()
		vi.mocked(fs.open).mockClear()
		await expect(
			saveTaskDocument({
				...options(directory),
				expectedRevision: null,
				body: "a".repeat(MAX_TASK_DOCUMENT_BLOCK_BYTES),
			}),
		).rejects.toThrow("256 KiB safety limit")
		expect(vi.mocked(fs.open).mock.calls.every(([, flags]) => flags !== "wx")).toBe(true)
		expect(await fs.readdir(directory)).toEqual([])
	})

	it("preserves every existing user-owned byte on first append and does not rewrite its header", async () => {
		const directory = await workspace()
		const file = path.join(directory, DEFAULT_TASK_DOCUMENT_FILE)
		const userText = "\ufeff# Моя текущая работа\r\n\r\n- Важное требование 🚀\r\nБез последнего перевода строки"
		await fs.writeFile(file, userText, "utf8")
		expect((await readTaskDocument(options(directory))).body).toBeUndefined()
		expect(await fs.readFile(file, "utf8")).toBe(userText)
		await create(directory)
		const saved = await fs.readFile(file, "utf8")
		expect(saved.startsWith(userText + "\r\n\r\n")).toBe(true)
		expect(saved).not.toContain("ПЕРВОЕ ДЕЙСТВИЕ")
		expect((await readTaskDocument(options(directory))).body).toBe(body)
	})

	it("preserves notes after the active block, CRLF endings and other tasks byte-for-byte", async () => {
		const directory = await workspace()
		const file = path.join(directory, DEFAULT_TASK_DOCUMENT_FILE)
		await fs.writeFile(file, "# Пользователь\r\n", "utf8")
		await create(directory)
		await fs.appendFile(file, "\r\n# Ручные заметки после блока\r\n", "utf8")
		await create(directory, "task-2")
		const before = await fs.readFile(file, "utf8")
		const secondBefore = await readTaskDocument(options(directory, "task-2"))
		const firstBefore = await readTaskDocument(options(directory))
		await saveTaskDocument({
			...options(directory),
			expectedRevision: firstBefore.revision,
			body: body.replace("С этапа 2", "С этапа 3"),
		})
		expect(await fs.readFile(file, "utf8")).toBe(before.replace("С этапа 2", "С этапа 3"))
		const secondAfter = await readTaskDocument(options(directory, "task-2"))
		expect(secondAfter.body).toEqual(secondBefore.body)
		expect(secondAfter.promptText).not.toContain("С этапа 3")
		expect((await readTaskDocument(options(directory))).body).toContain("С этапа 3")
	})

	it("rejects stale revisions including a newly created file", async () => {
		const directory = await workspace()
		const first = await create(directory)
		const second = await saveTaskDocument({
			...options(directory),
			expectedRevision: first.revision,
			body: body + "\nUpdated",
		})
		await expect(
			saveTaskDocument({ ...options(directory), expectedRevision: first.revision, body }),
		).rejects.toThrow("changed after it was read")
		await expect(saveTaskDocument({ ...options(directory), expectedRevision: null, body })).rejects.toThrow(
			"changed after it was read",
		)
		expect((await readTaskDocument(options(directory))).revision).toBe(second.revision)
	})

	it("rejects a manual edit after the model snapshot and leaves it intact", async () => {
		const directory = await workspace()
		const first = await create(directory)
		const file = path.join(directory, DEFAULT_TASK_DOCUMENT_FILE)
		await fs.appendFile(file, "\nDo not deploy\n")
		const edited = await fs.readFile(file, "utf8")
		await expect(
			saveTaskDocument({ ...options(directory), expectedRevision: first.revision, body }),
		).rejects.toThrow("changed after it was read")
		expect(await fs.readFile(file, "utf8")).toBe(edited)
	})

	it("accepts hand-edited body contents on reread, without imposing a machine schema", async () => {
		const directory = await workspace()
		await create(directory)
		const file = path.join(directory, DEFAULT_TASK_DOCUMENT_FILE)
		const edited = (await fs.readFile(file, "utf8")).replace(
			"## Задача",
			"# User corrected goal\n\nFreeform extra notes\n\n## Задача",
		)
		await fs.writeFile(file, edited)
		const snapshot = await readTaskDocument(options(directory))
		expect(snapshot.body).toContain("User corrected goal\n\nFreeform extra notes")
		const updated = await saveTaskDocument({
			...options(directory),
			expectedRevision: snapshot.revision,
			body: snapshot.body! + "\n\nNext correction",
		})
		expect(updated.body).toContain("Freeform extra notes")
	})

	it.each(["", "\n \n", "text\0data", "<!-- IVOL_TASK_V1 START task=00 -->", "<!--  IVOL_TASK_V2 END task=00 -->"])(
		"rejects empty bodies and ownership marker injection %j",
		async (invalidBody) => {
			const directory = await workspace()
			await expect(
				saveTaskDocument({ ...options(directory), expectedRevision: null, body: invalidBody }),
			).rejects.toThrow("nonempty Markdown")
			expect(await fs.readdir(directory)).toEqual([])
		},
	)

	it("does not touch mtime when the body did not change", async () => {
		const directory = await workspace()
		const first = await create(directory)
		const file = path.join(directory, DEFAULT_TASK_DOCUMENT_FILE)
		const before = await fs.stat(file)
		expect(await saveTaskDocument({ ...options(directory), expectedRevision: first.revision, body })).toEqual(first)
		expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs)
	})

	it("rejects malformed, nested and duplicate ownership blocks", async () => {
		const directory = await workspace()
		await create(directory)
		const file = path.join(directory, DEFAULT_TASK_DOCUMENT_FILE)
		const valid = await fs.readFile(file, "utf8")
		await fs.writeFile(file, valid + valid)
		await expect(readTaskDocument(options(directory))).rejects.toThrow("duplicate managed blocks")
		await fs.writeFile(file, valid.replace("END task=", "START task="))
		await expect(readTaskDocument(options(directory))).rejects.toThrow("overlapping or duplicate")
		await fs.writeFile(file, valid.replace("END task=", "END invalid="))
		await expect(readTaskDocument(options(directory))).rejects.toThrow("malformed managed markers")
	})

	it.each([
		"../outside.md",
		"/tmp/outside.md",
		"C:\\outside.md",
		"folder/file.md",
		"file.md:stream",
		"file\0.md",
		"AGENTS.md",
		"CONTEXT_RESTART.md",
		"CON.md",
		"Lpt9.md",
		"NUL.extra.md",
		"file..md",
		".secret.md",
		"file. md",
		"a".repeat(130) + ".md",
	])("rejects unsafe or reserved filename %j", (fileName) => {
		expect(() => validateTaskDocumentFileName(fileName)).toThrow()
	})

	it.each(["CURRENT_TASK.md", "CURRENT-WORK.md", "Текущая работа.md", "work.v2.md", "README.md"])(
		"accepts root Markdown name %j",
		(fileName) => {
			expect(validateTaskDocumentFileName(fileName)).toBe(fileName)
		},
	)

	it("rejects symbolic links, hardlinks, directories, and symbolic workspace roots", async () => {
		const directory = await workspace()
		const outside = await workspace()
		const target = path.join(outside, "original.md")
		await fs.writeFile(target, "unchanged")
		const file = path.join(directory, DEFAULT_TASK_DOCUMENT_FILE)
		await fs.symlink(target, file)
		await expect(readTaskDocument(options(directory))).rejects.toThrow("symbolic links or hard links")
		await fs.unlink(file)
		await fs.link(target, file)
		await expect(readTaskDocument(options(directory))).rejects.toThrow("symbolic links or hard links")
		await fs.unlink(file)
		await fs.mkdir(file)
		await expect(readTaskDocument(options(directory))).rejects.toThrow("regular file")
		const alias = path.join(directory, "alias")
		await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir")
		await expect(readTaskDocument(options(alias))).rejects.toThrow("workspace must be a real directory")
		expect(await fs.readFile(target, "utf8")).toBe("unchanged")
	})

	it("refuses a symlink lock without touching its target", async () => {
		const directory = await workspace()
		const outside = await workspace()
		await fs.symlink(
			outside,
			path.join(directory, DEFAULT_TASK_DOCUMENT_FILE + ".lock"),
			process.platform === "win32" ? "junction" : "dir",
		)
		await expect(create(directory)).rejects.toThrow("lock is not a regular lock directory")
		expect(await fs.readdir(outside)).toEqual([])
	})

	it("bounds file reads, active block writes and user note excerpts", async () => {
		const directory = await workspace()
		const file = path.join(directory, DEFAULT_TASK_DOCUMENT_FILE)
		await fs.writeFile(file, "a".repeat(1024 * 1024 + 1))
		await expect(readTaskDocument(options(directory))).rejects.toThrow("1 MiB safety limit")
		await fs.writeFile(file, "# User notes\n" + "н".repeat(7000))
		const snapshot = await create(directory)
		expect(snapshot.promptText).toContain("excerpt truncated at 8 KiB")
		expect(snapshot.promptText).not.toContain("�")
		expect((await fs.readFile(file, "utf8")).startsWith("# User notes\n" + "н".repeat(7000))).toBe(true)
		await expect(
			saveTaskDocument({
				...options(directory),
				expectedRevision: snapshot.revision,
				body: "a".repeat(MAX_TASK_DOCUMENT_BLOCK_BYTES),
			}),
		).rejects.toThrow("256 KiB safety limit")
		expect((await readTaskDocument(options(directory))).revision).toBe(snapshot.revision)
	})

	it("rejects invalid UTF-8 rather than silently replacing user bytes", async () => {
		const directory = await workspace()
		const file = path.join(directory, DEFAULT_TASK_DOCUMENT_FILE)
		await fs.writeFile(file, Buffer.from([0xff, 0xfe, 0x80]))
		await expect(readTaskDocument(options(directory))).rejects.toThrow()
		expect(await fs.readFile(file)).toEqual(Buffer.from([0xff, 0xfe, 0x80]))
	})

	it("syncs only the original writable descriptor and preserves the original after fsync failure", async () => {
		const directory = await workspace()
		const first = await create(directory)
		const file = path.join(directory, DEFAULT_TASK_DOCUMENT_FILE)
		const original = await fs.readFile(file, "utf8")
		const actualOpen = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).open
		let syncCalls = 0
		vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
			const handle = await actualOpen(...args)
			if (String(args[0]).endsWith(".tmp")) {
				expect(args[1]).toBe("wx")
				vi.spyOn(handle, "sync").mockImplementation(async () => {
					syncCalls++
					throw Object.assign(new Error("simulated fsync failure"), { code: "EPERM" })
				})
			} else {
				vi.spyOn(handle, "sync").mockImplementation(async () => {
					throw new Error("Read descriptor must never be synced")
				})
			}
			return handle
		})
		await expect(
			saveTaskDocument({ ...options(directory), expectedRevision: first.revision, body: body + "\nChanged" }),
		).rejects.toThrow("simulated fsync failure")
		expect(syncCalls).toBe(1)
		expect(await fs.readFile(file, "utf8")).toBe(original)
		expect(await fs.readdir(directory)).toEqual([DEFAULT_TASK_DOCUMENT_FILE])
	})

	it("does not truncate the original when replacement fails", async () => {
		const directory = await workspace()
		const first = await create(directory)
		const file = path.join(directory, DEFAULT_TASK_DOCUMENT_FILE)
		const original = await fs.readFile(file, "utf8")
		vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error("file busy"), { code: "EBUSY" }))
		await expect(
			saveTaskDocument({ ...options(directory), expectedRevision: first.revision, body: body + "\nChanged" }),
		).rejects.toThrow("file busy")
		expect(await fs.readFile(file, "utf8")).toBe(original)
		expect(await fs.readdir(directory)).toEqual([DEFAULT_TASK_DOCUMENT_FILE])
	})

	it("cannot overwrite a file created between the final check and first publication", async () => {
		const directory = await workspace()
		const actualLink = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).link
		vi.mocked(fs.link).mockImplementationOnce(async (source, destination) => {
			await fs.writeFile(destination, "User created this file")
			return actualLink(source, destination)
		})
		await expect(create(directory)).rejects.toMatchObject({ code: "EEXIST" })
		expect(await fs.readFile(path.join(directory, DEFAULT_TASK_DOCUMENT_FILE), "utf8")).toBe(
			"User created this file",
		)
		expect(await fs.readdir(directory)).toEqual([DEFAULT_TASK_DOCUMENT_FILE])
	})

	it("rechecks the revision after preparing the temporary file", async () => {
		const directory = await workspace()
		const first = await create(directory)
		const file = path.join(directory, DEFAULT_TASK_DOCUMENT_FILE)
		const actualOpen = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).open
		vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
			const handle = await actualOpen(...args)
			if (String(args[0]).endsWith(".tmp")) {
				const actualSync = handle.sync.bind(handle)
				vi.spyOn(handle, "sync").mockImplementation(async () => {
					await actualSync()
					await fs.appendFile(file, "\nConcurrent user edit\n")
				})
			}
			return handle
		})
		await expect(
			saveTaskDocument({ ...options(directory), expectedRevision: first.revision, body: body + "\nChanged" }),
		).rejects.toThrow("changed after it was read")
		expect((await fs.readFile(file, "utf8")).endsWith("\nConcurrent user edit\n")).toBe(true)
	})

	it("does not report a verified save when another process changes the published file", async () => {
		const directory = await workspace()
		const first = await create(directory)
		const file = path.join(directory, DEFAULT_TASK_DOCUMENT_FILE)
		const actualRename = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).rename
		vi.mocked(fs.rename).mockImplementationOnce(async (source, destination) => {
			await actualRename(source, destination)
			await fs.appendFile(destination, "\nExternal post-publication edit")
		})
		await expect(
			saveTaskDocument({ ...options(directory), expectedRevision: first.revision, body: body + "\nChanged" }),
		).rejects.toThrow("changed during write verification")
		expect((await fs.readFile(file, "utf8")).endsWith("External post-publication edit")).toBe(true)
	})

	it("rejects an already-revoked write before creating any filesystem artifacts", async () => {
		const directory = await workspace()
		const assertCurrent = () => {
			throw new Error("Feature disabled")
		}
		await expect(
			saveTaskDocument({ ...options(directory), expectedRevision: null, body, assertCurrent }),
		).rejects.toThrow("Feature disabled")
		expect(await fs.readdir(directory)).toEqual([])
	})

	it("rechecks permission immediately before publication and cleans up a revoked pending write", async () => {
		const directory = await workspace()
		const first = await create(directory)
		let assertions = 0
		const assertCurrent = () => {
			assertions++
			if (assertions === 3) throw new Error("Settings changed while writing")
		}
		await expect(
			saveTaskDocument({
				...options(directory),
				expectedRevision: first.revision,
				body: body + "\nChanged",
				assertCurrent,
			}),
		).rejects.toThrow("Settings changed while writing")
		expect(assertions).toBe(3)
		expect((await readTaskDocument(options(directory))).revision).toBe(first.revision)
		expect(await fs.readdir(directory)).toEqual([DEFAULT_TASK_DOCUMENT_FILE])
	})

	it("serializes competing writes and requires the losing task to reread", async () => {
		const directory = await workspace()
		const results = await Promise.allSettled([
			saveTaskDocument({ ...options(directory), expectedRevision: null, body }),
			saveTaskDocument({ ...options(directory, "task-2"), expectedRevision: null, body }),
		])
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
		await create(directory)
		await create(directory, "task-2")
		expect((await readTaskDocument(options(directory))).body).toEqual(body)
		expect((await readTaskDocument(options(directory, "task-2"))).body).toEqual(body)
	})

	it("honors an existing active interprocess lock with bounded retry", async () => {
		const directory = await workspace()
		const file = path.join(directory, DEFAULT_TASK_DOCUMENT_FILE)
		const release = await lockfile.lock(file, { realpath: false })
		try {
			await expect(create(directory)).rejects.toMatchObject({ code: "ELOCKED" })
			expect(await fs.readdir(directory)).toEqual([DEFAULT_TASK_DOCUMENT_FILE + ".lock"])
		} finally {
			await release()
		}
	})
})
