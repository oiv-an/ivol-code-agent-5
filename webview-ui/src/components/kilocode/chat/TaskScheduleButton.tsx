import { useEffect, useState } from "react"
import { AlarmClock } from "lucide-react"

import { vscode } from "@/utils/vscode"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { cn } from "@/lib/utils"

type Mode = "interval" | "delay" | "at"
type Unit = "minutes" | "hours"

const pad = (value: number) => String(value).padStart(2, "0")
// datetime-local expects local time without a zone suffix.
const toLocalInput = (ts: number) => {
	const d = new Date(ts)
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Compact time left: "1:05:09", "4:12", "0:00" when due. */
export const formatCountdown = (ms: number) => {
	const total = Math.max(0, Math.ceil(ms / 1000))
	const days = Math.floor(total / 86400)
	const h = Math.floor((total % 86400) / 3600)
	const m = Math.floor((total % 3600) / 60)
	const s = total % 60
	if (days > 0) return `${days}d ${h}:${pad(m)}`
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Clock button: one reminder per task that re-sends text to this task while it is open. */
export const TaskScheduleButton = () => {
	const { t } = useAppTranslation()
	const { currentTaskItem } = useExtensionState()
	const schedule = currentTaskItem?.schedule
	const taskId = currentTaskItem?.id

	const [open, setOpen] = useState(false)
	const [mode, setMode] = useState<Mode>("interval")
	const [amount, setAmount] = useState("1")
	const [unit, setUnit] = useState<Unit>("hours")
	const [at, setAt] = useState("")
	const [text, setText] = useState("")
	const [allowBrowser, setAllowBrowser] = useState(false)

	// Load the saved schedule into the form whenever the form opens.
	useEffect(() => {
		if (!open) return
		if (schedule) {
			setMode(schedule.mode)
			setText(schedule.text)
			setAllowBrowser(schedule.allowBrowser === true)
			const minutes = schedule.mode !== "at" ? schedule.intervalMinutes : undefined
			if (minutes !== undefined) {
				const inHours = minutes % 60 === 0
				setUnit(inHours ? "hours" : "minutes")
				setAmount(String(inHours ? minutes / 60 : minutes))
			}
			setAt(toLocalInput(schedule.nextRunAt))
		} else {
			setAt(toLocalInput(Date.now() + 60 * 60_000))
		}
	}, [open, schedule])

	// Live countdown to the next run, shown next to the clock while a schedule is active.
	const [now, setNow] = useState(Date.now())
	useEffect(() => {
		if (!schedule) return
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [schedule])
	const countdown = schedule ? formatCountdown(schedule.nextRunAt - now) : ""

	const minutes = Number(amount) * (unit === "hours" ? 60 : 1)
	const atTs = at ? new Date(at).getTime() : NaN
	const valid =
		text.trim().length > 0 &&
		(mode === "at" ? Number.isFinite(atTs) && atTs > Date.now() : Number.isFinite(minutes) && minutes >= 1)

	const save = () => {
		if (!taskId || !valid) return
		vscode.postMessage({
			type: "setTaskSchedule",
			taskId,
			taskSchedule:
				mode === "at"
					? { mode, text: text.trim(), at: atTs, allowBrowser }
					: { mode, text: text.trim(), minutes, allowBrowser },
		})
		setOpen(false)
	}

	const stop = () => {
		if (!taskId) return
		vscode.postMessage({ type: "setTaskSchedule", taskId, taskSchedule: null })
		setOpen(false)
	}

	const tooltip = schedule
		? t("chat:taskSchedule.next", { time: new Date(schedule.nextRunAt).toLocaleString() })
		: t("chat:taskSchedule.title")

	const fieldClass =
		"w-full rounded-xs border border-vscode-input-border bg-vscode-input-background px-2 py-1 text-vscode-input-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder"

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<StandardTooltip content={tooltip}>
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label={tooltip}
						disabled={!taskId}
						className={cn(
							"relative inline-flex items-center justify-center",
							"bg-transparent border-none p-1.5 rounded-md min-w-[28px] min-h-[28px]",
							"text-vscode-descriptionForeground hover:text-vscode-foreground",
							"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
							"disabled:opacity-30 cursor-pointer",
							schedule ? "opacity-100 text-vscode-foreground" : "opacity-60 hover:opacity-100",
						)}>
						<AlarmClock className={cn("w-4 h-4", schedule && "text-vscode-charts-green")} />
						{schedule && (
							<span
								aria-hidden="true"
								className="ml-1 text-xs tabular-nums whitespace-nowrap text-vscode-charts-green">
								{countdown}
							</span>
						)}
					</button>
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent align="end" className="w-80 p-3 flex flex-col gap-2 text-sm">
				<div className="flex items-center justify-between gap-2">
					<span className="font-semibold">{t("chat:taskSchedule.title")}</span>
					{schedule && (
						<span className="text-xs tabular-nums whitespace-nowrap text-vscode-charts-green">
							{t("chat:taskSchedule.left", { time: countdown })}
						</span>
					)}
				</div>
				<div className="flex gap-1" role="radiogroup" aria-label={t("chat:taskSchedule.title")}>
					{(["interval", "delay", "at"] as const).map((value) => (
						<button
							key={value}
							type="button"
							role="radio"
							aria-checked={mode === value}
							onClick={() => setMode(value)}
							className={cn(
								"flex-1 rounded-xs border px-2 py-1 cursor-pointer",
								mode === value
									? "border-vscode-focusBorder bg-vscode-button-background text-vscode-button-foreground"
									: "border-vscode-input-border bg-transparent text-vscode-foreground",
							)}>
							{t(`chat:taskSchedule.mode.${value}`)}
						</button>
					))}
				</div>
				{mode === "at" ? (
					<input
						type="datetime-local"
						aria-label={t("chat:taskSchedule.mode.at")}
						value={at}
						onChange={(e) => setAt(e.target.value)}
						className={fieldClass}
					/>
				) : (
					<div className="flex gap-1 items-center">
						<span className="shrink-0">
							{t(mode === "interval" ? "chat:taskSchedule.every" : "chat:taskSchedule.after")}
						</span>
						<input
							type="number"
							min={1}
							aria-label={t("chat:taskSchedule.amount")}
							value={amount}
							onChange={(e) => setAmount(e.target.value)}
							className={cn(fieldClass, "w-20")}
						/>
						<select
							aria-label={t("chat:taskSchedule.unit")}
							value={unit}
							onChange={(e) => setUnit(e.target.value as Unit)}
							className={fieldClass}>
							<option value="minutes">{t("chat:taskSchedule.minutes")}</option>
							<option value="hours">{t("chat:taskSchedule.hours")}</option>
						</select>
					</div>
				)}
				<textarea
					aria-label={t("chat:taskSchedule.text")}
					placeholder={t("chat:taskSchedule.placeholder")}
					value={text}
					onChange={(e) => setText(e.target.value)}
					rows={3}
					className={cn(fieldClass, "resize-y")}
				/>
				<label className="flex items-center gap-2 cursor-pointer">
					<input type="checkbox" checked={allowBrowser} onChange={(e) => setAllowBrowser(e.target.checked)} />
					<span>{t("chat:taskSchedule.allowBrowser")}</span>
				</label>
				<div className="text-xs text-vscode-descriptionForeground">{t("chat:taskSchedule.hint")}</div>
				<div className="flex justify-end gap-2">
					<button
						type="button"
						onClick={() => setOpen(false)}
						className="mr-auto rounded-xs border border-vscode-input-border bg-transparent px-3 py-1 text-vscode-foreground cursor-pointer">
						{t("chat:taskSchedule.close")}
					</button>
					{schedule && (
						<button
							type="button"
							onClick={stop}
							className="rounded-xs border border-vscode-input-border bg-transparent px-3 py-1 text-vscode-foreground cursor-pointer">
							{t("chat:taskSchedule.stop")}
						</button>
					)}
					<button
						type="button"
						onClick={save}
						disabled={!valid}
						className="rounded-xs border-none bg-vscode-button-background px-3 py-1 text-vscode-button-foreground cursor-pointer disabled:opacity-50">
						{t("chat:taskSchedule.save")}
					</button>
				</div>
			</PopoverContent>
		</Popover>
	)
}
