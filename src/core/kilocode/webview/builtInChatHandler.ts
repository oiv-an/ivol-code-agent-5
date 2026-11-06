// kilocode_change - new file
import * as vscode from "vscode"
import type { ClineProvider } from "../../webview/ClineProvider"

/**
 * VS Code user setting that turns off the editor's built-in AI chat (chat view, title bar
 * button, Copilot suggestions) in every window. Other chat.* keys are not written: VS Code
 * unregisters them once AI features are off, and writing unregistered keys fails.
 * Re-enabling removes our value so the VS Code default applies.
 */
export const BUILT_IN_CHAT_SETTING = "chat.disableAIFeatures"

export function isBuiltInChatDisabled(): boolean {
	return vscode.workspace.getConfiguration().inspect<boolean>(BUILT_IN_CHAT_SETTING)?.globalValue === true
}

export async function setBuiltInChatDisabled(disabled: boolean): Promise<void> {
	await vscode.workspace
		.getConfiguration()
		.update(BUILT_IN_CHAT_SETTING, disabled ? true : undefined, vscode.ConfigurationTarget.Global)
}

export async function handleBuiltInChat(provider: ClineProvider, disabled?: boolean): Promise<void> {
	try {
		if (disabled !== undefined) await setBuiltInChatDisabled(disabled)
		await provider.postMessageToWebview({
			type: "builtInChatDisabled",
			builtInChatDisabled: { disabled: isBuiltInChatDisabled() },
		})
	} catch (error) {
		await provider.postMessageToWebview({
			type: "builtInChatDisabled",
			builtInChatDisabled: {
				disabled: isBuiltInChatDisabled(),
				error: error instanceof Error ? error.message : String(error),
			},
		})
	}
}
