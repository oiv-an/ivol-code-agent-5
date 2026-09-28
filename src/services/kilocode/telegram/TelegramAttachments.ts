import * as path from "node:path"
import { constants } from "node:fs"
import { open, realpath, type FileHandle } from "node:fs/promises"
import type { ClineMessage } from "@roo-code/types"

/**
 * Node 20 has no openat binding. Linux procfs lets us resolve one component at a
 * time relative to a pinned directory, with O_NOFOLLOW on EVERY component.
 * Never fall back to an absolute pathname: checking it again cannot prevent ABA
 * parent swaps. Darwin /dev/fd does not support directory-relative lookup, and
 * Windows needs native handle-relative/reparse-point APIs we do not have here.
 */
async function openPinnedImage(root: string, relative: string): Promise<FileHandle> {
	if (process.platform !== "linux" || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
		throw new Error("Secure Telegram local image attachments are unsupported on this platform")
	}
	const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
	let directory = await open(path.parse(root).root, directoryFlags)
	try {
		// Anchor the canonical workspace itself without trusting mutable parents.
		const components = [...root.split(path.sep).filter(Boolean), ...relative.split(path.sep)]
		const basename = components.pop()!
		for (const component of components) {
			const next = await open(`/proc/self/fd/${directory.fd}/${component}`, directoryFlags)
			const previous = directory
			directory = next
			await previous.close()
		}
		// NONBLOCK prevents a substituted FIFO from hanging before fstat rejects it.
		return await open(
			`/proc/self/fd/${directory.fd}/${basename}`,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		)
	} finally {
		await directory.close()
	}
}

/** Only the explicit image attachment row rendered by ChatRow grants access to a local image. */
export async function readTelegramImageAttachment(message: ClineMessage, cwd: string): Promise<string | undefined> {
	if (message.type !== "say" || message.say !== "image" || message.partial) return
	const attachment = JSON.parse(message.text ?? "{}") as { imageUri?: unknown; imagePath?: unknown }
	if (
		typeof attachment.imageUri !== "string" ||
		!attachment.imageUri ||
		typeof attachment.imagePath !== "string" ||
		!path.isAbsolute(attachment.imagePath)
	) {
		throw new Error("Invalid Telegram image attachment")
	}
	const root = await realpath(cwd)
	const target = await realpath(attachment.imagePath)
	const relative = path.relative(root, target)
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("Telegram image attachment is outside the workspace")
	}
	const file = await openPinnedImage(root, relative)
	try {
		const stat = await file.stat()
		if (!stat.isFile() || stat.size === 0 || stat.size > 14_000_000)
			throw new Error("Unsupported Telegram image size")
		// Bounded even when another process grows the file after stat.
		const bytes = Buffer.alloc(stat.size + 1)
		let length = 0
		while (length < bytes.length) {
			const result = await file.read(bytes, length, bytes.length - length, length)
			if (!result.bytesRead) break
			length += result.bytesRead
		}
		if (length !== stat.size) throw new Error("Telegram image changed during reading")
		const data = bytes.subarray(0, length)
		const mime = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
			? "png"
			: data[0] === 255 && data[1] === 216 && data[2] === 255
				? "jpeg"
				: ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString())
					? "gif"
					: data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP"
						? "webp"
						: undefined
		if (!mime) throw new Error("Unsupported Telegram image format")
		return `data:image/${mime};base64,${data.toString("base64")}`
	} finally {
		await file.close()
	}
}
