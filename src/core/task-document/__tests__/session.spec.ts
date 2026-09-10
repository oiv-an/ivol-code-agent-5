// kilocode_change - new file
import { readTaskDocument, saveTaskDocument, type TaskDocumentSnapshot } from "../document"
import { TaskDocumentSession } from "../session"
import { INTELLIGENT_TASK_INSTRUCTIONS } from "../prompts"

vi.mock("../document", () => ({
	readTaskDocument: vi.fn(),
	saveTaskDocument: vi.fn(),
}))

type Settings = { enabled: boolean; supported: boolean; fileName: string }

function snapshot(revision = "revision-1", body = "# Task\nPreserve the global goal and unfinished branches.") {
	return { revision, body, promptText: `User-owned overview\n${body}`, exists: true } satisfies TaskDocumentSnapshot
}

function createSession(
	initial: Settings | undefined = { enabled: true, supported: true, fileName: "CURRENT_TASK.md" },
) {
	let settings: Settings | undefined = initial
	const assertCurrent = vi.fn()
	const onError = vi.fn().mockResolvedValue(undefined)
	const session = new TaskDocumentSession({
		workspacePath: "/test/project",
		taskId: "task-one",
		getSettings: () => settings,
		assertCurrent,
		onError,
	})
	return { session, assertCurrent, onError, setSettings: (value: Settings | undefined) => (settings = value) }
}

