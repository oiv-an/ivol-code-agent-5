import type { ExtensionContext } from "vscode"

export function getUserAgent(context?: ExtensionContext): string {
	return `IVOL-Code ${context?.extension?.packageJSON?.version || "unknown"}`
}
