// kilocode_change - new file
import { useEffect, useState } from "react"
import { isYoloModeActive } from "@roo-code/types"
import { useExtensionState } from "@/context/ExtensionStateContext"

/** UI clock only. Permission checks and lease expiry are enforced by the extension. */
export function useYoloModeState(countdown = false) {
	const { yoloMode, yoloModeExpiresAt } = useExtensionState()
	const [, updateClock] = useState(0)
	const now = Date.now()
	const active = isYoloModeActive({ yoloMode, yoloModeExpiresAt }, now)
	const timed = typeof yoloModeExpiresAt === "number" && Number.isFinite(yoloModeExpiresAt)

	useEffect(() => {
		if (!yoloMode || !timed || !isYoloModeActive({ yoloMode, yoloModeExpiresAt }, Date.now())) return
		const update = () => updateClock((value) => value + 1)
		const timer = window.setTimeout(update, Math.max(1, yoloModeExpiresAt! - Date.now()))
		const interval = countdown ? window.setInterval(update, 1000) : undefined
		document.addEventListener("visibilitychange", update)
		window.addEventListener("focus", update)
		return () => {
			window.clearTimeout(timer)
			if (interval !== undefined) window.clearInterval(interval)
			document.removeEventListener("visibilitychange", update)
			window.removeEventListener("focus", update)
		}
	}, [yoloMode, yoloModeExpiresAt, timed, countdown, active])

	const seconds = active && timed ? Math.max(0, Math.ceil((yoloModeExpiresAt! - now) / 1000)) : 0
	const hours = Math.floor(seconds / 3600)
	const remaining = [hours, Math.floor((seconds % 3600) / 60), seconds % 60]
		.map((value) => String(value).padStart(2, "0"))
		.join(":")
	return { active, timed, remaining, expired: timed && yoloModeExpiresAt! <= now }
}
