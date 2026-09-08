import { useCallback, useMemo } from "react"
import { VSCodeTextField, VSCodeRadioGroup, VSCodeRadio } from "@vscode/webview-ui-toolkit/react"

import type { ProviderSettings } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useRouterModels } from "@src/components/ui/hooks/useRouterModels" // kilocode_change

import { inputEventTransform } from "../transforms"

type OllamaProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

export const Ollama = ({ apiConfiguration, setApiConfigurationField }: OllamaProps) => {
	const { t } = useAppTranslation()

	// kilocode_change: fetch the exact draft profile with request/TLS isolation.
	const { data: routerModels } = useRouterModels(
		{
			ollamaBaseUrl: apiConfiguration.ollamaBaseUrl,
			ollamaApiKey: apiConfiguration.ollamaApiKey,
			ollamaNumCtx: apiConfiguration.ollamaNumCtx,
			allowInsecureTls: apiConfiguration.allowInsecureTls === true,
		},
		{ provider: "ollama", debounceMs: 250 },
	)
	const ollamaModels = useMemo(() => routerModels?.ollama ?? {}, [routerModels])

	const handleInputChange = useCallback(
		<K extends keyof ProviderSettings, E>(
			field: K,
			transform: (event: E) => ProviderSettings[K] = inputEventTransform,
		) =>
			(event: E | Event) => {
				setApiConfigurationField(field, transform(event as E))
			},
		[setApiConfigurationField],
	)

	// Check if the selected model exists in the fetched models
	// kilocode_change start: validate only after the local catalog has loaded
	const modelNotAvailable = useMemo(() => {
		const selectedModel = apiConfiguration?.ollamaModelId
		if (!selectedModel) return false

		const hasLoadedModels = Object.keys(ollamaModels).length > 0
		return hasLoadedModels && !(selectedModel in ollamaModels)
	}, [apiConfiguration?.ollamaModelId, ollamaModels])
	// kilocode_change end

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration?.ollamaBaseUrl || ""}
				type="url"
				onInput={handleInputChange("ollamaBaseUrl")}
				placeholder={t("settings:defaults.ollamaUrl")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.ollama.baseUrl")}</label>
			</VSCodeTextField>
			{apiConfiguration?.ollamaBaseUrl && (
				<VSCodeTextField
					value={apiConfiguration?.ollamaApiKey || ""}
					type="password"
					onInput={handleInputChange("ollamaApiKey")}
					placeholder={t("settings:placeholders.apiKey")}
					className="w-full">
					<label className="block font-medium mb-1">{t("settings:providers.ollama.apiKey")}</label>
					<div className="text-xs text-vscode-descriptionForeground mt-1">
						{t("settings:providers.ollama.apiKeyHelp")}
					</div>
				</VSCodeTextField>
			)}
			<VSCodeTextField
				value={apiConfiguration?.ollamaModelId || ""}
				onInput={handleInputChange("ollamaModelId")}
				placeholder={t("settings:placeholders.modelId.ollama")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.ollama.modelId")}</label>
			</VSCodeTextField>
			{modelNotAvailable && (
				<div className="flex flex-col gap-2 text-vscode-errorForeground text-sm">
					<div className="flex flex-row items-center gap-1">
						<div className="codicon codicon-close" />
						<div>
							{t("settings:validation.modelAvailability", { modelId: apiConfiguration?.ollamaModelId })}
						</div>
					</div>
				</div>
			)}
			{Object.keys(ollamaModels).length > 0 && (
				<VSCodeRadioGroup
					value={
						(apiConfiguration?.ollamaModelId || "") in ollamaModels ? apiConfiguration?.ollamaModelId : ""
					}
					onChange={handleInputChange("ollamaModelId")}>
					{Object.keys(ollamaModels).map((model) => (
						<VSCodeRadio key={model} value={model} checked={apiConfiguration?.ollamaModelId === model}>
							{model}
						</VSCodeRadio>
					))}
				</VSCodeRadioGroup>
			)}
			<VSCodeTextField
				value={apiConfiguration?.ollamaNumCtx?.toString() || ""}
				onInput={(e: any) => {
					const value = e.target?.value
					if (value === "") {
						setApiConfigurationField("ollamaNumCtx", undefined)
					} else {
						const numValue = parseInt(value, 10)
						if (!isNaN(numValue) && numValue >= 128) {
							setApiConfigurationField("ollamaNumCtx", numValue)
						}
					}
				}}
				placeholder="e.g., 4096"
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.ollama.numCtx")}</label>
				<div className="text-xs text-vscode-descriptionForeground mt-1">
					{t("settings:providers.ollama.numCtxHelp")}
				</div>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground">
				{t("settings:providers.ollama.description")}
				<span className="text-vscode-errorForeground ml-1">{t("settings:providers.ollama.warning")}</span>
			</div>
		</>
	)
}
