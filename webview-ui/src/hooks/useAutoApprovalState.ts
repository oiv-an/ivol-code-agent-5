import { useMemo } from "react"

interface AutoApprovalToggles {
	alwaysAllowReadOnly?: boolean
	alwaysAllowWrite?: boolean
	alwaysAllowExecute?: boolean
	alwaysAllowBrowser?: boolean
	alwaysAllowMcp?: boolean
	alwaysAllowModeSwitch?: boolean
	alwaysAllowSubtasks?: boolean
	alwaysAllowFollowupQuestions?: boolean
}

export function useAutoApprovalState(toggles: AutoApprovalToggles, autoApprovalEnabled?: boolean, yoloActive = false) {
	// kilocode_change
	const hasEnabledOptions = useMemo(() => {
		return Object.values(toggles).some((value) => !!value)
	}, [toggles])

	const effectiveAutoApprovalEnabled = useMemo(() => {
		return yoloActive || (autoApprovalEnabled ?? false) // kilocode_change
	}, [autoApprovalEnabled, yoloActive]) // kilocode_change

	return {
		hasEnabledOptions,
		effectiveAutoApprovalEnabled,
	}
}
