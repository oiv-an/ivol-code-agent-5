import { safeWriteJson } from "../../utils/safeWriteJson"
import * as path from "path"
import * as fs from "fs/promises"

import type { ClineMessage } from "@roo-code/types"

import { fileExistsAtPath } from "../../utils/fs"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"

export type ReadTaskMessagesOptions = {
	taskId: string
	globalStoragePath: string
	mustExist?: boolean // kilocode_change: resumed tasks must never replace missing history with [].
}

export async function readTaskMessages({
	taskId,
	globalStoragePath,
	mustExist = false,
}: ReadTaskMessagesOptions): Promise<ClineMessage[]> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId, false) // kilocode_change
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
	const fileExists = await fileExistsAtPath(filePath)

	if (fileExists) {
		// kilocode_change start
		const messages = JSON.parse(await fs.readFile(filePath, "utf8"))
		if (!Array.isArray(messages)) throw new Error(`Invalid task messages: ${filePath}`)
		return messages
		// kilocode_change end
	}

	if (mustExist) throw new Error(`Task messages are missing; saved history was not modified: ${filePath}`) // kilocode_change
	return []
}

export type SaveTaskMessagesOptions = {
	messages: ClineMessage[]
	taskId: string
	globalStoragePath: string
}

export async function saveTaskMessages({ messages, taskId, globalStoragePath }: SaveTaskMessagesOptions) {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
	await safeWriteJson(filePath, messages)
}
