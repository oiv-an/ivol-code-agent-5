// kilocode_change - new file: generation/storage byte-budget compatibility regressions
import { MAX_TASK_DOCUMENT_BLOCK_BYTES, TASK_DOCUMENT_TARGET_BYTES, isTaskDocumentBodyWithinLimit } from "../limits"

describe("task document generation size policy", () => {
	const taskId = "9466b984-0240-4f41-9b4a-ffbde0c3f2e4"

	function block(body: string, id = taskId, newline = "\r\n"): string {
		const key = Buffer.from(id, "utf8").toString("hex")
		return `<!-- IVOL_TASK_V1 START task=${key} -->${newline}${body.replace(/\n/g, newline)}${newline}<!-- IVOL_TASK_V1 END task=${key} -->`
	}

	it("counts UTF-8 bytes and the actual UUID markers at the exact CRLF boundary", () => {
		expect(TASK_DOCUMENT_TARGET_BYTES).toBe(48 * 1024)
		expect(MAX_TASK_DOCUMENT_BLOCK_BYTES).toBe(256 * 1024)
		const prefix = "## Цель\nСохранить русские требования и 🚀\n"
		const available = MAX_TASK_DOCUMENT_BLOCK_BYTES - Buffer.byteLength(block(prefix), "utf8")
		const exact = prefix + "я".repeat(Math.floor(available / 2)) + "a".repeat(available % 2)
		expect(Buffer.byteLength(block(exact), "utf8")).toBe(MAX_TASK_DOCUMENT_BLOCK_BYTES)
		expect(isTaskDocumentBodyWithinLimit(exact, taskId)).toBe(true)
		expect(isTaskDocumentBodyWithinLimit(exact + "a", taskId)).toBe(false)
		expect(isTaskDocumentBodyWithinLimit(exact + "я", taskId)).toBe(false)
		expect(isTaskDocumentBodyWithinLimit(exact, taskId + "-longer")).toBe(false)
		expect(isTaskDocumentBodyWithinLimit(exact, "short")).toBe(true)
	})

	it("normalizes CR, CRLF and exterior empty lines before conservatively reserving every CRLF", () => {
		const lines = "я\n🚀\n".repeat(28000) + "Последняя строка"
		expect(Buffer.byteLength(block(lines, taskId, "\n"), "utf8")).toBeLessThan(MAX_TASK_DOCUMENT_BLOCK_BYTES)
		expect(Buffer.byteLength(block(lines), "utf8")).toBeGreaterThan(MAX_TASK_DOCUMENT_BLOCK_BYTES)
		expect(isTaskDocumentBodyWithinLimit(lines, taskId)).toBe(false)
		const available = MAX_TASK_DOCUMENT_BLOCK_BYTES - Buffer.byteLength(block(""), "utf8")
		const exact = "a".repeat(available)
		expect(isTaskDocumentBodyWithinLimit("\r\n\r" + exact + "\n\r\n", taskId)).toBe(true)
		expect(isTaskDocumentBodyWithinLimit("Первое\rВторое\r\nТретье", taskId)).toBe(true)
	})

	it.each(["", " \n\t", "body\0text", "<!-- IVOL_TASK_V1 START task=00 -->"])(
		"rejects invalid Markdown without throwing: %j",
		(body) => expect(isTaskDocumentBodyWithinLimit(body, taskId)).toBe(false),
	)

	it.each(["", " ", "task\nother", "task\0other", "a".repeat(129)])(
		"rejects invalid ownership identities without throwing: %j",
		(id) => expect(isTaskDocumentBodyWithinLimit("## Сохранить задачу", id)).toBe(false),
	)
})
