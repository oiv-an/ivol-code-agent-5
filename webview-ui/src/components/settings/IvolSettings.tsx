// kilocode_change - new file
import { VSCodeCheckbox, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { isIntelligentTaskEnabled, type ProviderSettings } from "@roo-code/types"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { Slider } from "@/components/ui"
import { ModelPresetsSettings } from "../kilocode/chat/ModelPresets"
import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { PersonalBrowserSettings } from "./PersonalBrowserSettings"
import { WebSearchSettings } from "./WebSearchSettings"
import { OpenAiImageGenerationSettings } from "./OpenAiImageGenerationSettings" // kilocode_change
import { PinnedToolSettings } from "./PinnedToolSettings" // kilocode_change
import { TelegramSettings } from "./TelegramSettings"
import { ProjectTaskStorageSettings } from "./ProjectTaskStorageSettings"

export function IntelligentTaskSettings({
	enabled,
	onChange,
}: {
	enabled?: boolean
	onChange: (enabled: boolean) => void
}) {
	const { t } = useAppTranslation()
	const { taskDocumentSettings } = useExtensionState()
	if (taskDocumentSettings?.supported !== true) return null
	return (
		<SearchableSetting settingId="intelligent-task" section="ivol" label={t("settings:intelligentTask.label")}>
			<VSCodeCheckbox
				data-testid="intelligent-task-checkbox"
				checked={isIntelligentTaskEnabled(enabled)}
				onChange={(event) => onChange((event.target as HTMLInputElement).checked)}>
				{t("settings:intelligentTask.label")}
			</VSCodeCheckbox>
			<p className="text-sm text-vscode-descriptionForeground">{t("settings:intelligentTask.description")}</p>
			<p className="text-sm text-vscode-descriptionForeground">{t("settings:intelligentTask.compaction")}</p>
			<p className="text-xs text-vscode-descriptionForeground">{t("settings:intelligentTask.scope")}</p>
		</SearchableSetting>
	)
}

export function IvolSettings({
	apiConfiguration,
	profileName,
	activeProfileName,
	onSelectProfile,
	setApiConfigurationField,
	browserMode,
	browserOSAllowTaskActions,
	frozenMessagesBudgetPercent,
	ivolWebSearchProfileId,
	ivolWebSearchModelId,
	ivolImageGenerationProfileId,
	ivolImageGenerationModelId,
	setCachedStateField,
}: {
	apiConfiguration: ProviderSettings
	profileName: string
	activeProfileName?: string // kilocode_change
	onSelectProfile?: (name: string) => void // kilocode_change
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	browserMode?: "isolated" | "chrome-extension" | "browseros"
	browserOSAllowTaskActions?: boolean
	frozenMessagesBudgetPercent?: number
	ivolWebSearchProfileId?: string
	ivolWebSearchModelId?: string
	ivolImageGenerationProfileId?: string
	ivolImageGenerationModelId?: string
	setCachedStateField: SetCachedStateField<
		| "browserMode"
		| "browserOSAllowTaskActions"
		| "browserToolEnabled"
		| "frozenMessagesBudgetPercent"
		| "ivolWebSearchProfileId"
		| "ivolWebSearchModelId"
		| "ivolImageGenerationProfileId"
		| "ivolImageGenerationModelId"
	>
}) {
	const { t } = useAppTranslation()
	const { listApiConfigMeta } = useExtensionState() // kilocode_change
	return (
		<div data-testid="ivol-settings">
			<SectionHeader description={t("settings:ivol.description")}>{t("settings:sections.ivol")}</SectionHeader>
			<SectionHeader>{t("settings:ivol.profile", { name: profileName })}</SectionHeader>
			<Section>
				{/* kilocode_change start: choose which saved profile these settings edit */}
				{onSelectProfile && (listApiConfigMeta?.length ?? 0) > 0 && (
					<div className="mb-2">
						<label className="block font-medium mb-1" htmlFor="ivol-profile-select">
							{t("settings:ivol.profileSelect")}
						</label>
						<VSCodeDropdown
							id="ivol-profile-select"
							value={profileName}
							onChange={(event: any) => {
								const value = String(event.target?.value ?? "")
								if (value && value !== profileName) onSelectProfile(value)
							}}
							className="w-full"
							data-testid="ivol-profile-select">
							{(listApiConfigMeta ?? [])
								.filter((entry) => entry.profileType !== "autocomplete")
								.map((entry) => (
									<VSCodeOption key={entry.id} value={entry.name}>
										{entry.name === activeProfileName
											? t("settings:ivol.profileActiveSuffix", { name: entry.name })
											: entry.name}
									</VSCodeOption>
								))}
						</VSCodeDropdown>
						<p className="text-sm text-vscode-descriptionForeground mt-1">
							{t("settings:ivol.profileSelectHelp")}
						</p>
					</div>
				)}
				{/* kilocode_change end */}
				<p className="text-sm text-vscode-descriptionForeground">{t("settings:ivol.profileHelp")}</p>
				<IntelligentTaskSettings
					enabled={apiConfiguration.intelligentTaskEnabled}
					onChange={(enabled) => setApiConfigurationField("intelligentTaskEnabled", enabled)}
				/>
				<SearchableSetting settingId="model-presets" section="ivol" label={t("settings:modelPresets.title")}>
					<ModelPresetsSettings
						configuration={apiConfiguration}
						onChange={(presets) => setApiConfigurationField("modelPresets", presets)}
					/>
				</SearchableSetting>
				{["openai", "openai-responses"].includes(apiConfiguration.apiProvider ?? "") && (
					<WebSearchSettings
						apiConfiguration={apiConfiguration}
						setApiConfigurationField={setApiConfigurationField}
					/>
				)}
				{/* kilocode_change start: native image generation (Images API) */}
				{apiConfiguration.apiProvider === "openai" && (
					<OpenAiImageGenerationSettings
						apiConfiguration={apiConfiguration}
						setApiConfigurationField={setApiConfigurationField}
					/>
				)}
				{/* kilocode_change end */}
			</Section>
			{/* kilocode_change start: search / image generation pinned to saved profiles (all profiles) */}
			<SectionHeader>{t("settings:ivol.pinnedTools")}</SectionHeader>
			<Section>
				<PinnedToolSettings
					ivolWebSearchProfileId={ivolWebSearchProfileId}
					ivolWebSearchModelId={ivolWebSearchModelId}
					ivolImageGenerationProfileId={ivolImageGenerationProfileId}
					ivolImageGenerationModelId={ivolImageGenerationModelId}
					setField={(field, value) => setCachedStateField(field, value)}
				/>
				{/* kilocode_change end */}
			</Section>
			<SectionHeader>{t("settings:ivol.memory")}</SectionHeader>
			<Section>
				<SearchableSetting
					settingId="frozen-messages-budget"
					section="ivol"
					label={t("settings:contextManagement.frozenMessagesBudget.label")}>
					<label className="block font-medium" id="frozen-budget-label">
						{t("settings:contextManagement.frozenMessagesBudget.label")}
					</label>
					<div className="flex items-center gap-2 mt-2">
						<Slider
							min={5}
							max={90}
							step={5}
							value={[frozenMessagesBudgetPercent ?? 50]}
							onValueChange={([value]) => setCachedStateField("frozenMessagesBudgetPercent", value)}
							data-testid="frozen-budget-slider"
							aria-labelledby="frozen-budget-label"
						/>
						<span className="w-12 shrink-0 text-right">{frozenMessagesBudgetPercent ?? 50}%</span>
					</div>
					<p className="text-sm text-vscode-descriptionForeground">
						{t("settings:contextManagement.frozenMessagesBudget.description")}
					</p>
				</SearchableSetting>
			</Section>
			<SearchableSetting
				settingId="project-task-storage"
				section="ivol"
				label={t("settings:projectTaskStorage.title")}>
				<ProjectTaskStorageSettings />
			</SearchableSetting>
			<PersonalBrowserSettings
				browserMode={browserMode}
				browserOSAllowTaskActions={browserOSAllowTaskActions}
				setCachedStateField={setCachedStateField}
			/>
			<SearchableSetting settingId="telegram" section="ivol" label={t("settings:telegram.title")}>
				<TelegramSettings />
			</SearchableSetting>
		</div>
	)
}
