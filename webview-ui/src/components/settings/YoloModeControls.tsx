// kilocode_change - new file
import { useEffect, useId, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useYoloModeState } from "@/hooks/useYoloModeState"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { Button, Input } from "@/components/ui"

/** Live permission controls: never staged in the Settings Save draft. */
export function YoloModeControls() {
	const { t } = useAppTranslation()
	const id = useId()
	const { yoloMode, yoloModeExpiresAt, yoloModeTimerMinutes } = useExtensionState()
	const { active, timed, remaining, expired } = useYoloModeState(true)
	const [minutes, setMinutes] = useState(String(yoloModeTimerMinutes ?? 60))
	const [pending, setPending] = useState(false)
	const [timedOut, setTimedOut] = useState(false)
	const duration = Number(minutes)
	const valid = /^\d+$/.test(minutes) && Number.isInteger(duration) && duration >= 1 && duration <= 1440

	useEffect(() => setMinutes(String(yoloModeTimerMinutes ?? 60)), [yoloModeTimerMinutes])
	useEffect(() => {
		setPending(false)
		setTimedOut(false)
	}, [yoloMode, yoloModeExpiresAt])
	useEffect(() => {
		if (!pending) return
		const timer = window.setTimeout(() => {
			setPending(false)
			setTimedOut(true)
		}, 10000)
		return () => window.clearTimeout(timer)
	}, [pending])

	const request = (message: Parameters<typeof vscode.postMessage>[0]) => {
		setPending(true)
		setTimedOut(false)
		vscode.postMessage(message)
	}

	return (
		<div
			className="space-y-3 rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3"
			data-testid="yolo-mode-controls">
			<div className="font-bold text-yellow-500">{t("settings:yoloTimer.title")}</div>
			<div role="status" className="text-sm font-medium" data-testid="yolo-mode-status">
				{active
					? timed
						? t("settings:yoloTimer.active", { remaining })
						: t("settings:yoloTimer.activeUnlimited")
					: t(expired ? "settings:yoloTimer.expired" : "settings:yoloTimer.inactive")}
			</div>
			<div className="flex flex-wrap items-end gap-2">
				<div className="min-w-[140px] flex-1">
					<label htmlFor={id} className="mb-1 block text-sm">
						{t("settings:yoloTimer.minutes")}
					</label>
					<Input
						id={id}
						type="number"
						min={1}
						max={1440}
						step={1}
						value={minutes}
						onChange={(event) => setMinutes(event.target.value)}
						aria-invalid={!valid}
					/>
				</div>
				<Button
					disabled={!valid || pending}
					onClick={() => request({ type: "startYoloModeTimer", value: duration })}>
					{t(active && timed ? "settings:yoloTimer.restart" : "settings:yoloTimer.start")}
				</Button>
			</div>
			{!valid && (
				<div role="alert" className="text-sm">
					{t("settings:yoloTimer.invalidMinutes")}
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				{(active || pending || timedOut) && (
					<Button variant="secondary" onClick={() => request({ type: "yoloMode", bool: false })}>
						{t("settings:yoloTimer.stop")}
					</Button>
				)}
				{(!active || timed) && (
					<Button
						variant="secondary"
						disabled={pending}
						onClick={() => request({ type: "yoloMode", bool: true })}>
						{t("settings:yoloTimer.unlimited")}
					</Button>
				)}
			</div>
			{pending && <div className="text-sm">{t("settings:yoloTimer.pending")}</div>}
			{timedOut && (
				<div role="alert" className="text-sm">
					{t("settings:yoloTimer.timeout")}
				</div>
			)}
			<p className="m-0 text-sm text-vscode-descriptionForeground">{t("settings:yoloTimer.warning")}</p>
			<p className="m-0 text-xs text-vscode-descriptionForeground">{t("settings:yoloTimer.scope")}</p>
		</div>
	)
}
