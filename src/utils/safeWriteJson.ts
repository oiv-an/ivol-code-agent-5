import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import * as lockfile from "proper-lockfile"
import Disassembler from "stream-json/Disassembler"
import Stringer from "stream-json/Stringer"

/**
 * Safely writes JSON data to a file.
 * - Creates parent directories if they don't exist
 * - Uses 'proper-lockfile' for inter-process advisory locking to prevent concurrent writes to the same path.
 * - Writes and fsyncs a temporary file in the target directory first.
 * - Copies (rather than moves) the old target to a backup before commit.
 * - Atomically replaces the target and best-effort fsyncs its directory.
 * - Keeps the canonical target available throughout a failed commit.
 *
 * @param {string} filePath - The absolute path to the target file.
 * @param {any} data - The data to serialize to JSON and write.
 * @returns {Promise<void>}
 */

async function safeWriteJson(filePath: string, data: any): Promise<void> {
	const absoluteFilePath = path.resolve(filePath)
	let releaseLock = async () => {} // Initialized to a no-op

	// For directory creation
	const dirPath = path.dirname(absoluteFilePath)

	// Ensure directory structure exists with improved reliability
	try {
		// Create directory with recursive option
		await fs.mkdir(dirPath, { recursive: true })

		// Verify directory exists after creation attempt
		await fs.access(dirPath)
	} catch (dirError: any) {
		console.error(`Failed to create or access directory for ${absoluteFilePath}:`, dirError)
		throw dirError
	}

	// Acquire the lock before any file operations
	try {
		releaseLock = await lockfile.lock(absoluteFilePath, {
			stale: 31000, // Stale after 31 seconds
			update: 10000, // Update mtime every 10 seconds to prevent staleness if operation is long
			realpath: false, // the file may not exist yet, which is acceptable
			retries: {
				// Configuration for retrying lock acquisition
				retries: 5, // Number of retries after the initial attempt
				factor: 2, // Exponential backoff factor (e.g., 100ms, 200ms, 400ms, ...)
				minTimeout: 100, // Minimum time to wait before the first retry (in ms)
				maxTimeout: 1000, // Maximum time to wait for any single retry (in ms)
			},
			onCompromised: (err) => {
				console.error(`Lock at ${absoluteFilePath} was compromised:`, err)
				throw err
			},
		})
	} catch (lockError) {
		// If lock acquisition fails, we throw immediately.
		// The releaseLock remains a no-op, so the finally block in the main file operations
		// try-catch-finally won't try to release an unacquired lock if this path is taken.
		console.error(`Failed to acquire lock for ${absoluteFilePath}:`, lockError)
		// Propagate the lock acquisition error
		throw lockError
	}

	// Variables to hold the actual paths of temporary files if they are created.
	let actualTempNewFilePath: string | null = null
	let actualTempBackupFilePath: string | null = null

	try {
		// Step 1: Write data to a new temporary file.
		actualTempNewFilePath = path.join(
			path.dirname(absoluteFilePath),
			`.${path.basename(absoluteFilePath)}.new_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`,
		)

		await _streamDataToFile(actualTempNewFilePath, data)
		await syncFile(actualTempNewFilePath)

		// Step 2: Preserve the previous version without ever removing the
		// canonical target. This avoids a crash window between two renames.
		if (await fileExists(absoluteFilePath)) {
			actualTempBackupFilePath = path.join(
				path.dirname(absoluteFilePath),
				`.${path.basename(absoluteFilePath)}.bak_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`,
			)
			await fs.copyFile(absoluteFilePath, actualTempBackupFilePath, fsSync.constants.COPYFILE_EXCL)
			await syncFile(actualTempBackupFilePath)
			await syncDirectoryBestEffort(dirPath)
		}

		// Step 3: Rename the new temporary file to the target file path.
		// Same-directory rename is the single atomic commit step: on failure the
		// old target remains at its canonical path.
		await fs.rename(actualTempNewFilePath, absoluteFilePath)
		actualTempNewFilePath = null
		await syncDirectoryBestEffort(dirPath)

		// Step 4: The commit is complete. A stale backup is harmless and more
		// useful than turning a successful write into an error.
		if (actualTempBackupFilePath) {
			try {
				await fs.unlink(actualTempBackupFilePath)
				actualTempBackupFilePath = null
			} catch (unlinkBackupError) {
				// Log this error, but do not re-throw. The main operation was successful.
				// actualTempBackupFilePath remains set, indicating an orphaned backup.
				console.error(
					`Successfully wrote ${absoluteFilePath}, but failed to clean up backup ${actualTempBackupFilePath}:`,
					unlinkBackupError,
				)
			}
		}
	} catch (originalError) {
		console.error(`Operation failed for ${absoluteFilePath}: [Original Error Caught]`, originalError)

		// Atomic rename failures should leave the old target in place. If an
		// unusual filesystem violates that guarantee, restore the copied backup.
		let canonicalFileExists: boolean | undefined
		try {
			canonicalFileExists = await fileExists(absoluteFilePath)
		} catch (availabilityError) {
			console.error(`Could not verify ${absoluteFilePath} after a failed write:`, availabilityError)
		}

		if (actualTempBackupFilePath && canonicalFileExists === false) {
			try {
				await fs.rename(actualTempBackupFilePath, absoluteFilePath)
				actualTempBackupFilePath = null
				canonicalFileExists = true
				await syncDirectoryBestEffort(dirPath)
			} catch (rollbackError) {
				console.error(
					`[Catch] Failed to restore backup ${actualTempBackupFilePath} to ${absoluteFilePath}:`,
					rollbackError,
				)
			}
		}

		if (actualTempNewFilePath) {
			try {
				await fs.unlink(actualTempNewFilePath)
				actualTempNewFilePath = null
			} catch (cleanupError: any) {
				if (cleanupError?.code === "ENOENT") {
					actualTempNewFilePath = null
				} else {
					console.error(
						`[Catch] Failed to clean up temporary new file ${actualTempNewFilePath}:`,
						cleanupError,
					)
				}
			}
		}

		// Delete a backup only when the canonical file is known to be available.
		// Otherwise preserve the backup as the last recoverable copy.
		if (actualTempBackupFilePath && canonicalFileExists === true) {
			try {
				await fs.unlink(actualTempBackupFilePath)
				actualTempBackupFilePath = null
			} catch (cleanupError) {
				console.error(
					`[Catch] Failed to clean up temporary backup file ${actualTempBackupFilePath}:`,
					cleanupError,
				)
			}
		} else if (actualTempBackupFilePath) {
			console.error(
				`Preserving backup ${actualTempBackupFilePath} because ${absoluteFilePath} could not be restored or verified`,
			)
		}
		throw originalError
	} finally {
		// Release the lock in the main finally block.
		try {
			// releaseLock will be the actual unlock function if lock was acquired,
			// or the initial no-op if acquisition failed.
			await releaseLock()
		} catch (unlockError) {
			// Do not re-throw here, as the originalError from the try/catch (if any) is more important.
			console.error(`Failed to release lock for ${absoluteFilePath}:`, unlockError)
		}
	}
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.lstat(filePath)
		return true
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return false
		}
		throw error
	}
}

