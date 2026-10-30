// kilocode_change - new file
import { useEffect, useMemo, useRef, useState } from "react"
import { VSCodeButton, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import type { ExtensionMessage } from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import { SearchableSetting } from "./SearchableSetting"

export type PinnedToolField =
	| "ivolWebSearchProfileId"
	| "ivolWebSearchModelId"
	| "ivolImageGenerationProfileId"
	| "ivolImageGenerationModelId"

let requestCounter = 0
const nextRequestId = (prefix: string) => `${prefix}-${Date.now()}-${++requestCounter}`

/** Loads the model catalog of a saved profile; credentials stay in the extension. */
function usePinnedProfileModels(profileId: string) {
	const [models, setModels] = useState<string[]>([])
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | undefined>()
	const pending = useRef<string | undefined>(undefined)

	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const message = event.data as ExtensionMessage & { error?: string }
			if (message.type !== "openAiModels" || !message.requestId || message.requestId !== pending.current) return
			pending.current = undefined
			setLoading(false)
			setModels([...(message.openAiModels ?? [])].sort((a, b) => a.localeCompare(b)))
			setError(message.error)
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [])

	useEffect(() => {
		setModels([])
		setError(undefined)
		if (!profileId) {
			pending.current = undefined
			setLoading(false)
			return
		}
		const requestId = nextRequestId("pinned-models")
		pending.current = requestId
		setLoading(true)
		vscode.postMessage({ type: "requestPinnedProfileModels", requestId, values: { profileId } })
	}, [profileId])

	return { models, loading, error }
}

type TestState =
	| { status: "idle" }
	| { status: "running" }
	| { status: "ok"; model: string; durationMs: number; preview?: string }
	| { status: "error"; model: string; error: string }

