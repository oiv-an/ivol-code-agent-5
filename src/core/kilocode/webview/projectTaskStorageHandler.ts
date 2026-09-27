// kilocode_change - new file
import type { HistoryItem, ProjectTaskCopyProgress, WebviewMessage } from "@roo-code/types"
import type { ClineProvider } from "../../webview/ClineProvider"
import {
	configureProjectTaskStorage,
	copyTasksToProject,
	readProjectTaskStorage,
	applyProjectTaskVisibility,
	getProjectTasksToCopy,
} from "../../../services/kilocode/project-task-storage"
import { getStorageBasePath } from "../../../utils/storage"

interface StorageOperation {
	running: boolean
	copyProgress?: ProjectTaskCopyProgress
	copied?: number
	error?: string
}
// Keep the latest result as well as active progress when settings are unmounted.
const operations = new Map<string, StorageOperation>()

export async function handleProjectTaskStorage(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	const workspace = provider.cwd
	const publish = async () => {
		const operation = operations.get(workspace)
		let config
		let tasksToCopy = 0
		let error = operation?.error
		try {
			config = readProjectTaskStorage(workspace)
			tasksToCopy = getProjectTasksToCopy(
				workspace,
				provider.contextProxy.rawContext.globalState.get("taskHistory") ?? [],
			).length
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause)
		}
		try {
			await provider.postMessageToWebview({
				type: "projectTaskStorage",
				projectTaskStorage: {
					workspace,
					enabled: config?.enabled ?? true,
					hide: config?.hide ?? true,
					tasksToCopy,
					busy: !!provider.getCurrentTask() || !!operation?.running,
					copied: operation?.copied,
					copyProgress: operation?.copyProgress,
					error,
				},
			})
		} catch (cause) {
			// Delivery failure must not affect copying; the next get restores state.
			console.error("Project task storage notification:", cause)
		}
	}
	if (message.type === "getProjectTaskStorage" || operations.get(workspace)?.running) {
		await publish()
		return
	}
	const operation: StorageOperation = { running: true }
	operations.set(workspace, operation)
	try {
		if (provider.getCurrentTask())
			throw new Error(
				"Close the current task before changing its storage or copying history. Also close this project's tasks in other IDE windows.",
			)
		if (message.type === "setProjectTaskStorage") {
			const options = message.projectTaskStorage
			if (!options || typeof options.enabled !== "boolean" || typeof options.hide !== "boolean")
				throw new Error("Invalid task storage options.")
			await publish()
			await configureProjectTaskStorage(workspace, options.enabled, options.hide)
			await applyProjectTaskVisibility(workspace, options.hide)
		} else if (message.type === "copyTasksToProject") {
			const history = provider.contextProxy.rawContext.globalState.get<HistoryItem[]>("taskHistory") ?? []
			operation.copyProgress = {
				phase: "preparing",
				copied: 0,
				total: getProjectTasksToCopy(workspace, history).length,
			}
			operation.copied = 0
			await publish()
			operation.copied = await copyTasksToProject(
				workspace,
				await getStorageBasePath(provider.contextProxy.globalStorageUri.fsPath),
				history,
				(progress) => {
					operation.copyProgress = progress
					operation.copied = progress.copied
					void publish()
				},
			)
			operation.copyProgress = { ...operation.copyProgress, copied: operation.copied, phase: "completed" }
		}
		await provider.refreshProjectTaskHistory()
	} catch (cause) {
		operation.error = cause instanceof Error ? cause.message : String(cause)
		if (operation.copyProgress) operation.copyProgress = { ...operation.copyProgress, phase: "failed" }
		console.error("Project task storage:", cause)
	} finally {
		operation.running = false
	}
	await publish()
}
