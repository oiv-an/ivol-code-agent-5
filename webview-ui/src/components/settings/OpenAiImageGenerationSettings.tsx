// kilocode_change - new file
import { useEffect, useMemo, useRef, useState } from "react"
import { Checkbox } from "vscrui"
import { VSCodeButton, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import type { ExtensionMessage, ProviderSettings } from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"

import { useOpenAiModels } from "../kilocode/hooks/useOpenAiModels"
import { SearchableSetting } from "./SearchableSetting"
import { inputEventTransform, noTransform } from "./transforms"

type TestState =
	| { status: "idle" }
	| { status: "running"; requestId: string }
	| { status: "ok"; model: string; durationMs: number; preview?: string }
	| { status: "error"; model: string; error: string }

let testCounter = 0

/**
 * Image generation through the current OpenAI-compatible profile (Images API).
 * The user picks the model from the provider catalog; there is no built-in default.
 */
export function OpenAiImageGenerationSettings({
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
	const [test, setTest] = useState<TestState>({ status: "idle" })
	const pendingRequestId = useRef<string | undefined>(undefined)

	const enabled = apiConfiguration.openAiImageGenerationEnabled === true
	const modelId = apiConfiguration.openAiImageGenerationModelId?.trim() ?? ""
	const modelIds = useMemo(
		() =>
			Array.from(
				new Set([modelId, ...Object.keys(openAiModels ?? {})].filter((id): id is string => Boolean(id))),
			).sort((a, b) => a.localeCompare(b)),
		[modelId, openAiModels],
	)

	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			if (message.type !== "imageGenerationTestResult" || message.requestId !== pendingRequestId.current) return
			pendingRequestId.current = undefined
			const model = String(message.values?.model ?? "")
			if (message.success) {
				setTest({
					status: "ok",
					model,
					durationMs: Number(message.values?.durationMs ?? 0),
					preview: typeof message.values?.preview === "string" ? message.values.preview : undefined,
				})
			} else {
				setTest({ status: "error", model, error: message.error ?? "Unknown error" })
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [])

	// A different model invalidates the previous test result.
	useEffect(() => {
		pendingRequestId.current = undefined
		setTest({ status: "idle" })
	}, [modelId])

	const runTest = () => {
		if (!modelId) return
		const requestId = `image-test-${Date.now()}-${++testCounter}`
		pendingRequestId.current = requestId
		setTest({ status: "running", requestId })
		vscode.postMessage({
			type: "testImageGeneration",
			requestId,
			values: {
				model: modelId,
				baseUrl: apiConfiguration.openAiBaseUrl,
				apiKey: apiConfiguration.openAiApiKey,
				openAiHeaders: apiConfiguration.openAiHeaders,
				allowInsecureTls: apiConfiguration.allowInsecureTls === true,
			},
		})
	}

	return (
		<SearchableSetting
			settingId="image-generation"
			section="ivol"
			label={t("settings:providers.openAiImageGeneration")}>
			<div>
				<Checkbox
					checked={enabled}
					onChange={(value: boolean) =>
						setApiConfigurationField("openAiImageGenerationEnabled", noTransform(value))
					}>
					{t("settings:providers.openAiImageGeneration")}
				</Checkbox>
				<div className="text-sm text-vscode-descriptionForeground ml-6">
					{t("settings:providers.openAiImageGenerationDescription")}
				</div>
				{enabled && (
					<div className="ml-6 mt-2">
						<label className="block font-medium mb-1" htmlFor="openai-image-generation-model">
							{t("settings:providers.openAiImageGenerationModel")}
						</label>
						<div className="flex items-center gap-2">
							<VSCodeDropdown
								id="openai-image-generation-model"
								value={modelId}
								onChange={(event: any) =>
									setApiConfigurationField(
										"openAiImageGenerationModelId",
										inputEventTransform(event) as string,
									)
								}
								className="flex-1 min-w-0"
								data-testid="openai-image-generation-model-select">
								<VSCodeOption value="">
									{t("settings:providers.openAiImageGenerationSelect")}
								</VSCodeOption>
								{modelIds.map((id) => (
									<VSCodeOption key={id} value={id}>
										{id}
									</VSCodeOption>
								))}
							</VSCodeDropdown>
							<VSCodeButton
								appearance="secondary"
								disabled={!modelId || test.status === "running"}
								onClick={runTest}
								data-testid="openai-image-generation-test">
								{test.status === "running"
									? t("settings:providers.openAiImageGenerationTesting")
									: t("settings:providers.openAiImageGenerationTest")}
							</VSCodeButton>
						</div>
						<div className="text-sm text-vscode-descriptionForeground mt-1">
							{t("settings:providers.openAiImageGenerationModelDescription")}
						</div>
						{!modelId && (
							<div className="text-sm text-vscode-errorForeground mt-1">
								{t("settings:providers.openAiImageGenerationNoModel")}
							</div>
						)}
						{test.status === "ok" && (
							<div className="text-sm text-vscode-charts-green mt-2" role="status">
								{t("settings:providers.openAiImageGenerationTestOk", {
									model: test.model,
									seconds: (test.durationMs / 1000).toFixed(1),
								})}
								{test.preview && (
									<img
										src={test.preview}
										alt={t("settings:providers.openAiImageGenerationPreviewAlt")}
										className="block mt-2 max-w-[160px] max-h-[160px] rounded"
									/>
								)}
							</div>
						)}
						{test.status === "error" && (
							<div className="text-sm text-vscode-errorForeground mt-2 break-words" role="alert">
								{t("settings:providers.openAiImageGenerationTestFailed", { model: test.model })}{" "}
								{test.error}
							</div>
						)}
					</div>
				)}
			</div>
		</SearchableSetting>
	)
}
