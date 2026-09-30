import * as vscode from "vscode"
import type { AdvisorState } from "@roo-code/types"
import { getKiloCodeWrapperProperties } from "../../../core/kilocode/wrapper"
import { inspectAdvisorUsage } from "./projectUsage"

// Inventory only: never activate extensions, read legacy storage or change settings.
export class AdvisorService {
	async getState(): Promise<AdvisorState> {
		const folders = vscode.workspace.workspaceFolders ?? []
		const platformSupported = !getKiloCodeWrapperProperties().kiloCodeWrapped
		const state: AdvisorState = {
			workspace: folders[0]?.uri.toString() ?? "",
			platformSupported,
			canScan: platformSupported && folders.length === 1 && vscode.workspace.isTrusted,
			entries: [],
			checked: false,
		}
		if (!platformSupported || !folders.length) return state
		const usage = inspectAdvisorUsage(folders[0].uri)
		state.entries = vscode.extensions.all.map((extension) => {
			const id = extension.id.toLowerCase()
			const usageReasons = usage.get(id) ?? []
			return {
				id,
				name: extension.packageJSON.displayName || id,
				version: extension.packageJSON.version,
				active: extension.isActive,
				protected: usageReasons.length > 0,
				usageReasons,
			}
		})
		return state
	}
}
