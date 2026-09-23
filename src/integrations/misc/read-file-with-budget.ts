// kilocode_change - sequential, bounded file reading shared by all IDE hosts
import { createReadStream } from "fs"
import { createInterface } from "readline"
import { countTokens } from "../../utils/countTokens"
import { addLineNumbers } from "./extract-text"

export interface ReadWithBudgetResult {
	content: string
	/** Tokens in the returned content, including line numbers when requested. */
	tokenCount: number
	lineCount: number
	/** Whether the requested range (or entire file) was read. */
	complete: boolean
}

export interface ReadWithBudgetOptions {
	budgetTokens: number
	chunkLines?: number
	/** 1-based inclusive range. */
	startLine?: number
	endLine?: number
	/** Account for the actual numbered representation returned to the model. */
	includeLineNumbers?: boolean
}

// A second bound protects against huge single lines and unusually large context windows.
export const MAX_FILE_READ_CHARACTERS = 128_000

async function measure(text: string): Promise<number> {
	if (!text) return 0
	try {
		return await countTokens([{ type: "text", text }])
	} catch (error) {
		console.warn("[read_file] Token counting failed; using UTF-8 byte estimate", error)
		return Buffer.byteLength(text, "utf8")
	}
}

async function readBudgetedLines(
	lines: AsyncIterable<string>,
	options: ReadWithBudgetOptions,
): Promise<ReadWithBudgetResult> {
	const { budgetTokens, chunkLines = 64, startLine = 1, endLine, includeLineNumbers = false } = options
	if (!Number.isFinite(budgetTokens) || budgetTokens < 0) throw new Error("Invalid file token budget")
	if (!Number.isSafeInteger(chunkLines) || chunkLines < 1) throw new Error("Invalid chunk size")
	if (
		!Number.isSafeInteger(startLine) ||
		startLine < 1 ||
		(endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < startLine))
	) {
		throw new Error("Invalid line range: use positive integers with start <= end")
	}
	const accepted: string[] = []
	let pending: string[] = []
	let tokenCount = 0
	let characters = 0
	let pendingCharacters = 0
	let lineNumber = 0
	const render = (candidate: string[]) => {
		const text = candidate.join("\n")
		return includeLineNumbers ? addLineNumbers(candidate.length ? text + "\n" : "", startLine) : text
	}
	const flush = async (): Promise<boolean> => {
		if (!pending.length) return true
		const candidate = [...accepted, ...pending]
		const tokens = await measure(render(candidate))
		if (tokens <= budgetTokens) {
			accepted.push(...pending)
			tokenCount = tokens
			characters += pendingCharacters
			pending = []
			pendingCharacters = 0
			return true
		}
		let low = 0
		let high = pending.length
		while (low < high) {
			const mid = Math.ceil((low + high) / 2)
			const count = await measure(render([...accepted, ...pending.slice(0, mid)]))
			if (count <= budgetTokens) {
				low = mid
				tokenCount = count
			} else high = mid - 1
		}
		accepted.push(...pending.slice(0, low))
		pending = []
		return false
	}
	const result = (complete: boolean): ReadWithBudgetResult => ({
		content: accepted.join("\n"),
		tokenCount,
		lineCount: accepted.length,
		complete,
	})
	for await (const line of lines) {
		lineNumber++
		if (lineNumber < startLine) continue
		if (endLine !== undefined && lineNumber > endLine) break
		if (characters + pendingCharacters + line.length + 1 > MAX_FILE_READ_CHARACTERS) {
			await flush()
			return result(false)
		}
		pending.push(line)
		pendingCharacters += line.length + 1
		if (pending.length >= chunkLines && !(await flush())) return result(false)
		if (lineNumber === endLine) break
	}
	if (lineNumber < startLine && startLine > 1) throw new RangeError(`Start line ${startLine} is beyond end of file`)
	return result(await flush())
}

/** Read sequentially: no concurrent line/close callbacks or resume of a closed readline. */
export async function readFileWithTokenBudget(
	filePath: string,
	options: ReadWithBudgetOptions,
): Promise<ReadWithBudgetResult> {
	const stream = createReadStream(filePath, { encoding: "utf8" })
	const lines = createInterface({ input: stream, crlfDelay: Infinity })
	try {
		return await readBudgetedLines(lines, options)
	} finally {
		lines.close()
		stream.destroy()
	}
}

/** Apply the same response budget to extracted documents and code definitions. */
export async function readTextWithTokenBudget(
	text: string,
	options: ReadWithBudgetOptions,
): Promise<ReadWithBudgetResult> {
	async function* lines() {
		if (!text) return
		const parts = text.split(/\r?\n/)
		if (parts[parts.length - 1] === "") parts.pop()
		for (const line of parts) yield line
	}
	return readBudgetedLines(lines(), options)
}
