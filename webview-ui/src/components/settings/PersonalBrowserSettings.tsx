// kilocode_change - new file
import { useEffect, useMemo, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui"
import { SetCachedStateField } from "./types"
import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { SearchableSetting } from "./SearchableSetting"

export function PersonalBrowserSettings({
	browserMode,
	browserOSAllowTaskActions,
	setCachedStateField,
}: {
	browserMode?: "isolated" | "chrome-extension" | "browseros"
	browserOSAllowTaskActions?: boolean
	setCachedStateField: SetCachedStateField<"browserMode" | "browserOSAllowTaskActions" | "browserToolEnabled">
}) {
	const { t } = useAppTranslation()
	// kilocode_change start
	const { mcpServers = [] } = useExtensionState()
	const [launching, setLaunching] = useState(false)
	const [launchError, setLaunchError] = useState("")
	const [neoServerKey, setNeoServerKey] = useState("")
	const neoServers = mcpServers.filter((server) => {
		if (server.name === "browseros-neo") return true
		try {
			return JSON.parse(server.config).browserOS === true
		} catch {
			// Invalid configurations are not eligible for browser permission.
			return false
		}
	})
	const serverKey = (server: (typeof mcpServers)[number]) => JSON.stringify([server.name, server.source])
	const selectedNeoServer = neoServers.find((server) => serverKey(server) === neoServerKey) ?? neoServers[0]
	const [connectorError, setConnectorError] = useState("")
	const [chromeStatus, setChromeStatus] = useState("disconnected")
	const [neoStatus, setNeoStatus] = useState("idle")
	const [neoError, setNeoError] = useState("")
	const [neoConnecting, setNeoConnecting] = useState(false)
	const [neoStage, setNeoStage] = useState("")
	// The checkbox is a preference; host-scoped permission is never restored from settings.
	const allowTaskActions = browserOSAllowTaskActions === true
	const neoEndpoint = useMemo(() => {
		if (!selectedNeoServer || selectedNeoServer.disabled || selectedNeoServer.status !== "connected") return ""
		try {
			const url = JSON.parse(selectedNeoServer.config).url
			return typeof url === "string" ? url : ""
		} catch {
			// Invalid configuration cannot provide a trustworthy connection indicator.
			return ""
		}
	}, [selectedNeoServer])
	// kilocode_change end

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			// kilocode_change start
			if (message.type === "personalBrowserLaunchResult") {
				setLaunching(false)
				setLaunchError(message.success ? "" : message.text)
			}
			if (message.type === "browserOSAccessResult") {
				setNeoConnecting(message.values?.busy === true)
				setNeoStage(message.values?.stage ?? "")
				if (message.success) setNeoStatus(message.text)
				if (message.success && message.values?.serverName) {
					setNeoServerKey(JSON.stringify([message.values.serverName, message.values.source]))
				}
				setNeoError(message.success ? "" : message.text)
			}
			if (message.type === "chromeConnectorResult") {
				setConnectorError(message.success ? "" : message.text)
				if (
					message.success &&
					["disconnected", "connected", "awaitingPermission", "active", "paused"].includes(message.text)
				)
					setChromeStatus(message.text)
			}
			// kilocode_change end
		}
		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])
	// kilocode_change start: opening settings observes permission; it never grants it.
	useEffect(() => {
		if (browserMode === "browseros") vscode.postMessage({ type: "browserOSAccess", text: "status" })
		if (browserMode === "chrome-extension") vscode.postMessage({ type: "chromeControl", text: "status" })
	}, [browserMode])
	// kilocode_change end

	return (
		<SearchableSetting settingId="personal-browser" section="ivol" label={t("settings:browser.personal.mode")}>
			<SectionHeader>{t("settings:ivol.browser")}</SectionHeader>
			<Section>
				{/* kilocode_change start: both browser directions share one explicit selector. */}
				<div className="mb-4 space-y-2">
					<label className="block font-medium">{t("settings:browser.personal.mode")}</label>
					<Select
						value={browserMode ?? "isolated"}
						onValueChange={(value: "isolated" | "chrome-extension" | "browseros") => {
							vscode.postMessage({ type: "stopChromeConnector" })
							vscode.postMessage({ type: "browserOSAccess", text: "revoke" })
							setCachedStateField("browserMode", value)
							if (value === "chrome-extension") setCachedStateField("browserToolEnabled", true)
						}}>
						<SelectTrigger aria-label={t("settings:browser.personal.mode")}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="isolated">{t("settings:browser.personal.isolated")}</SelectItem>
							<SelectItem value="chrome-extension">{t("settings:browser.personal.chrome")}</SelectItem>
							<SelectItem value="browseros">{t("settings:browser.personal.neo")}</SelectItem>
						</SelectContent>
					</Select>
					{browserMode === "chrome-extension" && (
						<div className="space-y-2">
							<Button
								disabled={launching}
								onClick={() => {
									setLaunching(true)
									setLaunchError("")
									vscode.postMessage({ type: "launchPersonalBrowser", text: browserMode })
								}}>
								{t("settings:browser.personal.launch")}
							</Button>
							<p className="text-sm text-vscode-descriptionForeground">
								{t("settings:browser.personal.launchHelp")}
							</p>
							{launchError && <p role="alert">{launchError}</p>}
						</div>
					)}
					{browserMode === "chrome-extension" && (
						<div className="space-y-2">
							<p className="text-vscode-descriptionForeground text-sm">
								{t("settings:browser.personal.chromeHelp")}
							</p>
							<Button
								variant="secondary"
								onClick={() => vscode.postMessage({ type: "stopChromeConnector" })}>
								{t("settings:browser.personal.disconnect")}
							</Button>
							<div className="flex flex-wrap gap-2">
								{(["pause", "resume", "refresh"] as const).map((action) => (
									<Button
										key={action}
										variant="secondary"
										onClick={() =>
											vscode.postMessage({
												type: "chromeControl",
												text: action === "refresh" ? "status" : action,
											})
										}>
										{t(`settings:browser.personal.${action}`)}
									</Button>
								))}
							</div>
							<p role="status">{t("settings:browser.personal.status", { status: chromeStatus })}</p>
							{connectorError && <p role="alert">{connectorError}</p>}
							<p className="text-sm">{t("settings:browser.personal.tabsHelp")}</p>
						</div>
					)}
					{browserMode === "browseros" && (
						<div className="space-y-2">
							<p className="text-sm text-vscode-descriptionForeground">
								{t("settings:browser.personal.neoHelp")}
							</p>
							{/* kilocode_change start: IVOL connects the built-in server itself. */}
							<label className="flex items-start gap-2 text-sm">
								<input
									type="checkbox"
									checked={allowTaskActions}
									disabled={neoConnecting}
									onChange={(event) => {
										setCachedStateField("browserOSAllowTaskActions", event.target.checked)
										vscode.postMessage({ type: "browserOSAccess", text: "revoke" })
									}}
								/>
								{t("settings:browser.personal.allowTaskActions")}
							</label>
							<p className="text-sm text-vscode-descriptionForeground">
								{t("settings:browser.personal.allowTaskActionsHelp")}
							</p>
							<Button
								disabled={neoConnecting}
								onClick={() => {
									setNeoConnecting(true)
									setNeoError("")
									vscode.postMessage({
										type: "browserOSAccess",
										text: "connectAndGrant",
										values: { allowTaskActions },
										serverName: selectedNeoServer?.name,
										source: selectedNeoServer?.source,
									})
								}}>
								{t("settings:browser.personal.connectAndGrant")}
							</Button>
							{neoStage && <p role="status">{t(`settings:browser.personal.stages.${neoStage}`)}</p>}
							<details className="space-y-2">
								<summary>{t("settings:browser.personal.advanced")}</summary>
								<p className="text-sm text-vscode-descriptionForeground">
									{neoEndpoint
										? t("settings:browser.personal.endpoint", { endpoint: neoEndpoint })
										: t("settings:browser.personal.autoConnectHelp")}
								</p>
								<Button
									variant="secondary"
									onClick={() => vscode.postMessage({ type: "openMcpSettings" })}>
									{t("settings:browser.personal.mcpSettings")}
								</Button>
								{/* kilocode_change end */}
								<label className="block text-sm">{t("settings:browser.personal.server")}</label>
								<Select
									value={selectedNeoServer ? serverKey(selectedNeoServer) : ""}
									onValueChange={(value) => {
										vscode.postMessage({ type: "browserOSAccess", text: "revoke" })
										setNeoServerKey(value)
									}}>
									<SelectTrigger aria-label={t("settings:browser.personal.server")}>
										<SelectValue placeholder={t("settings:browser.personal.noServer")} />
									</SelectTrigger>
									<SelectContent>
										{neoServers.map((server) => (
											<SelectItem key={serverKey(server)} value={serverKey(server)}>
												{server.name} ({server.source ?? "global"})
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</details>
							<div className="flex flex-wrap gap-2">
								{(["pause", "resume", "revoke", "refresh"] as const).map((action) => (
									<Button
										key={action}
										variant="secondary"
										disabled={neoConnecting && action !== "revoke"}
										onClick={() =>
											vscode.postMessage({
												type: "browserOSAccess",
												text: action === "refresh" ? "status" : action,
												serverName: selectedNeoServer?.name,
												source: selectedNeoServer?.source,
											})
										}>
										{t(`settings:browser.personal.${action}`)}
									</Button>
								))}
							</div>
							<p role="status">{t("settings:browser.personal.status", { status: neoStatus })}</p>
							{neoError && <p role="alert">{neoError}</p>}
						</div>
					)}
				</div>
				{/* kilocode_change end */}
			</Section>
		</SearchableSetting>
	)
}
