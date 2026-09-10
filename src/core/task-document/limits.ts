// kilocode_change - new file: shared persistent task document size and serialization policy
export const MAX_TASK_DOCUMENT_BLOCK_BYTES = 256 * 1024
export const TASK_DOCUMENT_TARGET_BYTES = 48 * 1024

export function encodeTaskDocumentId(value: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\r\n\0]/.test(value)) {
		throw new Error("The task document identity is invalid")
	}
	return Buffer.from(value, "utf8").toString("hex")
}

export function normalizeTaskDocumentBody(body: string): string {
	if (typeof body !== "string" || !body.trim() || body.includes("\0") || /<!--\s*IVOL_TASK/.test(body)) {
		throw new Error("The task document body must be nonempty Markdown without reserved ownership markers")
	}
	// Keep indentation and ordinary Markdown intact; only normalize line endings and exterior blank lines.
	return body.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "")
}

/** The caller supplies an encoded identity and normalized body; keep storage and generation byte counts identical. */
export function serializeTaskDocumentBlock(key: string, body: string, newline: "\n" | "\r\n"): string {
	return `<!-- IVOL_TASK_V1 START task=${key} -->\n${body}\n<!-- IVOL_TASK_V1 END task=${key} -->`.replace(
		/\n/g,
		newline,
	)
}

/** Conservative generation check: an accepted body fits the actual ownership markers with either stored newline style. */
export function isTaskDocumentBodyWithinLimit(body: string, taskId: string): boolean {
	try {
		const text = serializeTaskDocumentBlock(encodeTaskDocumentId(taskId), normalizeTaskDocumentBody(body), "\r\n")
		return Buffer.byteLength(text, "utf8") <= MAX_TASK_DOCUMENT_BLOCK_BYTES
	} catch {
		return false
	}
}
