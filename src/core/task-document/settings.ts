// kilocode_change - new file
import path from "node:path"
import type { WorkspaceFolder } from "vscode"
import { isIntelligentContextResetEnabled, type TaskDocumentSettings } from "@roo-code/types"
import type { KiloCodeWrapperProperties } from "../../shared/kilocode/wrapper"
import { DEFAULT_TASK_DOCUMENT_FILE } from "./document"

export interface TaskDocumentSettingsEnvironment {
	appName: string
	wrapper: KiloCodeWrapperProperties | undefined
	workspacePath: string | undefined
	spawnedAgent: boolean
}

export interface ContextMemoryConfiguration {
	intelligentTaskEnabled?: boolean
	intelligentContextResetEnabled?: boolean
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
		enabled: supported && configuration.intelligentTaskEnabled === true,
		fileName: DEFAULT_TASK_DOCUMENT_FILE,
		supported,
	}
}

/** A new mode never silently disables the existing handoff on unsupported editions. */
export function resolveContextMemoryMode(
	configuration: ContextMemoryConfiguration,
	supported: boolean,
): "task" | "handoff" | "standard" {
	if (supported && configuration.intelligentTaskEnabled === true) return "task"
	return isIntelligentContextResetEnabled(configuration.intelligentContextResetEnabled) ? "handoff" : "standard"
}
