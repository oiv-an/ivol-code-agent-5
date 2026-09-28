// kilocode_change - new file
import { useEffect, useState } from "react"
import type { ExtensionMessage, TelegramState } from "@roo-code/types"
import { vscode } from "@src/utils/vscode"

export function useTelegramState(taskId?: string) {
	const [state, setState] = useState<TelegramState>()
	useEffect(() => {
		setState(undefined)
		const listener = (event: MessageEvent<ExtensionMessage>) => {
			if (event.data.type === "telegramState" && event.data.telegramState) setState(event.data.telegramState)
		}
		window.addEventListener("message", listener)
		vscode.postMessage({ type: "getTelegramState" })
		return () => window.removeEventListener("message", listener)
	}, [taskId])
	return state
}
