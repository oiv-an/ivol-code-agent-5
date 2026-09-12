import * as fs from "fs/promises"
import * as path from "path"
import { getTaskDirectoryPath } from "../../../utils/storage"
import { safeWriteJson } from "../../../utils/safeWriteJson"
import type { PreparationTrigger } from "./OrdinaryContextPreparation"

const triggers: PreparationTrigger[] = ["manual", "automatic", "forced", "extended-thinking", "tool"]

/** Persist intent only. A crash must never preserve write evidence or a bypass decision. */
export async function saveOrdinaryPreparation(storage: string, taskId: string, trigger: PreparationTrigger | null) {
	const directory = await getTaskDirectoryPath(storage, taskId)
	await safeWriteJson(path.join(directory, "ordinary_context_preparation.json"), { version: 1, trigger })
}

export async function readOrdinaryPreparation(
	storage: string,
	taskId: string,
): Promise<PreparationTrigger | undefined> {
	const directory = await getTaskDirectoryPath(storage, taskId, false)
	try {
		const value = JSON.parse(await fs.readFile(path.join(directory, "ordinary_context_preparation.json"), "utf8"))
		if (value?.version === 1 && value.trigger === null) return undefined
		if (value?.version === 1 && triggers.includes(value.trigger)) return value.trigger
		// An unreadable intent cannot authorize silently dropping history.
		return "manual"
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		console.error("Failed to read pending context preparation", error)
		return "manual"
	}
}
