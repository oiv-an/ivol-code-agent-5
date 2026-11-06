// kilocode_change - new file
import { useEffect, useState } from "react"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import type { ExtensionMessage } from "@roo-code/types"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { SearchableSetting } from "./SearchableSetting"

export function BuiltInChatSettings() {
	const { t } = useAppTranslation()
	const [state, setState] = useState<ExtensionMessage["builtInChatDisabled"]>()
	useEffect(() => {
		const listener = (event: MessageEvent<ExtensionMessage>) => {
			if (event.data.type === "builtInChatDisabled") setState(event.data.builtInChatDisabled)
		}
		window.addEventListener("message", listener)
		vscode.postMessage({ type: "getBuiltInChatDisabled" })
		return () => window.removeEventListener("message", listener)
	}, [])
	return (
		<SearchableSetting settingId="built-in-chat" section="ivol" label={t("settings:builtInChat.title")}>
			<SectionHeader>{t("settings:builtInChat.title")}</SectionHeader>
			<Section>
				<VSCodeCheckbox
					checked={state?.disabled ?? false}
					disabled={!state}
					onChange={(event) =>
						vscode.postMessage({
							type: "setBuiltInChatDisabled",
							bool: (event.target as HTMLInputElement).checked,
						})
					}>
					<span className="font-medium">{t("settings:builtInChat.label")}</span>
				</VSCodeCheckbox>
				<p className="text-sm text-vscode-descriptionForeground">{t("settings:builtInChat.description")}</p>
				{state?.error && (
					<p role="alert" className="text-vscode-errorForeground">
						{state.error}
					</p>
				)}
			</Section>
		</SearchableSetting>
	)
}
