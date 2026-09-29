// kilocode_change - new file
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { TextDecoder } from "node:util"
import type { CheckpointDiff } from "./types"

export const DIFF_LIMITS = {
	fileBytes: 1024 * 1024,
	totalBytes: 8 * 1024 * 1024,
	files: 500,
	metadataBytes: 4 * 1024 * 1024,
}

export function checkpointGit(
	cwd: string,
	args: string[],
	signal?: AbortSignal,
	maxBuffer = DIFF_LIMITS.metadataBytes,
): Promise<Buffer> {
	const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_") && key !== "GIT_OPTIONAL_LOCKS" && key !== "GIT_TERMINAL_PROMPT")
			delete env[key as keyof typeof env]
	}
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["--no-pager", ...args],
			{ cwd, env, encoding: "buffer", maxBuffer, timeout: 15_000, signal },
			(error, stdout) => {
				if (error) reject(error)
				else resolve(stdout)
			},
		)
	})
}

export async function resolveDiffRef(cwd: string, ref: string, signal?: AbortSignal): Promise<string> {
	return (await checkpointGit(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], signal, 1024))
		.toString()
		.trim()
}

export async function hasCheckpointChanges(
	cwd: string,
	from: string,
	to: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const before = await resolveDiffRef(cwd, from, signal)
	const after = await resolveDiffRef(cwd, to, signal)
	// Compare tree IDs: no file content, patch generation, or staging is needed.
	const trees = await checkpointGit(cwd, ["rev-parse", `${before}^{tree}`, `${after}^{tree}`], signal, 1024)
	const [a, b] = trees.toString().trim().split("\n")
	return a !== b
}

class Omitted extends Error {}

export async function readCheckpointDiff(
	cwd: string,
	workspace: string,
	from: string,
	to?: string,
	signal?: AbortSignal,
): Promise<CheckpointDiff[]> {
	const before = await resolveDiffRef(cwd, from, signal)
	const after = to ? await resolveDiffRef(cwd, to, signal) : undefined
	// Raw metadata avoids asking Git to diff/decode multi-gigabyte binary blobs.
	const raw = await checkpointGit(
		cwd,
		[
			"diff",
			"--raw",
			"-z",
			"--no-renames",
			"--no-abbrev",
			"--no-ext-diff",
			"--no-textconv",
			before,
			...(after ? [after] : []),
			"--",
		],
		signal,
	)
	const parts = raw.toString("utf8").split("\0")
	const result: CheckpointDiff[] = []
	let remaining = DIFF_LIMITS.totalBytes
	const decoder = new TextDecoder("utf-8", { fatal: true })

	async function readSide(oid: string, mode: string, absolute: string, working: boolean): Promise<string> {
		signal?.throwIfAborted()
		if (mode === "000000") return ""
		if (!/^100[0-7]{3}$/.test(mode)) throw new Omitted("Non-regular file")
		let bytes: Buffer
		if (working) {
			const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
			try {
				const stat = await handle.stat()
				if (!stat.isFile()) throw new Omitted("Non-regular file")
				if (stat.size > DIFF_LIMITS.fileBytes) throw new Omitted("File exceeds the 1 MiB preview limit")
				if (stat.size > remaining) throw new Omitted("Comparison exceeds the 8 MiB preview budget")
				// Bounded even when a working file grows between stat and read.
				const buffer = Buffer.alloc(Math.min(DIFF_LIMITS.fileBytes, remaining) + 1)
				let length = 0
				while (length < buffer.length) {
					signal?.throwIfAborted()
					const chunk = await handle.read(buffer, length, buffer.length - length, length)
					if (!chunk.bytesRead) break
					length += chunk.bytesRead
				}
				if (length > DIFF_LIMITS.fileBytes || length > remaining)
					throw new Omitted("File grew beyond the preview limit")
				bytes = buffer.subarray(0, length)
			} finally {
				await handle.close()
			}
		} else {
			if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error("Invalid checkpoint object ID")
			const size = Number((await checkpointGit(cwd, ["cat-file", "-s", oid], signal, 128)).toString().trim())
			if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid checkpoint object size")
			if (size > DIFF_LIMITS.fileBytes) throw new Omitted("File exceeds the 1 MiB preview limit")
			if (size > remaining) throw new Omitted("Comparison exceeds the 8 MiB preview budget")
			bytes = await checkpointGit(cwd, ["cat-file", "blob", oid], signal, Math.max(1, size))
		}
		remaining -= bytes.length
		if (bytes.includes(0)) throw new Omitted("Binary file")
		try {
			return decoder.decode(bytes)
		} catch {
			throw new Omitted("Binary or non-UTF-8 file")
		}
	}

	for (let i = 0; i + 1 < parts.length && parts[i]; i += 2) {
		signal?.throwIfAborted()
		const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])$/.exec(parts[i])
		if (!match) throw new Error("Invalid checkpoint diff metadata")
		const relative = parts[i + 1]
		const absolute = path.resolve(workspace, relative)
		const relativeCheck = path.relative(workspace, absolute)
		if (
			!relativeCheck ||
			relativeCheck === ".." ||
			relativeCheck.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relativeCheck)
		)
			throw new Error("Invalid checkpoint path")
		let reason: string | undefined
		let oldText = "",
			newText = ""
		if (result.length >= DIFF_LIMITS.files) {
			const omitted = Math.floor((parts.length - i - 1) / 2)
			reason = `File count limit reached; ${omitted} additional files not previewed`
		} else {
			try {
				oldText = await readSide(match[3], match[1], absolute, false)
				newText = await readSide(match[4], match[2], absolute, !after)
			} catch (error) {
				signal?.throwIfAborted()
				if (!(error instanceof Omitted)) throw error
				reason = error.message
			}
		}
		if (reason) {
			// Never display one real side against an empty side: that suggests a deletion.
			oldText = newText = `[Preview omitted: ${reason}. Checkpoint contents and restore are unchanged.]`
		}
		result.push({
			paths: { relative, absolute },
			content: { before: oldText, after: newText },
			...(reason ? { omitted: reason } : {}),
		})
		if (result.length > DIFF_LIMITS.files) break
	}
	return result
}
