import { useEffect, useState } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useAdvisor } from "./AdvisorContext"
import { Button } from "@/components/ui"

export default function AdvisorView({ onDone, embedded = false }: { onDone: () => void; embedded?: boolean }) {
	const { t } = useAppTranslation()
	const { state, busy, checking, timedOut, request, ensureLoaded, markRead, cancel } = useAdvisor()
	const [search, setSearch] = useState("")
	const [showDisabled, setShowDisabled] = useState(false)
	useEffect(() => {
		ensureLoaded()
		markRead()
	}, [ensureLoaded, markRead])

	const recommendations = (state.ai?.recommendations ?? []).filter((row) => {
		const entry = state.entries.find((item) => item.id === row.id)
		return `${entry?.name ?? ""} ${row.id}`.toLowerCase().includes(search.toLowerCase())
	})
	return (
		<section
			className={`${embedded ? "relative" : "absolute inset-0"} flex flex-col bg-vscode-editor-background p-4 overflow-auto pb-16`}
			aria-label={t("common:advisor.title")}>
			<div className="flex items-center justify-between gap-2 mb-4">
				<h2>{t("common:advisor.title")}</h2>
				<Button variant="ghost" onClick={onDone}>
					{t("common:advisor.back")}
				</Button>
			</div>
			<p>{t("common:advisor.aiNotice")}</p>
			{!state.platformSupported && <p role="status">{t("common:advisor.aiPlatform")}</p>}
			{state.platformSupported && !state.canScan && !busy && <p>{t("common:advisor.workspaceRequired")}</p>}
			<div className="flex flex-wrap gap-2 my-3">
				<Button disabled={busy || !state.canScan} onClick={() => request("startAdvisorCheck")}>
					{t(checking ? "common:advisor.loading" : "common:advisor.scan")}
				</Button>
				{checking && (
					<Button variant="secondary" onClick={cancel}>
						{t("common:answers.cancel")}
					</Button>
				)}
				<Button
					variant="secondary"
					disabled={busy}
					onClick={() => {
						setShowDisabled((value) => !value)
						if (!showDisabled) request("getAdvisorState")
					}}>
					{t("common:advisor.showWorkspaceDisabled")}
				</Button>
			</div>
			{showDisabled && (
				<div className="border border-vscode-panel-border rounded p-3 my-3" aria-busy={busy}>
					<h3>{t("common:advisor.workspaceDisabledTitle")}</h3>
					<Button variant="secondary" disabled={busy} onClick={() => request("getAdvisorState")}>
						{t("common:advisor.refreshDisabled")}
					</Button>
					{state.workspaceDisabled?.status === "available" ? (
						<>
							<p>{t("common:advisor.workspaceDisabledNotice")}</p>
							<p className="text-xs text-vscode-descriptionForeground">
								{state.workspaceDisabled.readAt}
							</p>
							{state.workspaceDisabled.entries.map((entry) => (
								<div key={entry.id} className="border-b border-vscode-panel-border py-2">
									<strong>{entry.name}</strong>
									<div className="text-xs break-words">{entry.id}</div>
									<Button
										disabled={busy}
										onClick={() =>
											request("openAdvisorExtension", { advisorExtensionId: entry.id })
										}>
										{t("common:advisor.openExtension")}
									</Button>
								</div>
							))}
							{!state.workspaceDisabled.entries.length && (
								<p>{t("common:advisor.workspaceDisabledEmpty")}</p>
							)}
						</>
					) : (
						!busy && (
							<>
								<p role="status">{t("common:advisor.workspaceDisabledUnsupported")}</p>
								<p className="text-xs break-words">{state.workspaceDisabled?.reason}</p>
							</>
						)
					)}
				</div>
			)}
			{checking && <p role="status">{t("common:advisor.aiRunning")}</p>}
			{timedOut && <p role="alert">{t("common:advisor.aiTimeout")}</p>}
			{state.error && <p role="alert">{state.error}</p>}
			{state.ai?.error && <p role="alert">{state.ai.error}</p>}
			{state.ai && (
				<div role="status" className="text-xs text-vscode-descriptionForeground my-2">
					<p>
						{t("common:advisor.aiUsage", {
							model: state.ai.model || "—",
							input: state.ai.usage.inputTokens,
							output: state.ai.usage.outputTokens,
							cost: state.ai.usage.totalCost === undefined ? "—" : state.ai.usage.totalCost.toFixed(4),
						})}
					</p>
					<p>{t("common:advisor.aiCoverage", { files: state.ai.files, count: state.ai.inventoryCount })}</p>
					{!state.ai.complete && <p>{t("common:advisor.analysisIncomplete")}</p>}
				</div>
			)}
			<label className="flex flex-col gap-1 my-2">
				<strong>{t("common:advisor.search")}</strong>
				<input
					type="search"
					aria-label={t("common:advisor.search")}
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					className="w-full min-w-0 box-border bg-vscode-input-background text-vscode-input-foreground border border-vscode-panel-border rounded p-2"
				/>
			</label>
			<div aria-busy={checking}>
				{recommendations.map((row) => (
					<div key={row.id} className="border border-vscode-panel-border rounded p-3 my-2">
						<strong>{state.entries.find((entry) => entry.id === row.id)?.name ?? row.id}</strong>
						<div className="text-xs break-words">{row.id}</div>
						<p className="whitespace-pre-wrap">{row.reason}</p>
						<p className="whitespace-pre-wrap">
							<strong>{t("common:advisor.aiLoss")}: </strong>
							{row.loss}
						</p>
						<Button
							disabled={busy || !state.platformSupported}
							onClick={() => request("openAdvisorExtension", { advisorExtensionId: row.id })}>
							{t("common:advisor.openExtension")}
						</Button>
					</div>
				))}
				{state.ai && !state.ai.error && !recommendations.length && <p>{t("common:advisor.aiEmpty")}</p>}
			</div>
		</section>
	)
}
