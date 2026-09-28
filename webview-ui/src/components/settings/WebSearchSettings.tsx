// kilocode_change - new file
import { useMemo } from "react"
import { Checkbox } from "vscrui"
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import {
	type ProviderSettings,
	DEFAULT_OPENAI_WEB_SEARCH_ENABLED,
	DEFAULT_OPENAI_WEB_SEARCH_MODEL_ID,
} from "@roo-code/types"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useOpenAiModels } from "../kilocode/hooks/useOpenAiModels"
import { SearchableSetting } from "./SearchableSetting"
import { inputEventTransform, noTransform } from "./transforms"
export function WebSearchSettings({
	apiConfiguration,
	setApiConfigurationField,
}: {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}) {
	const { t } = useAppTranslation()
	const { data: openAiModels } = useOpenAiModels({
		baseUrl: apiConfiguration.openAiBaseUrl,
		apiKey: apiConfiguration.openAiApiKey,
		openAiHeaders: apiConfiguration.openAiHeaders,
		allowInsecureTls: apiConfiguration.allowInsecureTls === true,
		debounceMs: 250,
	})
	const handleInputChange =
		<K extends keyof ProviderSettings, E>(
			field: K,
			transform: (event: E) => ProviderSettings[K] = inputEventTransform,
		) =>
		(event: E | Event) =>
			setApiConfigurationField(field, transform(event as E))
	// kilocode_change start: a native web-search request can use a dedicated model
	// while retaining the current profile's URL, API key, and custom headers. The
	// primary model remains responsible for normal chat and its reasoning settings.
	const webSearchEnabled = apiConfiguration?.openAiWebSearchEnabled ?? DEFAULT_OPENAI_WEB_SEARCH_ENABLED
	const webSearchModelId = apiConfiguration?.openAiWebSearchModelId?.trim() || DEFAULT_OPENAI_WEB_SEARCH_MODEL_ID
	const webSearchModelIds = useMemo(
		() =>
			Array.from(
				new Set(
					[
						webSearchModelId,
						apiConfiguration?.openAiModelId?.trim(),
						...Object.keys(openAiModels ?? {}),
					].filter((modelId): modelId is string => Boolean(modelId)),
				),
			),
		[apiConfiguration?.openAiModelId, openAiModels, webSearchModelId],
	)
	// kilocode_change end

	return (
		<SearchableSetting settingId="web-search" section="ivol" label={t("settings:providers.openAiWebSearch")}>
			<div>
				<Checkbox
					checked={webSearchEnabled}
					onChange={handleInputChange("openAiWebSearchEnabled", noTransform)}>
					{t("settings:providers.openAiWebSearch")}
				</Checkbox>
				<div className="text-sm text-vscode-descriptionForeground ml-6">
					{t("settings:providers.openAiWebSearchDescription")}
				</div>
				{/* kilocode_change start: dedicated model from the current provider catalog */}
				{webSearchEnabled && (
					<div className="ml-6 mt-2">
						<label className="block font-medium mb-1" htmlFor="openai-web-search-model">
							{t("settings:providers.openAiWebSearchModel")}
						</label>
						<VSCodeDropdown
							id="openai-web-search-model"
							value={webSearchModelId}
							onChange={handleInputChange("openAiWebSearchModelId")}
							className="w-full"
							data-testid="openai-web-search-model-select">
							{webSearchModelIds.map((modelId) => (
								<VSCodeOption key={modelId} value={modelId}>
									{modelId}
								</VSCodeOption>
							))}
						</VSCodeDropdown>
						<div className="text-sm text-vscode-descriptionForeground mt-1">
							{t("settings:providers.openAiWebSearchModelDescription")}
						</div>
					</div>
				)}
				{/* kilocode_change end */}
			</div>
		</SearchableSetting>
	)
}
