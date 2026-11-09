// kilocode_change - new file
import { useEffect, useRef } from "react"
import { Send, LoaderCircle } from "lucide-react"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useTelegramState } from "@src/hooks/useTelegramState"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"
import { Button, StandardTooltip } from "@src/components/ui"

export function TelegramButton() {
	const { currentTaskId, currentTaskItem } = useExtensionState()
	const taskId = currentTaskId ?? currentTaskItem?.id
	const state = useTelegramState(taskId)
	const { t } = useAppTranslation()
	const pending = useRef<string>()
	useEffect(() => {
		pending.current = undefined
	}, [state, taskId])
	// Never infer an active connection from the root alone: another descendant may own it.
	const taskActive = state?.status === "active" && state.taskId === taskId
	const projectActive = state?.projectStatus === "active"
	// kilocode_change: the project control topic works without a task; inside a task both must be connected.
	const active = projectActive && (!taskId || taskActive)
	const connecting = state?.status === "connecting" || state?.projectStatus === "connecting"
	const disconnect = active || connecting
	const label = t(disconnect ? "settings:telegram.active" : "settings:telegram.activate")
	const tooltip = disconnect
		? label
		: (state?.error ?? (!state?.configured ? t("settings:telegram.configure") : label))
	return (
		<StandardTooltip content={tooltip}>
			<span className="inline-flex">
				<Button
					variant="ghost"
					size="icon"
					aria-label={label}
					aria-pressed={active}
					aria-busy={connecting}
					className={
						active
							? "border border-green-400 bg-green-700 text-white hover:bg-green-800 hover:text-white"
							: "border border-transparent"
					}
					disabled={!disconnect && !state?.configured}
					onClick={(event) => {
						const type = disconnect ? "deactivateTelegram" : "activateTelegram"
						// A physical double click must not undo the first click after a fast backend ack.
						if (event.detail > 1 || pending.current === type) return
						pending.current = type
						vscode.postMessage({
							type,
							telegramTaskId: disconnect ? (state?.rootTaskId ?? state?.taskId) : taskId,
						})
					}}>
					{connecting ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
				</Button>
			</span>
		</StandardTooltip>
	)
}
