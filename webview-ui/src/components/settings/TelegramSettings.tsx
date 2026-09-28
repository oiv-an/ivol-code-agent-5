// kilocode_change - new file
import { useEffect, useRef, useState } from "react"
import type { ExtensionMessage } from "@roo-code/types"
import { useTelegramState } from "@src/hooks/useTelegramState"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"
import { Button, Input } from "@src/components/ui"
import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"

export function TelegramSettings() {
	const { t } = useAppTranslation()
	const state = useTelegramState()
	const [token, setToken] = useState("")
	const [ownerId, setOwnerId] = useState("")
	const [dirty, setDirty] = useState(false)
	const [saving, setSaving] = useState(false)
	const pendingSave = useRef<string>()
	useEffect(() => {
		if (state && !dirty) setOwnerId(state.ownerId ? String(state.ownerId) : "")
	}, [state, dirty])
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
			if (event.data.telegramSettingsSaved) {
				setToken("")
				setDirty(false)
			}
		}
		window.addEventListener("message", listener)
		return () => window.removeEventListener("message", listener)
	}, [])
	return (
		<>
			<SectionHeader>{t("settings:telegram.title")}</SectionHeader>
			<Section>
				<div className="flex flex-col gap-3">
					<p className="m-0 text-vscode-descriptionForeground">{t("settings:telegram.description")}</p>
					<label className="flex flex-col gap-1">
						{t("settings:telegram.token")}
						<Input
							disabled={saving}
							type="password"
							autoComplete="off"
							value={token}
							placeholder={state?.configured ? t("settings:telegram.tokenSaved") : ""}
							onChange={(event) => {
								setToken(event.target.value)
								setDirty(true)
							}}
						/>
					</label>
					<label className="flex flex-col gap-1">
						{t("settings:telegram.ownerId")}
						<Input
							disabled={saving}
							inputMode="numeric"
							value={ownerId}
							onChange={(event) => {
								setOwnerId(event.target.value)
								setDirty(true)
							}}
						/>
					</label>
					<div className="flex flex-wrap gap-3">
						<a href="https://t.me/BotFather" className="text-vscode-textLink-foreground">
							{t("settings:telegram.botFather")}
						</a>
						<a href="https://t.me/userinfobot" className="text-vscode-textLink-foreground">
							{t("settings:telegram.findId")}
						</a>
					</div>
					<p className="m-0 text-vscode-descriptionForeground">{t("settings:telegram.privacy")}</p>
					<Button
						disabled={saving || !/^\d+$/.test(ownerId) || (!state?.configured && !token.trim())}
						onClick={() => {
							pendingSave.current = crypto.randomUUID()
							setSaving(true)
							vscode.postMessage({
								type: "saveTelegramSettings",
								telegramSettings: {
									token: token || undefined,
									ownerId,
									requestId: pendingSave.current,
								},
							})
						}}>
						{t("settings:telegram.save")}
					</Button>
					{state?.error && (
						<p role="alert" className="m-0 text-vscode-errorForeground">
							{state.error}
						</p>
					)}
				</div>
			</Section>
		</>
	)
}