function PinnedToolRow({
	kind,
	profileId,
	modelId,
	onProfileChange,
	onModelChange,
}: {
	kind: "webSearch" | "imageGeneration"
	profileId: string
	modelId: string
	onProfileChange: (value: string) => void
	onModelChange: (value: string) => void
}) {
	const { t } = useAppTranslation()
	const { listApiConfigMeta } = useExtensionState()
	const { models, loading, error } = usePinnedProfileModels(profileId)
	const [test, setTest] = useState<TestState>({ status: "idle" })
	const pendingTest = useRef<string | undefined>(undefined)

	const profiles = useMemo(
		() => (listApiConfigMeta ?? []).filter((entry) => entry.apiProvider === "openai"),
		[listApiConfigMeta],
	)
	const profileMissing = !!profileId && !profiles.some((entry) => entry.id === profileId)
	const modelIds = useMemo(
		() => Array.from(new Set([modelId, ...models].filter(Boolean))).sort((a, b) => a.localeCompare(b)),
		[modelId, models],
	)

	useEffect(() => {
		if (kind !== "imageGeneration") return
		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			if (message.type !== "imageGenerationTestResult" || message.requestId !== pendingTest.current) return
			pendingTest.current = undefined
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
	}, [kind])

	useEffect(() => {
		pendingTest.current = undefined
		setTest({ status: "idle" })
	}, [profileId, modelId])

	const runTest = () => {
		const requestId = nextRequestId("pinned-image-test")
		pendingTest.current = requestId
		setTest({ status: "running" })
		vscode.postMessage({ type: "testImageGeneration", requestId, values: { profileId, model: modelId } })
	}

	const prefix = kind === "webSearch" ? "pinnedWebSearch" : "pinnedImageGeneration"
	const label = t(`settings:ivol.${prefix}`)

	return (
		<SearchableSetting settingId={`pinned-${kind}`} section="ivol" label={label}>
			<div className="mb-4">
				<div className="font-medium">{label}</div>
				<div className="text-sm text-vscode-descriptionForeground mb-2">
					{t(`settings:ivol.${prefix}Description`)}
				</div>
				<label className="block text-sm mb-1" htmlFor={`${prefix}-profile`}>
					{t("settings:ivol.pinnedProfile")}
				</label>
				<VSCodeDropdown
					id={`${prefix}-profile`}
					value={profileId}
					onChange={(event: any) => {
						const value = String(event.target?.value ?? "")
						onProfileChange(value)
						onModelChange("")
					}}
					className="w-full"
					data-testid={`${prefix}-profile-select`}>
					<VSCodeOption value="">{t("settings:ivol.pinnedProfileActive")}</VSCodeOption>
					{profiles.map((entry) => (
						<VSCodeOption key={entry.id} value={entry.id}>
							{entry.name}
						</VSCodeOption>
					))}
				</VSCodeDropdown>
				{profileMissing && (
					<div className="text-sm text-vscode-errorForeground mt-1">
						{t("settings:ivol.pinnedProfileMissing")}
					</div>
				)}
				{profileId && !profileMissing && (
					<>
						<label className="block text-sm mt-2 mb-1" htmlFor={`${prefix}-model`}>
							{t("settings:ivol.pinnedModel")}
						</label>
						<div className="flex items-center gap-2">
							<VSCodeDropdown
								id={`${prefix}-model`}
								value={modelId}
								onChange={(event: any) => onModelChange(String(event.target?.value ?? ""))}
								className="flex-1 min-w-0"
								data-testid={`${prefix}-model-select`}>
								<VSCodeOption value="">
									{loading
										? t("settings:ivol.pinnedModelsLoading")
										: t("settings:ivol.pinnedModelSelect")}
								</VSCodeOption>
								{modelIds.map((id) => (
									<VSCodeOption key={id} value={id}>
										{id}
									</VSCodeOption>
								))}
							</VSCodeDropdown>
							{kind === "imageGeneration" && (
								<VSCodeButton
									appearance="secondary"
									disabled={!modelId || test.status === "running"}
									onClick={runTest}
									data-testid={`${prefix}-test`}>
									{test.status === "running"
										? t("settings:providers.openAiImageGenerationTesting")
										: t("settings:providers.openAiImageGenerationTest")}
								</VSCodeButton>
							)}
						</div>
						{error && (
							<div className="text-sm text-vscode-errorForeground mt-1 break-words" role="alert">
								{error}
							</div>
						)}
						{!modelId && (
							<div className="text-sm text-vscode-descriptionForeground mt-1">
								{t(`settings:ivol.${prefix}NoModel`)}
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
					</>
				)}
			</div>
		</SearchableSetting>
	)
}

/** Global pins: web search and image generation through chosen saved profiles. */
export function PinnedToolSettings({
	ivolWebSearchProfileId,
	ivolWebSearchModelId,
	ivolImageGenerationProfileId,
	ivolImageGenerationModelId,
	setField,
}: {
	ivolWebSearchProfileId?: string
	ivolWebSearchModelId?: string
	ivolImageGenerationProfileId?: string
	ivolImageGenerationModelId?: string
	setField: (field: PinnedToolField, value: string) => void
}) {
	const { t } = useAppTranslation()
	return (
		<div data-testid="pinned-tool-settings">
			<p className="text-sm text-vscode-descriptionForeground mb-3">{t("settings:ivol.pinnedToolsHelp")}</p>
			<PinnedToolRow
				kind="webSearch"
				profileId={ivolWebSearchProfileId ?? ""}
				modelId={ivolWebSearchModelId ?? ""}
				onProfileChange={(value) => setField("ivolWebSearchProfileId", value)}
				onModelChange={(value) => setField("ivolWebSearchModelId", value)}
			/>
			<PinnedToolRow
				kind="imageGeneration"
				profileId={ivolImageGenerationProfileId ?? ""}
				modelId={ivolImageGenerationModelId ?? ""}
				onProfileChange={(value) => setField("ivolImageGenerationProfileId", value)}
				onModelChange={(value) => setField("ivolImageGenerationModelId", value)}
			/>
		</div>
	)
}
