import { VSCodeCheckbox, VSCodeTextField, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { HTMLAttributes, useEffect, useMemo, useState } from "react"
import { Trans } from "react-i18next"

import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Slider,
	Button,
} from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { buildDocLink } from "@src/utils/docLinks"
import { useExtensionState } from "@/context/ExtensionStateContext" // kilocode_change

import { SearchableSetting } from "./SearchableSetting"
import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { SetCachedStateField } from "./types"

type BrowserSettingsProps = HTMLAttributes<HTMLDivElement> & {
	browserToolEnabled?: boolean
	browserMode?: "isolated" | "chrome-extension" | "browseros" // kilocode_change
	browserOSAllowTaskActions?: boolean // kilocode_change
	browserViewportSize?: string
	screenshotQuality?: number
	remoteBrowserHost?: string
	remoteBrowserEnabled?: boolean
	setCachedStateField: SetCachedStateField<
		| "browserToolEnabled"
		| "browserMode" // kilocode_change
		| "browserOSAllowTaskActions" // kilocode_change
		| "browserViewportSize"
		| "screenshotQuality"
		| "remoteBrowserHost"
		| "remoteBrowserEnabled"
	>
}

export const BrowserSettings = ({
	browserToolEnabled,
	browserMode, // kilocode_change
	browserOSAllowTaskActions, // kilocode_change
	browserViewportSize,
	screenshotQuality,
	remoteBrowserHost,
	remoteBrowserEnabled,
	setCachedStateField,
	...props
}: BrowserSettingsProps) => {
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
	const [testingConnection, setTestingConnection] = useState(false)
	const [testResult, setTestResult] = useState<{ success: boolean; text: string } | null>(null)
	const [discovering, setDiscovering] = useState(false)

	// We don't need a local state for useRemoteBrowser since we're using the
	// `enableRemoteBrowser` prop directly. This ensures the checkbox always
	// reflects the current global state.

	// Set up message listener for browser connection results.
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
			if (message.type === "browserConnectionResult") {
				setTestResult({ success: message.success, text: message.text })
				setTestingConnection(false)
				setDiscovering(false)
			}
		}

		window.addEventListener("message", handleMessage)

		return () => {
			window.removeEventListener("message", handleMessage)
		}
	}, [])

	// kilocode_change start: opening settings observes permission; it never grants it.
	useEffect(() => {
		if (browserMode === "browseros") vscode.postMessage({ type: "browserOSAccess", text: "status" })
		if (browserMode === "chrome-extension") vscode.postMessage({ type: "chromeControl", text: "status" })
	}, [browserMode])
	// kilocode_change end

	const testConnection = async () => {
		setTestingConnection(true)
		setTestResult(null)

		try {
			// Send a message to the extension to test the connection.
			vscode.postMessage({ type: "testBrowserConnection", text: remoteBrowserHost })
		} catch (error) {
			setTestResult({
				success: false,
				text: `Error: ${error instanceof Error ? error.message : String(error)}`,
			})
			setTestingConnection(false)
		}
	}

	const options = useMemo(
		() => [
			{
				value: "1280x800",
				label: t("settings:browser.viewport.options.largeDesktop"),
			},
			{
				value: "900x600",
				label: t("settings:browser.viewport.options.smallDesktop"),
			},
			{ value: "768x1024", label: t("settings:browser.viewport.options.tablet") },
			{ value: "360x640", label: t("settings:browser.viewport.options.mobile") },
		],
		[t],
	)

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.browser")}</SectionHeader>

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
						<SelectTrigger>
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
				<SearchableSetting
					settingId="browser-enable"
					section="browser"
					label={t("settings:browser.enable.label")}>
					<VSCodeCheckbox
						checked={browserToolEnabled}
						onChange={(e: any) => setCachedStateField("browserToolEnabled", e.target.checked)}>
						<span className="font-medium">{t("settings:browser.enable.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						<Trans i18nKey="settings:browser.enable.description">
							<VSCodeLink
								href={buildDocLink("features/browser-use", "settings_browser_tool")}
								style={{ display: "inline" }}>
								{" "}
							</VSCodeLink>
						</Trans>
					</div>
				</SearchableSetting>

				{browserToolEnabled &&
					(!browserMode || browserMode === "isolated") && ( // kilocode_change
						<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
							<SearchableSetting
								settingId="browser-viewport"
								section="browser"
								label={t("settings:browser.viewport.label")}>
								<label className="block font-medium mb-1">{t("settings:browser.viewport.label")}</label>
								<Select
									value={browserViewportSize}
									onValueChange={(value) => setCachedStateField("browserViewportSize", value)}>
									<SelectTrigger className="w-full">
										<SelectValue placeholder={t("settings:common.select")} />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											{options.map(({ value, label }) => (
												<SelectItem key={value} value={value}>
													{label}
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
								<div className="text-vscode-descriptionForeground text-sm mt-1">
									{t("settings:browser.viewport.description")}
								</div>
							</SearchableSetting>

							<SearchableSetting
								settingId="browser-screenshot-quality"
								section="browser"
								label={t("settings:browser.screenshotQuality.label")}>
								<label className="block font-medium mb-1">
									{t("settings:browser.screenshotQuality.label")}
								</label>
								<div className="flex items-center gap-2">
									<Slider
										min={1}
										max={100}
										step={1}
										value={[screenshotQuality ?? 75]}
										onValueChange={([value]) => setCachedStateField("screenshotQuality", value)}
									/>
									<span className="w-10">{screenshotQuality ?? 75}%</span>
								</div>
								<div className="text-vscode-descriptionForeground text-sm mt-1">
									{t("settings:browser.screenshotQuality.description")}
								</div>
							</SearchableSetting>

							<SearchableSetting
								settingId="browser-remote"
								section="browser"
								label={t("settings:browser.remote.label")}>
								<VSCodeCheckbox
									checked={remoteBrowserEnabled}
									onChange={(e: any) => {
										// Update the global state - remoteBrowserEnabled now means "enable remote browser connection".
										setCachedStateField("remoteBrowserEnabled", e.target.checked)

										if (!e.target.checked) {
											// If disabling remote browser, clear the custom URL.
											setCachedStateField("remoteBrowserHost", undefined)
										}
									}}>
									<label className="block font-medium mb-1">
										{t("settings:browser.remote.label")}
									</label>
								</VSCodeCheckbox>
								<div className="text-vscode-descriptionForeground text-sm mt-1">
									{t("settings:browser.remote.description")}
								</div>
							</SearchableSetting>

							{remoteBrowserEnabled && (
								<>
									<div className="flex items-center gap-2">
										<VSCodeTextField
											value={remoteBrowserHost ?? ""}
											onChange={(e: any) =>
												setCachedStateField("remoteBrowserHost", e.target.value || undefined)
											}
											placeholder={t("settings:browser.remote.urlPlaceholder")}
											style={{ flexGrow: 1 }}
										/>
										<Button disabled={testingConnection} onClick={testConnection}>
											{testingConnection || discovering
												? t("settings:browser.remote.testingButton")
												: t("settings:browser.remote.testButton")}
										</Button>
									</div>
									{testResult && (
										<div
											className={`p-2 rounded-xs text-sm ${
												testResult.success
													? "bg-green-800/20 text-green-400"
													: "bg-red-800/20 text-red-400"
											}`}>
											{testResult.text}
										</div>
									)}
									<div className="text-vscode-descriptionForeground text-sm mt-1">
										{t("settings:browser.remote.instructions")}
									</div>
								</>
							)}
						</div>
					)}
			</Section>
		</div>
	)
}
