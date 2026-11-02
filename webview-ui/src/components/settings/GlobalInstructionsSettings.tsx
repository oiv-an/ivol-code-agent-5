// kilocode_change - new file
import { useEffect, useState } from "react"
import type { ExtensionMessage } from "@roo-code/types"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button } from "@src/components/ui"
import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { SearchableSetting } from "./SearchableSetting"

export function GlobalInstructionsSettings() {
	const { t } = useAppTranslation()
	const [state, setState] = useState<ExtensionMessage["globalInstructions"]>()
	useEffect(() => {
		const listener = (event: MessageEvent<ExtensionMessage>) => {
			if (event.data.type === "globalInstructions") setState(event.data.globalInstructions)
		}
		window.addEventListener("message", listener)
		vscode.postMessage({ type: "getGlobalInstructions" })
		return () => window.removeEventListener("message", listener)
	}, [])
	return (
		<SearchableSetting
			settingId="global-instructions"
			section="ivol"
			label={t("settings:globalInstructions.title")}>
			<SectionHeader>{t("settings:globalInstructions.title")}</SectionHeader>
			<Section>
				<p className="text-sm text-vscode-descriptionForeground">
					{t("settings:globalInstructions.description")}
				</p>
				{state?.path && <p className="text-xs break-all select-text">{state.path}</p>}
				<Button variant="secondary" onClick={() => vscode.postMessage({ type: "openGlobalInstructions" })}>
					{t("settings:globalInstructions.title")}
				</Button>
				{state?.error && (
					<p role="alert" className="text-vscode-errorForeground">
						{state.error}
					</p>
				)}
			</Section>
		</SearchableSetting>
	)
}
