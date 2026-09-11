// kilocode_change - new file
import * as vscode from "vscode"
import fs from "fs/promises"
import os from "os"
import * as path from "path"

/**
 * Opens a native file picker without any type filters so the user can attach
 * ANY file from the file system (not just images) to the chat input.
 *
 * @returns Absolute file system paths of the selected files.
 */
export async function selectAnyFiles(): Promise<string[]> {
	const options: vscode.OpenDialogOptions = {
		canSelectMany: true,
		canSelectFiles: true,
		canSelectFolders: false,
		openLabel: "Attach",
		title: "Attach files to chat",
	}

	const fileUris = await vscode.window.showOpenDialog(options)

	if (!fileUris || fileUris.length === 0) {
		return []
	}

	return fileUris.map((uri) => uri.fsPath)
}

export interface DroppedFilePayload {
	name: string
	/** Base64 encoded file contents. */
	data: string
}

/** Maximum size (base64 decoded) accepted for a dropped file fallback: 20 MB. */
const MAX_DROPPED_FILE_BYTES = 20 * 1024 * 1024

function sanitizeFileName(name: string): string {
	const base = path.basename(name).replace(/[\\/:*?"<>|]/g, "_")
	return base.length > 0 ? base.slice(0, 180) : "attachment"
}

/**
 * Fallback for drag & drop: webviews only expose file *contents*, not the
 * original path. We persist the bytes into a temp directory and hand back real
 * file system paths so the model can read them with `read_file`.
 */
export async function saveDroppedFiles(files: DroppedFilePayload[]): Promise<string[]> {
	if (!files || files.length === 0) {
		return []
	}

	const targetDir = path.join(os.tmpdir(), "kilocode-attachments", `${Date.now()}`)
	await fs.mkdir(targetDir, { recursive: true })

	const savedPaths: string[] = []

	for (const file of files) {
		try {
			const buffer = Buffer.from(file.data ?? "", "base64")

			if (buffer.byteLength === 0 || buffer.byteLength > MAX_DROPPED_FILE_BYTES) {
				console.warn(`[saveDroppedFiles] Skipping "${file.name}" (size ${buffer.byteLength} bytes)`)
				continue
			}

			const targetPath = path.join(targetDir, sanitizeFileName(file.name))
			await fs.writeFile(targetPath, buffer)
			savedPaths.push(targetPath)
		} catch (error) {
			console.error(`[saveDroppedFiles] Failed to persist "${file?.name}":`, error)
		}
	}

	return savedPaths
}
