// kilocode_change - new file
import * as vscode from "vscode"
import { AutocompleteServiceManager } from "./AutocompleteServiceManager"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { registerAutocompleteJetbrainsBridge } from "./AutocompleteJetbrainsBridge"
import { RooCodeEventName } from "@roo-code/types"

export const registerAutocompleteProvider = (context: vscode.ExtensionContext, cline: ClineProvider) => {
	const autocompleteManager = new AutocompleteServiceManager(context, cline)
	context.subscriptions.push(autocompleteManager)
	const reloadProfile = () => {
		void autocompleteManager
			.loadIfProfileChanged()
			.catch((error) => console.error("Failed to switch autocomplete profile:", error))
	}
	cline.on(RooCodeEventName.ProviderProfileChanged, reloadProfile)
	context.subscriptions.push({
		dispose: () => {
			cline.off(RooCodeEventName.ProviderProfileChanged, reloadProfile)
		},
	})

	// Register JetBrains Bridge if applicable
	registerAutocompleteJetbrainsBridge(context, cline, autocompleteManager)

	// Register AutocompleteServiceManager Commands
	context.subscriptions.push(
		vscode.commands.registerCommand("ivol-code-agent-5.autocomplete.reload", async () => {
			await autocompleteManager.load()
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand("ivol-code-agent-5.autocomplete.codeActionQuickFix", async () => {
			return
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand("ivol-code-agent-5.autocomplete.generateSuggestions", async () => {
			autocompleteManager.codeSuggestion()
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"ivol-code-agent-5.autocomplete.showIncompatibilityExtensionPopup",
			async () => {
				await autocompleteManager.showIncompatibilityExtensionPopup()
			},
		),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand("ivol-code-agent-5.autocomplete.disable", async () => {
			await autocompleteManager.disable()
		}),
	)

	// Register AutocompleteServiceManager Code Actions
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider("*", autocompleteManager.codeActionProvider, {
			providedCodeActionKinds: Object.values(autocompleteManager.codeActionProvider.providedCodeActionKinds),
		}),
	)
}
