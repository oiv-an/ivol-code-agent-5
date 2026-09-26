import { memo, useCallback, useMemo, useState } from "react"
import { Trans } from "react-i18next"
import { VSCodeCheckbox, VSCodeLink } from "@vscode/webview-ui-toolkit/react"

import { vscode } from "@src/utils/vscode"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { AutoApproveToggle, AutoApproveSetting, autoApproveSettingsConfig } from "../settings/AutoApproveToggle"
import { MaxRequestsInput } from "../settings/MaxRequestsInput" // kilocode_change
import { MaxCostInput } from "../settings/MaxCostInput" // kilocode_change
import { StandardTooltip, Popover, PopoverTrigger, PopoverContent } from "@src/components/ui" // kilocode_change
import { useAutoApprovalState } from "@src/hooks/useAutoApprovalState"
import { useAutoApprovalToggles } from "@src/hooks/useAutoApprovalToggles"
import { useYoloModeState } from "@src/hooks/useYoloModeState" // kilocode_change
import { YoloModeControls } from "../settings/YoloModeControls" // kilocode_change

interface AutoApproveMenuProps {
	style?: React.CSSProperties
	compact?: boolean // kilocode_change: bottom toolbar control
}

const AutoApproveMenu = ({ style, compact = false }: AutoApproveMenuProps) => {
	const [isExpanded, setIsExpanded] = useState(false)

	const {
		autoApprovalEnabled,
		setAutoApprovalEnabled,
		allowedMaxRequests, // kilocode_change
		allowedMaxCost, // kilocode_change
		setAlwaysAllowReadOnly,
		setAlwaysAllowWrite,
		setAlwaysAllowDelete, // kilocode_change
		setAlwaysAllowExecute,
		setAlwaysAllowBrowser,
		setAlwaysAllowMcp,
		setAlwaysAllowModeSwitch,
		setAlwaysAllowSubtasks,
		setAlwaysAllowFollowupQuestions,
		setAllowedMaxRequests, // kilocode_change
		setAllowedMaxCost, // kilocode_change
	} = useExtensionState()

	const { t } = useAppTranslation()

	const toggles = useAutoApprovalToggles()
	const { active: yoloActive } = useYoloModeState() // kilocode_change
	const { hasEnabledOptions, effectiveAutoApprovalEnabled } = useAutoApprovalState(
		toggles,
		autoApprovalEnabled,
		yoloActive,
	) // kilocode_change

	const onAutoApproveToggle = useCallback(
		(key: AutoApproveSetting, value: boolean) => {
			vscode.postMessage({ type: "updateSettings", updatedSettings: { [key]: value } })

			// Update the specific toggle state
			switch (key) {
				case "alwaysAllowReadOnly":
					setAlwaysAllowReadOnly(value)
					break
				case "alwaysAllowWrite":
					setAlwaysAllowWrite(value)
					break
				// kilocode_change start
				case "alwaysAllowDelete":
					setAlwaysAllowDelete(value)
					break
				// kilocode_change end
				case "alwaysAllowExecute":
					setAlwaysAllowExecute(value)
					break
				case "alwaysAllowBrowser":
					setAlwaysAllowBrowser(value)
					break
				case "alwaysAllowMcp":
					setAlwaysAllowMcp(value)
					break
				case "alwaysAllowModeSwitch":
					setAlwaysAllowModeSwitch(value)
					break
				case "alwaysAllowSubtasks":
					setAlwaysAllowSubtasks(value)
					break
				case "alwaysAllowFollowupQuestions":
					setAlwaysAllowFollowupQuestions(value)
					break
			}

			// Check if we need to update the master auto-approval state
			// Create a new toggles state with the updated value
			const updatedToggles = {
				...toggles,
				[key]: value,
			}

			const willHaveEnabledOptions = Object.values(updatedToggles).some((v) => !!v)

			// If enabling the first option, enable master auto-approval
			if (value && !hasEnabledOptions && willHaveEnabledOptions) {
				setAutoApprovalEnabled(true)
				vscode.postMessage({ type: "updateSettings", updatedSettings: { autoApprovalEnabled: true } })
			}
			// If disabling the last option, disable master auto-approval
			else if (!value && hasEnabledOptions && !willHaveEnabledOptions) {
				setAutoApprovalEnabled(false)
				vscode.postMessage({ type: "updateSettings", updatedSettings: { autoApprovalEnabled: false } })
			}
		},
		[
			toggles,
			hasEnabledOptions,
			setAlwaysAllowReadOnly,
			setAlwaysAllowWrite,
			setAlwaysAllowDelete, // kilocode_change
			setAlwaysAllowExecute,
			setAlwaysAllowBrowser,
			setAlwaysAllowMcp,
			setAlwaysAllowModeSwitch,
			setAlwaysAllowSubtasks,
			setAlwaysAllowFollowupQuestions,
			setAutoApprovalEnabled,
		],
	)

	const toggleExpanded = useCallback(() => {
		setIsExpanded((prev) => !prev)
	}, [])

	const enabledActionsList = Object.entries(toggles)
		.filter(([_key, value]) => !!value)
		.map(([key]) => t(autoApproveSettingsConfig[key as AutoApproveSetting].labelKey))
		.join(", ")

	// Update displayed text logic
	const displayText = useMemo(() => {
		if (yoloActive) return t("settings:yoloTimer.statusShort") // kilocode_change
		if (!effectiveAutoApprovalEnabled || !hasEnabledOptions) {
			return t("chat:autoApprove.none")
		}
		return enabledActionsList || t("chat:autoApprove.none")
	}, [effectiveAutoApprovalEnabled, hasEnabledOptions, enabledActionsList, t, yoloActive]) // kilocode_change

	const handleOpenSettings = useCallback(
		() =>
			window.postMessage({ type: "action", action: "settingsButtonClicked", values: { section: "autoApprove" } }),
		[],
	)

	// kilocode_change start: reuse the existing permissions and master switch in the bottom toolbar.
	const settingsContent = (
		<div className="flex flex-col gap-2 py-4">
			{/* kilocode_change start */}
			<YoloModeControls />
			{/* kilocode_change end */}
			<div
				style={{
					color: "var(--vscode-descriptionForeground)",
					fontSize: "12px",
				}}>
				<Trans
					i18nKey="chat:autoApprove.description"
					components={{
						settingsLink: <VSCodeLink href="#" onClick={handleOpenSettings} />,
					}}
				/>
			</div>

			<AutoApproveToggle {...toggles} onToggle={onAutoApproveToggle} />

			{/* kilocode_change start */}
			<div className="flex gap-2 w-full justify-stretch mb-2">
				<MaxRequestsInput
					allowedMaxRequests={allowedMaxRequests ?? undefined}
					onValueChange={(value) => setAllowedMaxRequests(value)}
				/>
				<MaxCostInput
					allowedMaxCost={allowedMaxCost ?? undefined}
					onValueChange={(value) => setAllowedMaxCost(value)}
				/>
			</div>
			{/* kilocode_change end */}
		</div>
	)

	const masterCheckbox = (
		<div onClick={(e) => e.stopPropagation()}>
			{/* kilocode_change: YOLO also enables the master switch when ordinary categories are off. */}
			<StandardTooltip
				content={
					!hasEnabledOptions && !yoloActive
						? t("chat:autoApprove.selectOptionsFirst")
						: compact
							? `${t("chat:autoApprove.title")}: ${displayText}`
							: undefined
				}>
				<VSCodeCheckbox
					checked={effectiveAutoApprovalEnabled}
					disabled={!hasEnabledOptions && !yoloActive} // kilocode_change
					aria-label={
						hasEnabledOptions || yoloActive // kilocode_change
							? t("chat:autoApprove.toggleAriaLabel")
							: t("chat:autoApprove.disabledAriaLabel")
					}
					onChange={() => {
						// kilocode_change start
						if (yoloActive) {
							vscode.postMessage({ type: "yoloMode", bool: false })
							setAutoApprovalEnabled(false)
							vscode.postMessage({ type: "autoApprovalEnabled", bool: false })
							return
						}
						// kilocode_change end
						if (hasEnabledOptions) {
							const newValue = !(autoApprovalEnabled ?? false)
							setAutoApprovalEnabled(newValue)
							vscode.postMessage({
								type: "updateSettings",
								updatedSettings: { autoApprovalEnabled: newValue },
							})
						}
						// If no options enabled, do nothing
					}}
				/>
			</StandardTooltip>
		</div>
	)

	if (compact) {
		return (
			<Popover open={isExpanded} onOpenChange={setIsExpanded}>
				<div className="flex shrink-0 items-center gap-0.5" data-testid="auto-approve-toolbar">
					{masterCheckbox}
					<PopoverTrigger
						aria-label={t("chat:autoApprove.title")}
						className="flex items-center justify-center h-6 w-4 p-0 border-0 bg-transparent text-vscode-descriptionForeground hover:text-vscode-foreground cursor-pointer">
						<span className="codicon codicon-chevron-up" aria-hidden="true" />
					</PopoverTrigger>
				</div>
				<PopoverContent
					side="top"
					align="end"
					className="p-3 w-[min(440px,calc(100vw-2rem))] max-h-[80vh] overflow-y-auto">
					{isExpanded && settingsContent}
				</PopoverContent>
			</Popover>
		)
	}

	return (
		<div style={style} className="px-[15px] select-none overflow-y-auto">
			{isExpanded && settingsContent}
			<div className="flex items-center gap-2 pt-0.5 cursor-pointer" onClick={toggleExpanded}>
				{masterCheckbox}
				{/* kilocode_change end */}
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: "4px",
						flex: 1,
						minWidth: 0,
					}}>
					<span
						style={{
							color: "var(--vscode-foreground)",
							flexShrink: 0,
						}}>
						{t("chat:autoApprove.title")}
					</span>
					<span
						style={{
							color: "var(--vscode-descriptionForeground)",
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							flex: 1,
							minWidth: 0,
						}}>
						{displayText}
					</span>
					<span
						className={`codicon codicon-chevron-right flex-shrink-0 transition-transform duration-200 ease-in-out ${
							isExpanded ? "-rotate-90 ml-[2px]" : "rotate-0 -ml-[2px]"
						}`}
					/>
				</div>
			</div>
		</div>
	)
}

export default memo(AutoApproveMenu)
