// kilocode_change - new file
import { useEffect, useState } from "react"
import type { ExtensionMessage, ProjectTaskStorageState } from "@roo-code/types"
import { LoaderCircle } from "lucide-react"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button } from "@src/components/ui"
import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"

export function ProjectTaskStorageSettings() {
	const { t } = useAppTranslation()
	const [state, setState] = useState<ProjectTaskStorageState>()
	const [pending, setPending] = useState(false)
	useEffect(() => {
		const listener = (event: MessageEvent<ExtensionMessage>) => {
			if (event.data.type === "projectTaskStorage" && event.data.projectTaskStorage) {
				setState(event.data.projectTaskStorage)
				if (!event.data.projectTaskStorage.busy || event.data.projectTaskStorage.error) setPending(false)
			}
		}
		window.addEventListener("message", listener)
		vscode.postMessage({ type: "getProjectTaskStorage" })
		return () => window.removeEventListener("message", listener)
	}, [])
	const progress = state?.copyProgress
	const copying = !!progress && !["completed", "failed"].includes(progress.phase)
	const disabled = !state || !state.workspace || state.busy || pending || copying
	const save = (enabled: boolean, hide: boolean) => {
		setPending(true)
		vscode.postMessage({ type: "setProjectTaskStorage", projectTaskStorage: { enabled, hide } })
	}
	return (
		<>
			<SectionHeader>{t("settings:projectTaskStorage.title")}</SectionHeader>
			<Section>
				<div className="flex flex-col gap-3">
					<p className="text-vscode-descriptionForeground m-0">
						{t("settings:projectTaskStorage.description")}
					</p>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={state?.enabled ?? true}
							disabled={disabled}
							onChange={(event) => save(event.target.checked, state?.hide ?? true)}
						/>
						{t("settings:projectTaskStorage.enabled")}
					</label>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={state?.hide ?? true}
							disabled={disabled || !state?.enabled}
							onChange={(event) => save(true, event.target.checked)}
						/>
						{t("settings:projectTaskStorage.hide")}
					</label>
					<p className="text-vscode-descriptionForeground m-0">{t("settings:projectTaskStorage.privacy")}</p>
					{state?.busy && !copying && <p role="status">{t("settings:projectTaskStorage.busy")}</p>}
					{progress && (
						<div className="flex flex-col gap-2" role="status" aria-live="polite">
							<div className="flex items-center gap-2">
								{copying && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
								<span>{t(`settings:projectTaskStorage.phases.${progress.phase}`)}</span>
							</div>
							<progress
								className="w-full"
								aria-label={t("settings:projectTaskStorage.progress", progress)}
								value={progress.copied}
								max={Math.max(1, progress.total)}
							/>
							<span>{t("settings:projectTaskStorage.progress", progress)}</span>
						</div>
					)}
					{!state?.workspace && <p>{t("settings:projectTaskStorage.noWorkspace")}</p>}
					{(state?.tasksToCopy ?? 0) > 0 && (
						<>
							<Button
								variant="secondary"
								disabled={disabled || !state?.enabled}
								onClick={() => {
									setPending(true)
									vscode.postMessage({ type: "copyTasksToProject" })
								}}>
								{t("settings:projectTaskStorage.copy")}
							</Button>
							<p className="text-vscode-descriptionForeground m-0">
								{t("settings:projectTaskStorage.copyHint")}
							</p>
						</>
					)}
					{state?.copied !== undefined && !progress && (
						<p role="status">{t("settings:projectTaskStorage.copied", { count: state.copied })}</p>
					)}
					{state?.error && (
						<p role="alert" className="text-vscode-errorForeground">
							{state.error}
						</p>
					)}
				</div>
			</Section>
		</>
	)
}
