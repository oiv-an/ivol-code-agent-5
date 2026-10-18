import * as fs from "fs/promises"
import * as path from "path"
import { getTaskDirectoryPath } from "../../../utils/storage"
import { safeWriteJson } from "../../../utils/safeWriteJson"
import type { PreparationTrigger } from "./OrdinaryContextPreparation"

const triggers: PreparationTrigger[] = ["manual", "automatic", "forced", "extended-thinking", "tool"]

/**
 * Persist intent only. A crash must never preserve a bypass decision. The optional document hash
 * records which CURRENT_TASK.md content was verified; it is trusted after a restart only while the
 * file still has exactly that content.
 */
export async function saveOrdinaryPreparation(
	storage: string,
	taskId: string,
	trigger: PreparationTrigger | null,
	documentSha256?: string,
) {
	const directory = await getTaskDirectoryPath(storage, taskId)
	await safeWriteJson(path.join(directory, "ordinary_context_preparation.json"), {
		version: 1,
		trigger,
		...(trigger && documentSha256 ? { documentSha256 } : {}),
	})
}

async function readState(storage: string, taskId: string) {
	const directory = await getTaskDirectoryPath(storage, taskId, false)
	try {
		return JSON.parse(await fs.readFile(path.join(directory, "ordinary_context_preparation.json"), "utf8"))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		console.error("Failed to read pending context preparation", error)
		return { version: 0 }
	}
}

export async function readOrdinaryPreparation(
	storage: string,
	taskId: string,
): Promise<PreparationTrigger | undefined> {
	const value = await readState(storage, taskId)
	if (value === undefined) return undefined
	if (value?.version === 1 && value.trigger === null) return undefined
	if (value?.version === 1 && triggers.includes(value.trigger)) return value.trigger
	// An unreadable intent cannot authorize silently dropping history.
	return "manual"
}

/** Hash of the CURRENT_TASK.md content verified before an interrupted compression, if any. */
export async function readOrdinaryPreparationDocumentHash(storage: string, taskId: string) {
	const value = await readState(storage, taskId)
	return value?.version === 1 && typeof value.documentSha256 === "string"
		? (value.documentSha256 as string)
		: undefined
}