async function syncFile(filePath: string): Promise<void> {
	// kilocode_change start: Windows FlushFileBuffers requires write access.
	// Reopen without truncation; both the new JSON and copied backup must sync.
	const handle = await fs.open(filePath, "r+")
	// kilocode_change end
	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
}

async function syncDirectoryBestEffort(directoryPath: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof fs.open>> | undefined
	try {
		handle = await fs.open(directoryPath, "r")
		await handle.sync()
	} catch {
		// Opening or fsyncing directories is unavailable on some supported
		// platforms/filesystems. The atomic rename still preserves availability.
	} finally {
		await handle?.close().catch(() => undefined)
	}
}

/**
 * Helper function to stream JSON data to a file.
 * @param targetPath The path to write the stream to.
 * @param data The data to stream.
 * @returns Promise<void>
 */
async function _streamDataToFile(targetPath: string, data: any): Promise<void> {
	// Stream data to avoid high memory usage for large JSON objects.
	const fileWriteStream = fsSync.createWriteStream(targetPath, {
		encoding: "utf8",
		flags: "wx",
		mode: 0o600,
	})
	const disassembler = Disassembler.disassembler()
	// Output will be compact JSON as standard Stringer is used.
	const stringer = Stringer.stringer()

	return new Promise<void>((resolve, reject) => {
		let errorOccurred = false
		const handleError = (_streamName: string) => (err: Error) => {
			if (!errorOccurred) {
				errorOccurred = true
				if (!fileWriteStream.destroyed) {
					fileWriteStream.destroy(err)
				}
				reject(err)
			}
		}

		disassembler.on("error", handleError("Disassembler"))
		stringer.on("error", handleError("Stringer"))
		fileWriteStream.on("error", (err: Error) => {
			if (!errorOccurred) {
				errorOccurred = true
				reject(err)
			}
		})

		fileWriteStream.on("finish", () => {
			if (!errorOccurred) {
				resolve()
			}
		})

		disassembler.pipe(stringer).pipe(fileWriteStream)

		// stream-json's Disassembler might error if `data` is undefined.
		// JSON.stringify(undefined) would produce the string "undefined" if it's the root value.
		// Writing 'null' is a safer JSON representation for a root undefined value.
		if (data === undefined) {
			disassembler.write(null)
		} else {
			disassembler.write(data)
		}
		disassembler.end()
	})
}

export { safeWriteJson }
