// kilocode_change - new file
import { useCallback, useEffect, useRef, useState } from "react"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import { type ExtensionMessage, type ProviderSettings, openAiModelInfoSaneDefaults } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"

type PriceMatch = {
	id: string
	inputPrice: number
	outputPrice: number
	cacheReadsPrice?: number
	cacheWritesPrice?: number
}

type LookupState =
	| { status: "idle" }
	| { status: "loading"; requestId: string }
	| { status: "ok"; match: PriceMatch }
	| { status: "error"; error: string }

let requestCounter = 0

const formatPrice = (value?: number) => (value === undefined ? "—" : `$${Number(value.toFixed(4)).toString()}`)

/**
 * Shows which OpenRouter model provides automatic prices for the current
 * OpenAI-compatible model and lets the user copy those prices into the profile.
 */
export const OpenRouterPricing = ({
	apiConfiguration,
	setApiConfigurationField,
}: {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}) => {
	const { t } = useAppTranslation()
	const modelId = apiConfiguration.openAiModelId?.trim() ?? ""
	const [state, setState] = useState<LookupState>({ status: "idle" })
	const pending = useRef<{ requestId: string; apply: boolean } | undefined>(undefined)
	const configRef = useRef(apiConfiguration)
	configRef.current = apiConfiguration

	const info = apiConfiguration.openAiCustomModelInfo
	const hasManualPrices = (info?.inputPrice ?? 0) > 0 || (info?.outputPrice ?? 0) > 0

	const lookup = useCallback(
		(apply: boolean) => {
			if (!modelId) {
				setState({ status: "idle" })
				return
			}
			const requestId = `openrouter-pricing-${Date.now()}-${++requestCounter}`
			pending.current = { requestId, apply }
			setState({ status: "loading", requestId })
			vscode.postMessage({ type: "requestOpenRouterPricing", requestId, values: { modelId, force: apply } })
		},
		[modelId],
	)

	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			const current = pending.current
			if (message.type !== "openRouterPricing" || !current || message.requestId !== current.requestId) return
			const { apply } = current
			pending.current = undefined
			const match = message.values?.match as PriceMatch | undefined
			if (!message.success || !match) {
				setState({ status: "error", error: message.error ?? "Unknown error" })
				return
			}
			setState({ status: "ok", match })
			if (apply) {
				setApiConfigurationField("openAiCustomModelInfo", {
					...(configRef.current.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults),
					inputPrice: match.inputPrice,
					outputPrice: match.outputPrice,
					cacheReadsPrice: match.cacheReadsPrice ?? 0,
					cacheWritesPrice: match.cacheWritesPrice ?? 0,
				})
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [setApiConfigurationField])

	// Show the automatic match whenever the model changes.
	useEffect(() => {
		lookup(false)
	}, [lookup])

	if (!modelId) return null

	return (
		<div className="flex flex-col gap-1" data-testid="openrouter-pricing">
			<div className="text-sm text-vscode-descriptionForeground">
				{state.status === "loading" &&
					t("settings:providers.customModel.openRouterPricing.loading", {
						defaultValue: "Looking up OpenRouter prices…",
					})}
				{state.status === "ok" &&
					(hasManualPrices
						? t("settings:providers.customModel.openRouterPricing.manual", {
								defaultValue:
									"Manual prices are used. OpenRouter match: {{id}} — input {{input}}, output {{output}} per 1M tokens.",
								id: state.match.id,
								input: formatPrice(state.match.inputPrice),
								output: formatPrice(state.match.outputPrice),
							})
						: t("settings:providers.customModel.openRouterPricing.auto", {
								defaultValue:
									"Automatic prices from OpenRouter: {{id}} — input {{input}}, output {{output}}, cache read {{cacheRead}}, cache write {{cacheWrite}} per 1M tokens (refreshed daily).",
								id: state.match.id,
								input: formatPrice(state.match.inputPrice),
								output: formatPrice(state.match.outputPrice),
								cacheRead: formatPrice(state.match.cacheReadsPrice),
								cacheWrite: formatPrice(state.match.cacheWritesPrice),
							}))}
				{state.status === "error" && state.error}
			</div>
			<div>
				<VSCodeButton
					appearance="secondary"
					disabled={state.status === "loading"}
					onClick={() => lookup(true)}
					data-testid="openrouter-pricing-apply">
					{t("settings:providers.customModel.openRouterPricing.apply", {
						defaultValue: "Fetch prices from OpenRouter",
					})}
				</VSCodeButton>
			</div>
		</div>
	)
}
