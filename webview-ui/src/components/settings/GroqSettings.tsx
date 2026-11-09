// kilocode_change - new file: Groq key for Telegram voice-message transcription
import { useEffect, useRef, useState } from "react"
import type { ExtensionMessage } from "@roo-code/types"
import { useTelegramState } from "@src/hooks/useTelegramState"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"
import { Button, Input } from "@src/components/ui"
import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"

export function GroqSettings() {
	const { t } = useAppTranslation()
	const state = useTelegramState()
	const [apiKey, setApiKey] = useState("")
	const [saving, setSaving] = useState(false)
	const pendingSave = useRef<string>()
	useEffect(() => {
		const listener = (event: MessageEvent<ExtensionMessage>) => {
			if (
				event.data.type !== "telegramSettingsSaved" ||
				!pendingSave.current ||
				event.data.telegramRequestId !== pendingSave.current
			)
				return
			pendingSave.current = undefined
			setSaving(false)
			if (event.data.telegramSettingsSaved) setApiKey("")
		}
		window.addEventListener("message", listener)
		return () => window.removeEventListener("message", listener)
	}, [])
	const save = (value: string) => {
		pendingSave.current = crypto.randomUUID()
		setSaving(true)
		vscode.postMessage({ type: "saveGroqApiKey", groqApiKey: { apiKey: value, requestId: pendingSave.current } })
	}
	return (
		<>
			<SectionHeader>{t("settings:groq.title")}</SectionHeader>
			<Section>
				<div className="flex flex-col gap-3">
					<p className="m-0 text-vscode-descriptionForeground">{t("settings:groq.description")}</p>
					<label className="flex flex-col gap-1">
						{t("settings:groq.apiKey")}
						<Input
							disabled={saving}
							type="password"
							autoComplete="off"
							value={apiKey}
							placeholder={state?.groqConfigured ? t("settings:groq.keySaved") : "gsk_..."}
							onChange={(event) => setApiKey(event.target.value)}
						/>
					</label>
					<a href="https://console.groq.com/keys" className="text-vscode-textLink-foreground">
						{t("settings:groq.getKey")}
					</a>
					<div className="flex flex-wrap gap-2">
						<Button disabled={saving || !apiKey.trim()} onClick={() => save(apiKey.trim())}>
							{t("settings:groq.save")}
						</Button>
						{state?.groqConfigured && (
							<Button variant="secondary" disabled={saving} onClick={() => save("")}>
								{t("settings:groq.remove")}
							</Button>
						)}
					</div>
				</div>
			</Section>
		</>
	)
}
