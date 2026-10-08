import { AutocompleteServiceSettings, isPersonalProvider, isPersonalRouterModelProvider } from "@roo-code/types"
import { VSCodeButton, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useOpenAiModels } from "../hooks/useOpenAiModels"
import { useRouterModels } from "@/components/ui/hooks/useRouterModels"
import { SearchableSelect } from "@/components/ui"
import { MODELS_BY_PROVIDER } from "../../settings/constants"

type Settings = NonNullable<AutocompleteServiceSettings>

export function AutocompleteModelPicker({
	settings,
	onChange,
}: {
	settings: Settings
	onChange: <K extends keyof Settings>(field: K, value: Settings[K]) => void
}) {
	const { t } = useAppTranslation()
	const { apiConfiguration, currentApiConfigName, listApiConfigMeta } = useExtensionState()
	const profileId = listApiConfigMeta?.find((profile) => profile.name === currentApiConfigName)?.id
	const provider = apiConfiguration?.apiProvider
	const allowed = isPersonalProvider(provider)
	const openAi = useOpenAiModels({
		profileId,
		baseUrl: apiConfiguration?.openAiBaseUrl,
		apiKey: apiConfiguration?.openAiApiKey,
		openAiHeaders: apiConfiguration?.openAiHeaders,
		allowInsecureTls: apiConfiguration?.allowInsecureTls,
		enabled: provider === "openai",
	})
	const router = useRouterModels(
		{
			profileId,
			allowInsecureTls: apiConfiguration?.allowInsecureTls,
			ollamaBaseUrl: apiConfiguration?.ollamaBaseUrl,
			ollamaApiKey: apiConfiguration?.ollamaApiKey,
			ollamaNumCtx: apiConfiguration?.ollamaNumCtx,
			lmStudioBaseUrl: apiConfiguration?.lmStudioBaseUrl,
		},
		{ provider, enabled: isPersonalRouterModelProvider(provider) },
	)
	const models =
		provider === "openai"
			? openAi.data
			: provider
				? (router.data?.[provider as keyof NonNullable<typeof router.data>] ?? MODELS_BY_PROVIDER[provider])
				: undefined
	const selection = profileId ? settings.currentProviderModels?.[profileId] : undefined
	const modelId = selection?.provider === provider ? (selection?.modelId ?? "") : ""
	const options = [...new Set([...Object.keys(models ?? {}), ...(modelId ? [modelId] : [])])]
		.sort()
		.map((id) => ({ value: id, label: id }))
	const selectModel = (value: string) => {
		if (!profileId || !allowed) return
		onChange("currentProviderModels", {
			...settings.currentProviderModels,
			[profileId]: { provider, modelId: value },
		})
	}
	return (
		<div className="flex flex-col gap-2">
			<div>
				{currentApiConfigName} · {provider}
			</div>
			<div className="text-sm text-vscode-descriptionForeground">
				{t("kilocode:autocomplete.settings.currentProviderDescription")}
			</div>
			<SearchableSelect
				value={modelId}
				onValueChange={selectModel}
				options={options}
				disabled={!allowed || !profileId}
				placeholder={t("kilocode:autocomplete.settings.chooseModel")}
				searchPlaceholder={t("kilocode:autocomplete.settings.chooseModel")}
				emptyMessage={t("kilocode:autocomplete.settings.modelListEmpty")}
			/>
			<VSCodeTextField
				value={modelId}
				onInput={(event) => selectModel((event.target as HTMLInputElement).value)}
				disabled={!allowed || !profileId}>
				{t("kilocode:autocomplete.settings.manualModelId")}
			</VSCodeTextField>
			{(provider === "openai" || isPersonalRouterModelProvider(provider)) && (
				<VSCodeButton
					appearance="secondary"
					onClick={() => void (provider === "openai" ? openAi.refetch() : router.refetch())}>
					{t("kilocode:autocomplete.settings.refreshModels")}
				</VSCodeButton>
			)}
			{(provider === "openai" ? openAi.isError : isPersonalRouterModelProvider(provider) && router.isError) && (
				<div className="text-vscode-errorForeground text-sm">
					{t("kilocode:autocomplete.settings.modelListEmpty")}
				</div>
			)}
		</div>
	)
}
