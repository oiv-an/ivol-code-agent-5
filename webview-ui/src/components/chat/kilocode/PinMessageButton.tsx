// kilocode_change - new file
import { useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Pin, PinOff } from "lucide-react"

import type { ClineMessage } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import { cn } from "@src/lib/utils"
import { StandardTooltip } from "@src/components/ui"

interface PinMessageButtonProps {
	message: ClineMessage
	className?: string
}

/**
 * Freezes a message in the model's context.
 *
 * Condensing still runs over the whole conversation - the summary has to be written from the
 * complete picture - but a frozen message is delivered to the model again in every request that
 * follows, until the mark is removed.
 *
 * The number next to the button is the same number the model receives, so the user can say
 * "unfreeze #20" and mean exactly what the model would.
 */
export const PinMessageButton = ({ message, className }: PinMessageButtonProps) => {
	const { t } = useTranslation()
	const isPinned = message.pinned === true
	const seq = typeof message.seq === "number" ? message.seq : undefined

	const handleClick = useCallback(
		(event: React.MouseEvent) => {
			event.stopPropagation()
			vscode.postMessage({ type: "togglePinnedMessage", messageTs: message.ts, pinned: !isPinned })
		},
		[isPinned, message.ts],
	)

	const label = isPinned
		? message.pinnedBy === "model"
			? t("chat:contextPinning.pinnedByModel")
			: t("chat:contextPinning.pinned")
		: t("chat:contextPinning.pin")

	return (
		<div className={cn("flex items-center gap-0.5", className)}>
			{seq !== undefined && (
				<StandardTooltip content={t("chat:contextPinning.messageNumber", { number: seq })}>
					<span
						data-testid="message-number"
						className="text-xs text-vscode-descriptionForeground opacity-60 select-all">
						#{seq}
					</span>
				</StandardTooltip>
			)}
			<StandardTooltip content={message.pinnedNote ? `${label} — ${message.pinnedNote}` : label}>
				<button
					aria-label={label}
					aria-pressed={isPinned}
					data-testid="pin-message-button"
					onClick={handleClick}
					className={cn(
						"flex items-center justify-center bg-transparent border-none p-1 cursor-pointer rounded",
						"hover:bg-vscode-toolbar-hoverBackground",
						isPinned ? "text-vscode-textLink-foreground" : "text-vscode-descriptionForeground opacity-60",
					)}>
					{isPinned ? <Pin size={13} /> : <PinOff size={13} />}
				</button>
			</StandardTooltip>
		</div>
	)
}
