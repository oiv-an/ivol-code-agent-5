// kilocode_change - new file
import os from "os"
import path from "path"
import fs from "fs/promises"
import * as vscode from "vscode"
import type { ClineProvider } from "../../webview/ClineProvider"

export function getGlobalInstructionsPath(): string {
	return path.join(os.homedir(), ".kilocode", "rules", "GLOBAL_INSTRUCTIONS.md")
}

export function globalInstructionsTemplate(filePath: string): string {
	return `# Global instructions

This file contains user instructions shared by IVOL Code projects on this extension host.
Canonical file: ${filePath}
Open and edit it through Settings → IVOL → Global rules, or edit this file directly.
Saved rules are loaded for subsequent model requests when this rule file is enabled.

## Maintaining shared rules

- When the user explicitly asks to make instructions global or apply them to all projects, update this canonical file rather than copying rules into each project.
- Reread this file before editing it and preserve unrelated instructions.
- Keep project-specific instructions in the project unless the user explicitly asks to make them global.
- Do not automatically migrate existing project rules or settings into this file.

## User rules

`
}

export async function ensureGlobalInstructions(): Promise<string> {
	const filePath = getGlobalInstructionsPath()
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	try {
		await fs.writeFile(filePath, globalInstructionsTemplate(filePath), { encoding: "utf8", flag: "wx" })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
	}
	return filePath
}

export async function handleGlobalInstructions(provider: ClineProvider, open: boolean): Promise<void> {
	const filePath = getGlobalInstructionsPath()
	try {
		if (open) {
			await ensureGlobalInstructions()
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
			await vscode.window.showTextDocument(document, { preview: false })
		}
		await provider.postMessageToWebview({ type: "globalInstructions", globalInstructions: { path: filePath } })
	} catch (error) {
		await provider.postMessageToWebview({
			type: "globalInstructions",
			globalInstructions: { path: filePath, error: error instanceof Error ? error.message : String(error) },
		})
	}
}