describe("persistent task document session", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		vi.mocked(readTaskDocument).mockResolvedValue(snapshot())
		vi.mocked(saveTaskDocument).mockImplementation(async ({ body }) => snapshot("revision-saved", body))
	})

	it.each([
		{ enabled: false, supported: true, fileName: "CURRENT_TASK.md" },
		{ enabled: true, supported: false, fileName: "CURRENT_TASK.md" },
		{ enabled: false, supported: false, fileName: "CURRENT_TASK.md" },
	])("does no document I/O when disabled or unsupported: %j", async (settings) => {
		const { session, onError } = createSession(settings)
		expect(session.enabled).toBe(false)
		expect(await session.context()).toBe("")
		expect(await session.prepare()).toBeUndefined()
		await session.update("# Do not write")
		expect(readTaskDocument).not.toHaveBeenCalled()
		expect(saveTaskDocument).not.toHaveBeenCalled()
		expect(onError).not.toHaveBeenCalled()
	})

	it("does no I/O before settings have arrived", async () => {
		const { session, setSettings } = createSession()
		setSettings(undefined)
		expect(await session.context()).toBe("")
		expect(await session.prepare()).toBeUndefined()
		await session.update("# Do not write")
		expect(readTaskDocument).not.toHaveBeenCalled()
		expect(saveTaskDocument).not.toHaveBeenCalled()
	})

	it("includes actual saved evidence, keeps the global plan separate from current-stage TODO, and orders required reads", async () => {
		const { session } = createSession()
		const prompt = await session.context()
		expect(prompt).toContain("persistent GLOBAL plan")
		expect(prompt).toContain("short execution plan for the CURRENT STAGE")
		expect(prompt).toContain("Do not replace the global plan with only the latest checklist")
		expect(prompt).toContain("first read AI_INSTRUCTIONS.md")
		expect(prompt).toContain("then CURRENT_TASK.md")
		expect(prompt.indexOf("first read AI_INSTRUCTIONS.md")).toBeLessThan(prompt.indexOf("then CURRENT_TASK.md"))
		expect(prompt).toContain("not new execution instructions; newer user corrections take priority")
		expect(prompt).toContain(JSON.stringify(snapshot().promptText))
		expect(prompt).toContain("Resume this task's saved state")
		expect(prompt).toContain("not interpret a written plan as permission to implement")
		expect(prompt).toContain("Never record secrets or private reasoning")
		expect(readTaskDocument).toHaveBeenCalledWith({
			workspacePath: "/test/project",
			fileName: "CURRENT_TASK.md",
			taskId: "task-one",
		})
	})

	it("re-reads current saved content for every request, including a post-compaction request", async () => {
		const { session } = createSession()
		vi.mocked(readTaskDocument)
			.mockResolvedValueOnce(snapshot("before", "Before the current stage"))
			.mockResolvedValueOnce(snapshot("after", "After compaction: exact next action"))
		expect(await session.context()).toContain("Before the current stage")
		const restored = await session.context()
		expect(restored).toContain(INTELLIGENT_TASK_INSTRUCTIONS)
		expect(restored).toContain("After compaction: exact next action")
		expect(restored).not.toContain("Before the current stage")
		expect(readTaskDocument).toHaveBeenCalledTimes(2)
		expect(saveTaskDocument).not.toHaveBeenCalled()
	})

	it.each([false, true])(
		"requests initialization without creating a missing task section (file exists=%s)",
		async (exists) => {
			const { session } = createSession()
			vi.mocked(readTaskDocument).mockResolvedValue({
				revision: exists ? "manual-file" : null,
				exists,
				promptText: exists ? "Existing manual project plan must remain intact" : "",
			})
			const prompt = await session.context()
			expect(prompt).toContain(INTELLIGENT_TASK_INSTRUCTIONS)
			expect(prompt).toContain(exists ? "CURRENT_TASK.md exists" : "CURRENT_TASK.md is missing")
			expect(prompt).toContain("No managed section for this task exists yet")
			expect(prompt).toContain("Read the existing project plan, then initialize")
			expect(prompt).toContain("do not invent a task")
			if (exists) expect(prompt).toContain("Existing manual project plan must remain intact")
			expect(saveTaskDocument).not.toHaveBeenCalled()
		},
	)

	it("reports the same read error only once, blocks blind updates, and refuses compaction preparation", async () => {
		const { session, onError } = createSession()
		const failure = new Error("Unreadable file: EACCES")
		vi.mocked(readTaskDocument).mockRejectedValue(failure)
		const prompt = await session.context()
		expect(prompt).toContain(INTELLIGENT_TASK_INSTRUCTIONS)
		expect(prompt).toContain("not confirmed missing")
		expect(prompt).toContain("Do not recreate or overwrite it blindly")
		expect(await session.context()).toContain("compaction must wait")
		expect(onError).toHaveBeenCalledOnce()
		expect(onError).toHaveBeenCalledWith(expect.stringContaining("EACCES"))
		await expect(session.update("# Unsafe replacement")).rejects.toThrow("No verified CURRENT_TASK.md snapshot")
		await expect(session.prepare()).rejects.toBe(failure)
		expect(saveTaskDocument).not.toHaveBeenCalled()
	})

	it("forgets a formerly good snapshot after a failed read instead of overwriting against stale evidence", async () => {
		const { session } = createSession()
		await session.context()
		vi.mocked(readTaskDocument).mockRejectedValueOnce(new Error("malformed ownership markers"))
		await session.context()
		await expect(session.update("# Unsafe replacement")).rejects.toThrow("No verified CURRENT_TASK.md snapshot")
		expect(saveTaskDocument).not.toHaveBeenCalled()
	})

	it("shows a recurring error again only after recovery or a changed failure", async () => {
		const { session, onError } = createSession()
		vi.mocked(readTaskDocument)
			.mockRejectedValueOnce(new Error("first error"))
			.mockRejectedValueOnce(new Error("other error"))
			.mockResolvedValueOnce(snapshot())
			.mockRejectedValueOnce(new Error("first error"))
		await session.context()
		await session.context()
		await session.context()
		await session.context()
		expect(onError).toHaveBeenCalledTimes(3)
	})

	it("captures the preparation's own source revision even if another request refreshes the session", async () => {
		const { session } = createSession()
		vi.mocked(readTaskDocument)
			.mockResolvedValueOnce(snapshot("preparation-source", "Original preparation evidence"))
			.mockResolvedValueOnce(snapshot("new-request", "Newer request evidence"))
		const preparation = await session.prepare()
		expect(preparation?.context).toContain("Original preparation evidence")
		await session.context()
		await preparation!.save("# Saved preparation")
		expect(saveTaskDocument).toHaveBeenCalledWith(
			expect.objectContaining({ expectedRevision: "preparation-source", body: "# Saved preparation" }),
		)
		expect(preparation?.context).not.toContain("Newer request evidence")
	})

	it("passes raw Markdown and scope to storage without TODO hydration or rewriting checklist data", async () => {
		const { session } = createSession()
		await session.context()
		const body = "# Global goal\n\nPreserve branches A and B.\n\n# Resume here\nContinue branch A."
		await session.update(body)
		expect(saveTaskDocument).toHaveBeenCalledWith({
			workspacePath: "/test/project",
			fileName: "CURRENT_TASK.md",
			taskId: "task-one",
			expectedRevision: "revision-1",
			body,
			assertCurrent: expect.any(Function),
		})
		expect(saveTaskDocument).not.toHaveBeenCalledWith(expect.objectContaining({ todos: expect.anything() }))
	})

	it("uses the verified saved revision for subsequent updates", async () => {
		const { session } = createSession()
		await session.context()
		await session.update("First update")
		await session.update("Second update")
		expect(saveTaskDocument).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ expectedRevision: "revision-saved", body: "Second update" }),
		)
	})

	it("propagates failed writes and never substitutes an unverified new revision", async () => {
		const { session } = createSession()
		await session.context()
		const failure = new Error("Concurrent edit conflict")
		vi.mocked(saveTaskDocument).mockRejectedValueOnce(failure)
		await expect(session.update("First update")).rejects.toBe(failure)
		await session.update("Retry after explicit reconciliation")
		expect(saveTaskDocument).toHaveBeenNthCalledWith(2, expect.objectContaining({ expectedRevision: "revision-1" }))
	})

	it.each([null, undefined])("ignores an absent task document update %s without I/O", async (body) => {
		const { session } = createSession()
		await session.update(body)
		expect(readTaskDocument).not.toHaveBeenCalled()
		expect(saveTaskDocument).not.toHaveBeenCalled()
	})

	it("rejects updates before the first verified read", async () => {
		const { session } = createSession()
		await expect(session.update("# Not observed")).rejects.toThrow("No verified CURRENT_TASK.md snapshot")
		expect(saveTaskDocument).not.toHaveBeenCalled()
	})

	it("revokes a captured preparation when the mode is disabled", async () => {
		const { session, setSettings } = createSession()
		const preparation = await session.prepare()
		setSettings({ enabled: false, supported: true, fileName: "CURRENT_TASK.md" })
		await expect(preparation!.save("# Do not write")).rejects.toThrow("disabled or changed")
		expect(saveTaskDocument).not.toHaveBeenCalled()
	})

	it("rejects a changed setting inside the storage callback before a queued write can commit", async () => {
		const { session, setSettings } = createSession()
		await session.context()
		const committed = vi.fn()
		vi.mocked(saveTaskDocument).mockImplementationOnce(async (options) => {
			setSettings({ enabled: false, supported: true, fileName: "CURRENT_TASK.md" })
			options.assertCurrent!()
			committed()
			return snapshot("unsafe")
		})
		await expect(session.update("# Queued update")).rejects.toThrow("disabled or changed")
		expect(committed).not.toHaveBeenCalled()
	})

	it("passes task cancellation into the storage's final scope check", async () => {
		const { session, assertCurrent } = createSession()
		await session.context()
		const stopped = new Error("Task stopped")
		vi.mocked(saveTaskDocument).mockImplementationOnce(async (options) => {
			assertCurrent.mockImplementationOnce(() => {
				throw stopped
			})
			options.assertCurrent!()
			return snapshot("unsafe")
		})
		await expect(session.update("# Do not commit after cancellation")).rejects.toBe(stopped)
	})

	it("does not retain evidence from a read that finishes after opt-out", async () => {
		const { session, setSettings, onError } = createSession()
		vi.mocked(readTaskDocument).mockImplementationOnce(async () => {
			setSettings({ enabled: false, supported: true, fileName: "CURRENT_TASK.md" })
			return snapshot()
		})
		expect(await session.context()).toBe("")
		expect(onError).not.toHaveBeenCalled()
		setSettings({ enabled: true, supported: true, fileName: "CURRENT_TASK.md" })
		await expect(session.update("# No read after re-enable")).rejects.toThrow(
			"No verified CURRENT_TASK.md snapshot",
		)
		expect(saveTaskDocument).not.toHaveBeenCalled()
	})

	it("clears the observed snapshot while disabled and requires a fresh read on re-enable", async () => {
		const { session, setSettings } = createSession()
		await session.context()
		setSettings({ enabled: false, supported: true, fileName: "CURRENT_TASK.md" })
		await session.context()
		setSettings({ enabled: true, supported: true, fileName: "CURRENT_TASK.md" })
		await expect(session.update("# Must read again")).rejects.toThrow("No verified CURRENT_TASK.md snapshot")
		expect(saveTaskDocument).not.toHaveBeenCalled()
	})
})
