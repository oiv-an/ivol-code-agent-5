// kilocode_change - new file
import type { WebviewMessage } from "@roo-code/types"
import type { ClineProvider } from "../../webview/ClineProvider"
import {
	configureProjectTaskStorage,
	copyTasksToProject,
	readProjectTaskStorage,
	applyProjectTaskVisibility,
	getProjectTasksToCopy,
} from "../../../services/kilocode/project-task-storage"
import { getStorageBasePath } from "../../../utils/storage"

const operations = new Set<string>()

export async function handleProjectTaskStorage(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	const workspace = provider.cwd
	let copied: number | undefined
	let error: string | undefined
	let ownsOperation = false
	try {
		if (message.type !== "getProjectTaskStorage") {
			if (operations.has(workspace)) throw new Error("A task storage operation is already in progress.")
			if (provider.getCurrentTask())
				throw new Error(
					"Close the current task before changing its storage or copying history. Also close this project's tasks in other IDE windows.",
				)
			operations.add(workspace)
			ownsOperation = true
			if (message.type === "setProjectTaskStorage") {
				const options = message.projectTaskStorage
				if (!options || typeof options.enabled !== "boolean" || typeof options.hide !== "boolean")
					throw new Error("Invalid task storage options.")
				await configureProjectTaskStorage(workspace, options.enabled, options.hide)
				await applyProjectTaskVisibility(workspace, options.hide)
			} else if (message.type === "copyTasksToProject") {
				copied = await copyTasksToProject(
					workspace,
					await getStorageBasePath(provider.contextProxy.globalStorageUri.fsPath),
					provider.contextProxy.rawContext.globalState.get("taskHistory") ?? [],
				)
			}
			await provider.refreshProjectTaskHistory()
		}
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause)
		console.error("Project task storage:", cause)
	} finally {
		if (ownsOperation) operations.delete(workspace)
	}
	let config
	let tasksToCopy = 0
	try {
		config = readProjectTaskStorage(workspace)
		tasksToCopy = getProjectTasksToCopy(
			workspace,
			provider.contextProxy.rawContext.globalState.get("taskHistory") ?? [],
		).length
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause)
	}
	await provider.postMessageToWebview({
		type: "projectTaskStorage",
		projectTaskStorage: {
			workspace,
			enabled: config?.enabled ?? true,
			hide: config?.hide ?? true,
			tasksToCopy,
			busy: !!provider.getCurrentTask() || operations.has(workspace),
			copied,
			error,
		},
	})
}
