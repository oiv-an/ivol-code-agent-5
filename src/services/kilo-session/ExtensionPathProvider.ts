import * as vscode from "vscode"
import * as path from "path"
import { createHash } from "crypto"
import { existsSync, mkdirSync } from "fs"
import type { IPathProvider } from "../../shared/kilocode/cli-sessions/types/IPathProvider"
// kilocode_change start
import { getTaskDirectoryPath } from "../../utils/storage"
import { resolveProjectTaskDirectory } from "../kilocode/project-task-storage"
import { getWorkspacePath } from "../../utils/path"
// kilocode_change end

export class ExtensionPathProvider implements IPathProvider {
	private readonly globalStoragePath: string

	constructor(context: vscode.ExtensionContext) {
		this.globalStoragePath = context.globalStorageUri.fsPath
	}

	getTasksDir(): string {
		return path.join(this.globalStoragePath, "tasks")
	}

	// kilocode_change start
	async getTaskDir(taskId: string): Promise<string> {
		resolveProjectTaskDirectory(taskId, getWorkspacePath(), true)
		return getTaskDirectoryPath(this.globalStoragePath, taskId)
	}
	// kilocode_change end

	getSessionFilePath(workspaceName: string): string {
		const hash = createHash("sha256").update(workspaceName).digest("hex").substring(0, 16)
		const workspaceDir = path.join(this.globalStoragePath, "sessions", hash)

		if (!existsSync(workspaceDir)) {
			mkdirSync(workspaceDir, { recursive: true })
		}

		return path.join(workspaceDir, "session.json")
	}
}
