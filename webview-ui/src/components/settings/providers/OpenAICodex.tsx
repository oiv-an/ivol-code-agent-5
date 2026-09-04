import React from "react"

import { type ModelRecord, type ProviderSettings, openAiCodexDefaultModelId, openAiCodexModels } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button, Checkbox } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"

import { ModelPicker } from "../ModelPicker"
import { OpenAICodexRateLimitDashboard } from "./OpenAICodexRateLimitDashboard"

interface OpenAICodexProps {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	simplifySettings?: boolean
	openAiCodexIsAuthenticated?: boolean
	models?: ModelRecord
}

export const OpenAICodex: React.FC<OpenAICodexProps> = ({
	apiConfiguration,
	setApiConfigurationField,
	simplifySettings,
	openAiCodexIsAuthenticated = false,
	models,
}) => {
	const { t } = useAppTranslation()
	// kilocode_change start: prefer the signed-in account catalog, with a
	// bundled offline fallback so settings remain usable during an outage.
	const availableModels = models && Object.keys(models).length > 0 ? models : openAiCodexModels
	const defaultModelId = availableModels[openAiCodexDefaultModelId]
		? openAiCodexDefaultModelId
		: Object.keys(availableModels)[0] || openAiCodexDefaultModelId
	// kilocode_change end

	return (
		<div className="flex flex-col gap-4">
			{/* Authentication Section */}
			<div className="flex flex-col gap-2">
				{openAiCodexIsAuthenticated ? (
					<div className="flex justify-end">
						<Button
							variant="secondary"
							size="sm"
							onClick={() => vscode.postMessage({ type: "openAiCodexSignOut" })}>
							{t("settings:providers.openAiCodex.signOutButton", {
								defaultValue: "Sign Out",
							})}
						</Button>
					</div>
				) : (
					<Button
						variant="primary"
						onClick={() => vscode.postMessage({ type: "openAiCodexSignIn" })}
						className="w-fit">
						{t("settings:providers.openAiCodex.signInButton", {
							defaultValue: "Sign in to OpenAI Codex",
						})}
					</Button>
				)}
			</div>

			{/* Rate Limit Dashboard - only shown when authenticated */}
			<OpenAICodexRateLimitDashboard isAuthenticated={openAiCodexIsAuthenticated} />

			{/* kilocode_change start: Codex prompt caching is mandatory in this build. */}
			<Checkbox checked={true} disabled>
				<span className="font-medium">
					{t("settings:providers.enablePromptCaching", { defaultValue: "Enable prompt caching" })}
				</span>
			</Checkbox>
			{/* kilocode_change end */}

			{/* Model Picker */}
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={defaultModelId}
				models={availableModels}
				modelIdKey="apiModelId"
				serviceName="OpenAI - ChatGPT Plus/Pro"
				serviceUrl="https://chatgpt.com"
				simplifySettings={simplifySettings}
				hidePricing
			/>
		</div>
	)
}
