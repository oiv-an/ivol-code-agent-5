import { reasoningEfforts, openAiModelInfoSaneDefaults, type ModelInfo, type ProviderSettings } from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { SelectDropdown } from "@/components/ui/select-dropdown"
import { vscode } from "@/utils/vscode"

interface ReasoningEffortSelectorProps {
	currentApiConfigName?: string
	apiConfiguration: ProviderSettings
	modelInfo?: ModelInfo
}

type Effort = NonNullable<ProviderSettings["reasoningEffort"]>

/** A quick editor for the existing profile setting, not a separate chat-only override. */
export const ReasoningEffortSelector = ({
	currentApiConfigName,
	apiConfiguration,
	modelInfo,
}: ReasoningEffortSelectorProps) => {
	const { t } = useAppTranslation()
	const isCustomOpenAi = ["openai", "openai-responses"].includes(apiConfiguration.apiProvider ?? "")
	if (
		!currentApiConfigName ||
		apiConfiguration.profileType === "autocomplete" ||
		apiConfiguration.apiProvider === "virtual-quota-fallback"
	) {
		return null
	}

	// Match ThinkingBudget's precedence: binary/budget models have an on/off
	// setting, not invented effort levels. Keep their existing token budget intact.
	const isToggle =
		!isCustomOpenAi &&
		(modelInfo?.supportsReasoningBinary || (modelInfo?.supportsReasoningBudget && !!modelInfo.maxTokens))
	const supports = isCustomOpenAi ? true : modelInfo?.supportsReasoningEffort
	if (!isToggle && (!supports || (Array.isArray(supports) && supports.length === 0))) return null

	const required = isToggle
		? !modelInfo?.supportsReasoningBinary && modelInfo?.requiredReasoningBudget
		: modelInfo?.requiredReasoningEffort
	const levels: Effort[] = Array.isArray(supports) ? [...supports] : [...reasoningEfforts]
	if (!levels.includes("max")) levels.push("max")
	if (!required && supports === true && !levels.includes("disable")) levels.unshift("disable")
	const available = isToggle
		? required
			? ["enabled"]
			: ["disable", "enabled"]
		: levels.filter((level) => !required || level !== "disable")

	const storedEffort =
		apiConfiguration.reasoningEffort ??
		(isCustomOpenAi ? apiConfiguration.openAiCustomModelInfo?.reasoningEffort : undefined)
	const defaultEffort = modelInfo?.reasoningEffort ?? (required ? "medium" : "disable")
	const value = isToggle
		? required ||
			(apiConfiguration.enableReasoningEffort ??
				!!(modelInfo?.supportsReasoningBinary || modelInfo?.supportsAdaptiveThinking))
			? "enabled"
			: "disable"
		: !required && apiConfiguration.enableReasoningEffort === false
			? "disable"
			: required && storedEffort === "disable"
				? defaultEffort
				: (storedEffort ?? defaultEffort)
	const label = (effort: string) =>
		isToggle
			? t(`common:answers.${effort === "enabled" ? "yes" : "no"}`)
			: t(`settings:providers.reasoningEffort.${effort === "disable" ? "none" : effort}`)
	const title = t(isToggle ? "settings:providers.useReasoning" : "settings:providers.reasoningEffort.label")

	const onChange = (next: string) => {
		if (!available.includes(next) || next === value) return
		const updated: ProviderSettings = { ...apiConfiguration, enableReasoningEffort: next !== "disable" }
		if (isToggle && next === "enabled" && updated.reasoningEffort === "disable") {
			// Binary-compatible request builders also honor this legacy sentinel.
			// Clear it when re-enabling reasoning, without changing the token budget.
			updated.reasoningEffort = undefined
		}
		if (!isToggle) {
			updated.reasoningEffort = next as Effort
			if (isCustomOpenAi) {
				// The custom-provider settings panel reads the nested field; the API
				// handler also reads the top-level preference. Update both atomically.
				const info = { ...(apiConfiguration.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults) }
				if (next === "disable") delete info.reasoningEffort
				else info.reasoningEffort = next as ModelInfo["reasoningEffort"]
				updated.openAiCustomModelInfo = info
			}
		}
		vscode.postMessage({
			type: "upsertApiConfiguration",
			text: currentApiConfigName,
			apiConfiguration: updated,
		})
	}

	return (
		<div
			role="group"
			aria-label={title}
			className="min-w-0 max-w-[45%] shrink-0"
			data-testid="reasoning-effort-selector">
			<SelectDropdown
				key={`${currentApiConfigName}:${apiConfiguration.apiProvider}`}
				value={value}
				options={available.map((effort) => ({
					value: effort,
					label: label(effort),
					codicon: "codicon-lightbulb",
				}))}
				onChange={onChange}
				title={title}
				placeholder={label(value)}
				disableSearch
				disabled={isToggle && !!required}
				align="end"
				triggerClassName="max-w-[140px] py-0 px-1 border-transparent"
				contentClassName="w-auto min-w-[160px] max-h-[320px] overflow-y-auto"
			/>
		</div>
	)
}
