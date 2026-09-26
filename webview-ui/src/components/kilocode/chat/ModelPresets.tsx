import {
	modelPresetTiers,
	openAiModelInfoSaneDefaults,
	OPENROUTER_DEFAULT_PROVIDER_NAME,
	type ModelPreset,
	type ModelPresets,
	type ProviderSettings,
} from "@roo-code/types"
import { SelectDropdown } from "@/components/ui/select-dropdown"
import { useProviderModels } from "../hooks/useProviderModels"
import { getModelIdKey } from "../hooks/useSelectedModel"
import { getActiveModelPreset } from "./modelPresetSelection"
import { ReasoningEffortSelector } from "./ReasoningEffortSelector"
import { vscode } from "@/utils/vscode"
import { useAppTranslation } from "@/i18n/TranslationContext"

export const supportsModelPresets = (config: ProviderSettings) =>
	!!config.apiProvider &&
	config.profileType !== "autocomplete" &&
	!["vscode-lm", "oca", "virtual-quota-fallback"].includes(config.apiProvider)

/** Apply only the model and reasoning settings; credentials and profile identity stay intact. */
export function applyModelPreset(config: ProviderSettings, preset: ModelPreset): ProviderSettings {
	if (!config.apiProvider || !supportsModelPresets(config)) return config
	const next: ProviderSettings = {
		...config,
		[getModelIdKey({ provider: config.apiProvider })]: preset.modelId,
		reasoningEffort: preset.reasoningEffort,
		enableReasoningEffort: preset.enableReasoningEffort,
	}
	if (config.apiProvider === "openrouter" && config.openRouterModelId !== preset.modelId) {
		next.openRouterSpecificProvider = OPENROUTER_DEFAULT_PROVIDER_NAME
	}
	if (["openai", "openai-responses"].includes(config.apiProvider)) {
		const info = { ...(config.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults) }
		if (!preset.reasoningEffort || preset.reasoningEffort === "disable") delete info.reasoningEffort
		else info.reasoningEffort = preset.reasoningEffort
		next.openAiCustomModelInfo = info
	}
	return next
}

export function ModelPresetsSettings({
	configuration,
	onChange,
}: {
	configuration: ProviderSettings
	onChange: (presets: ModelPresets) => void
}) {
	const { t } = useAppTranslation()
	const { providerModels = {} } = useProviderModels(configuration)
	if (!supportsModelPresets(configuration)) return null
	return (
		<fieldset className="min-w-0 border border-vscode-input-border rounded p-2 space-y-2">
			<legend>{t("settings:modelPresets.title")}</legend>
			<p className="text-xs text-vscode-descriptionForeground m-0">{t("settings:modelPresets.description")}</p>
			{modelPresetTiers.map((tier) => {
				const preset = configuration.modelPresets?.[tier]
				const modelId = preset?.modelId ?? ""
				const ids = Array.from(new Set([...Object.keys(providerModels), ...(modelId ? [modelId] : [])]))
				return (
					<div key={tier} className="flex flex-wrap items-center gap-2">
						<span className="w-8 text-xs font-bold">{tier.toUpperCase()}</span>
						<SelectDropdown
							portalToBody
							contentClassName="max-h-[400px] overflow-y-auto"
							value={modelId}
							title={t("settings:modelPresets.model", { tier: tier.toUpperCase() })}
							options={[
								{ value: "", label: t("settings:modelPresets.unconfigured") },
								...ids.map((id) => ({ value: id, label: providerModels[id]?.displayName ?? id })),
							]}
							onChange={(id) =>
								onChange({ ...configuration.modelPresets, [tier]: id ? { modelId: id } : undefined })
							}
							triggerClassName="min-w-0 max-w-full"
						/>
						{preset && (
							<ReasoningEffortSelector
								currentApiConfigName="preset-draft"
								apiConfiguration={applyModelPreset(configuration, preset)}
								modelInfo={providerModels[modelId]}
								onConfigurationChange={(next) =>
									onChange({
										...configuration.modelPresets,
										[tier]: {
											...preset,
											reasoningEffort: next.reasoningEffort,
											enableReasoningEffort: next.enableReasoningEffort,
										},
									})
								}
							/>
						)}
					</div>
				)
			})}
		</fieldset>
	)
}

export function ModelPresetSelector({
	configuration,
	profileName,
}: {
	configuration: ProviderSettings
	profileName?: string
}) {
	const { t } = useAppTranslation()
	if (!profileName || !supportsModelPresets(configuration) || !configuration.apiProvider) return null
	const presets = configuration.modelPresets
	if (!presets || !modelPresetTiers.some((tier) => presets[tier]?.modelId)) return null
	const active = getActiveModelPreset(configuration)
	return (
		<div
			role="group"
			aria-label={t("settings:modelPresets.selector")}
			className="inline-flex shrink-0 items-center gap-1">
			{modelPresetTiers.map((tier) => {
				const preset = presets[tier]
				const selected = tier === active
				return (
					<button
						key={tier}
						type="button"
						aria-pressed={selected}
						disabled={!preset?.modelId}
						title={
							preset?.modelId
								? `${preset.modelId} · ${preset.reasoningEffort ?? "default"}`
								: t("settings:modelPresets.unconfigured")
						}
						className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder ${selected ? "bg-green-500/20 text-green-400 border-green-500/60" : "bg-transparent text-vscode-descriptionForeground border-transparent hover:border-vscode-input-border"}`}
						onClick={() => {
							if (!preset?.modelId || selected) return
							vscode.postMessage({
								type: "upsertApiConfiguration",
								text: profileName,
								apiConfiguration: {
									...applyModelPreset(configuration, preset),
									activeModelPreset: tier,
								},
							})
						}}>
						{tier.toUpperCase()}
					</button>
				)
			})}
		</div>
	)
}
