import { isIntelligentTaskEnabled } from "@roo-code/types" // kilocode_change
// kilocode_change - new file
import path from "node:path"
import type { WorkspaceFolder } from "vscode"
import type { TaskDocumentSettings } from "@roo-code/types"
import type { KiloCodeWrapperProperties } from "../../shared/kilocode/wrapper"
const DEFAULT_TASK_DOCUMENT_FILE = "CURRENT_TASK.md"

export interface TaskDocumentSettingsEnvironment {
	appName: string
	wrapper: KiloCodeWrapperProperties | undefined
	workspacePath: string | undefined
	spawnedAgent: boolean
}

export interface ContextMemoryConfiguration {
	intelligentTaskEnabled?: boolean
}

/** Never turn the generic HOME/current-directory fallback into an opted-in project. */
export function getTaskDocumentWorkspacePath(
	cwd: string | undefined,
	folders: readonly WorkspaceFolder[] | undefined,
): string | undefined {
	if (!cwd || !path.isAbsolute(cwd)) return undefined
	const resolvedCwd = path.resolve(cwd)
	const folder = folders?.find(
		({ uri }) => uri.scheme === "file" && path.isAbsolute(uri.fsPath) && path.resolve(uri.fsPath) === resolvedCwd,
	)
	return folder ? resolvedCwd : undefined
}

export function isTaskDocumentSupported(environment: TaskDocumentSettingsEnvironment): boolean {
	if (!environment.workspacePath || environment.spawnedAgent) return false
	const { wrapper, appName } = environment
	if (!wrapper) return false
	// The rollout covers only editions for which this fork produces and verifies packages.
	if (wrapper.kiloCodeWrapped) {
		return (
			wrapper.kiloCodeWrapper === "jetbrains" &&
			wrapper.kiloCodeWrapperJetbrains === true &&
			["PS", "IU", "PY"].includes(wrapper.kiloCodeWrapperCode ?? "")
		)
	}
	return appName === "Visual Studio Code" || appName === "Visual Studio Code - Insiders"
}

export function resolveTaskDocumentSettings(
	configuration: Pick<ContextMemoryConfiguration, "intelligentTaskEnabled">,
	environment: TaskDocumentSettingsEnvironment,
): TaskDocumentSettings {
	const supported = isTaskDocumentSupported(environment)
	return {
		enabled: supported && isIntelligentTaskEnabled(configuration.intelligentTaskEnabled),
		fileName: DEFAULT_TASK_DOCUMENT_FILE,
		supported,
	}
}

/** An unsupported edition always falls back to ordinary condensing. */
export function resolveContextMemoryMode(
	configuration: ContextMemoryConfiguration,
	supported: boolean,
): "task" | "standard" {
	return supported && isIntelligentTaskEnabled(configuration.intelligentTaskEnabled) ? "task" : "standard"
}
