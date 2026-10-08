import crypto from "crypto"
import { isDeepStrictEqual } from "node:util"
import * as vscode from "vscode"
import { t } from "../../i18n"
import { AutocompleteModel } from "./AutocompleteModel"
import { AutocompleteStatusBar } from "./AutocompleteStatusBar"
import { AutocompleteCodeActionProvider } from "./AutocompleteCodeActionProvider"
import { AutocompleteInlineCompletionProvider } from "./classic-auto-complete/AutocompleteInlineCompletionProvider"
import { AutocompleteServiceSettings, TelemetryEventName } from "@roo-code/types"
import { ContextProxy } from "../../core/config/ContextProxy"
import { TelemetryService } from "@roo-code/telemetry"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { AutocompleteTelemetry } from "./classic-auto-complete/AutocompleteTelemetry"

export class AutocompleteServiceManager {
	private static _instance: AutocompleteServiceManager | null = null

	private readonly model: AutocompleteModel
	private readonly cline: ClineProvider
	private readonly context: vscode.ExtensionContext
	private settings: AutocompleteServiceSettings | null = null

	private taskId: string | null = null

	// Status bar integration
	private statusBar: AutocompleteStatusBar | null = null
	private sessionCost: number = 0
	private completionCount: number = 0
	private sessionStartTime: number = Date.now()

	private snoozeTimer: NodeJS.Timeout | null = null

	// VSCode Providers
	public readonly codeActionProvider: AutocompleteCodeActionProvider
	public readonly inlineCompletionProvider: AutocompleteInlineCompletionProvider
	private inlineCompletionProviderDisposable: vscode.Disposable | null = null

	constructor(context: vscode.ExtensionContext, cline: ClineProvider) {
		if (AutocompleteServiceManager._instance) {
			throw new Error(
				"AutocompleteServiceManager is a singleton. Use AutocompleteServiceManager.getInstance() instead.",
			)
		}

		this.context = context
		this.cline = cline
		AutocompleteServiceManager._instance = this

		// Register Internal Components
		this.model = new AutocompleteModel()

		// Register the providers
		this.codeActionProvider = new AutocompleteCodeActionProvider()
		this.inlineCompletionProvider = new AutocompleteInlineCompletionProvider(
			this.context,
			this.model,
			this.updateCostTracking.bind(this),
			() => this.settings,
			this.cline,
			new AutocompleteTelemetry(),
		)

		void this.load()
	}

	/**
	 * Get the singleton instance of AutocompleteServiceManager
	 */
	public static getInstance(): AutocompleteServiceManager | null {
		return AutocompleteServiceManager._instance
	}

	private loadQueue: Promise<void> = Promise.resolve()
	private loadGeneration = 0
	private loadedCurrentProfile: unknown

	public async loadIfProfileChanged(): Promise<void> {
		await this.loadQueue
		if (!this.settings?.useCurrentProvider) return
		const generation = this.loadGeneration
		const name = ContextProxy.instance.getGlobalState("currentApiConfigName")
		const profile = name ? await this.cline.providerSettingsManager.getProfile({ name }) : undefined
		if (generation !== this.loadGeneration) return this.loadIfProfileChanged()
		// Task restoration activates the same profile too; do not cancel pending editor requests.
		if (isDeepStrictEqual(profile, this.loadedCurrentProfile)) return
		await this.load()
	}

	public load(): Promise<void> {
		const generation = ++this.loadGeneration
		this.model.invalidate()
		this.inlineCompletionProvider.resetModelCache()
		const next = this.loadQueue.then(() => this.loadConfiguration(generation))
		this.loadQueue = next.catch((error) => console.error("Failed to reload autocomplete configuration:", error))
		return next
	}

	private async loadConfiguration(generation: number) {
		if (generation !== this.loadGeneration) return
		await this.cline.providerSettingsManager.initialize() // avoid race condition with settings migrations
		const storedSettings = ContextProxy.instance.getGlobalState("ghostServiceSettings")
		this.settings = {
			...(storedSettings ?? {
				enableSmartInlineTaskKeybinding: true,
				enableAutoTrigger: false,
				enableChatAutocomplete: false,
			}),
		}
		const currentProfileName = ContextProxy.instance.getGlobalState("currentApiConfigName")
		const currentProfile =
			this.settings.useCurrentProvider && currentProfileName
				? await this.cline.providerSettingsManager.getProfile({ name: currentProfileName })
				: undefined
		await this.model.reload(this.cline.providerSettingsManager, this.settings, currentProfile)
		if (generation !== this.loadGeneration) {
			this.model.invalidate()
			return
		}

		this.loadedCurrentProfile = structuredClone(currentProfile)

		// Personal builds require an explicit opt-in before background autocomplete.
		if (this.settings.enableAutoTrigger == undefined) {
			this.settings.enableAutoTrigger = false
		}

		// Chat autocomplete is also opt-in to prevent implicit provider requests.
		if (this.settings.enableChatAutocomplete == undefined) {
			this.settings.enableChatAutocomplete = false
		}

		await this.updateGlobalContext()
		this.updateStatusBar()
		await this.updateInlineCompletionProviderRegistration()
		this.setupSnoozeTimerIfNeeded()
		const settingsWithModelInfo = {
			...this.settings,
			provider: this.getCurrentProviderKey(),
			model: this.getCurrentModelName(),
			hasKilocodeProfileWithNoBalance: this.model.hasKilocodeProfileWithNoBalance,
		}
		// A settings Save can happen during any await above, before its reload command arrives.
		// Never publish the old snapshot over that newer user selection.
		if (
			generation !== this.loadGeneration ||
			ContextProxy.instance.getGlobalState("ghostServiceSettings") !== storedSettings
		)
			return
		await ContextProxy.instance.setValues({ ghostServiceSettings: settingsWithModelInfo })
		await this.cline.postStateToWebview()
	}

	private async updateInlineCompletionProviderRegistration() {
		const shouldBeRegistered = (this.settings?.enableAutoTrigger ?? false) && !this.isSnoozed()
		this.cline.log?.(
			`[Autocomplete] editor=${shouldBeRegistered ? "enabled" : "disabled"}, model=${this.model.hasValidCredentials() ? "configured" : "missing"}, inlineSuggest=${vscode.workspace.getConfiguration("editor").get("inlineSuggest.enabled", true)}`,
		)

		// First, dispose any existing registration
		if (this.inlineCompletionProviderDisposable) {
			this.inlineCompletionProviderDisposable.dispose()
			this.inlineCompletionProviderDisposable = null
		}

		if (!shouldBeRegistered) return

		// Register classic provider
		this.inlineCompletionProviderDisposable = vscode.languages.registerInlineCompletionItemProvider(
			{ scheme: "file" },
			this.inlineCompletionProvider,
		)
		this.context.subscriptions.push(this.inlineCompletionProviderDisposable)
	}

	public async disable() {
		const settings = ContextProxy.instance.getGlobalState("ghostServiceSettings") ?? {}
		await ContextProxy.instance.setValues({
			ghostServiceSettings: {
				...settings,
				enableAutoTrigger: false,
				enableSmartInlineTaskKeybinding: false,
			},
		})

		TelemetryService.instance.captureEvent(TelemetryEventName.GHOST_SERVICE_DISABLED)

		await this.load()
	}

	/**
	 * Check if autocomplete is currently snoozed
	 */
	public isSnoozed(): boolean {
		const snoozeUntil = this.settings?.snoozeUntil
		if (!snoozeUntil) return false
		return Date.now() < snoozeUntil
	}

	/**
	 * Get remaining snooze time in seconds
	 */
	public getSnoozeRemainingSeconds(): number {
		const snoozeUntil = this.settings?.snoozeUntil
		if (!snoozeUntil) return 0
		const remaining = Math.max(0, Math.ceil((snoozeUntil - Date.now()) / 1000))
		return remaining
	}

	/**
	 * Snooze autocomplete for a specified number of seconds
	 */
	public async snooze(seconds: number): Promise<void> {
		if (this.snoozeTimer) {
			clearTimeout(this.snoozeTimer)
			this.snoozeTimer = null
		}

		const snoozeUntil = Date.now() + seconds * 1000
		const settings = ContextProxy.instance.getGlobalState("ghostServiceSettings") ?? {}
		await ContextProxy.instance.setValues({
			ghostServiceSettings: {
				...settings,
				snoozeUntil,
			},
		})

		this.snoozeTimer = setTimeout(() => {
			void this.unsnooze()
		}, seconds * 1000)

		await this.load()
	}

	/**
	 * Cancel snooze and re-enable autocomplete
	 */
	public async unsnooze(): Promise<void> {
		if (this.snoozeTimer) {
			clearTimeout(this.snoozeTimer)
			this.snoozeTimer = null
		}

		const settings = ContextProxy.instance.getGlobalState("ghostServiceSettings") ?? {}
		await ContextProxy.instance.setValues({
			ghostServiceSettings: {
				...settings,
				snoozeUntil: undefined,
			},
		})

		await this.load()
	}

	/**
	 * Set up a timer to auto-unsnooze if we're currently in a snoozed state.
	 * This handles the case where the extension restarts while snoozed -
	 * the persisted snoozeUntil timestamp keeps autocomplete disabled,
	 * and this timer ensures we unsnooze at the correct time.
	 */
	private setupSnoozeTimerIfNeeded(): void {
		if (this.snoozeTimer) {
			clearTimeout(this.snoozeTimer)
			this.snoozeTimer = null
		}

		const remainingMs = this.getSnoozeRemainingMs()
		if (remainingMs <= 0) {
			return
		}

		this.snoozeTimer = setTimeout(() => {
			void this.unsnooze()
		}, remainingMs)
	}

	/**
	 * Get remaining snooze time in milliseconds
	 */
	private getSnoozeRemainingMs(): number {
		const snoozeUntil = this.settings?.snoozeUntil
		if (!snoozeUntil) return 0
		return Math.max(0, snoozeUntil - Date.now())
	}

	public async codeSuggestion() {
		const editor = vscode.window.activeTextEditor
		if (!editor) {
			return
		}

		this.taskId = crypto.randomUUID()
		TelemetryService.instance.captureEvent(TelemetryEventName.INLINE_ASSIST_AUTO_TASK, {
			taskId: this.taskId,
		})

		const document = editor.document

		// Ensure model is loaded
		if (!this.model.loaded) {
			await this.load()
		}

		// Call the inline completion provider directly with manual trigger context
		const position = editor.selection.active
		const documentVersion = document.version
		const context: vscode.InlineCompletionContext = {
			triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
			selectedCompletionInfo: undefined,
		}
		const tokenSource = new vscode.CancellationTokenSource()

		try {
			const completions = await this.inlineCompletionProvider.provideInlineCompletionItems_Internal(
				document,
				position,
				context,
				tokenSource.token,
			)

			// Remote models can be slow: never insert a block into a document or cursor that has changed.
			if (
				vscode.window.activeTextEditor !== editor ||
				document.version !== documentVersion ||
				editor.selection.active.line !== position.line ||
				editor.selection.active.character !== position.character
			)
				return

			// If we got completions, directly insert the first one
			if (completions && (Array.isArray(completions) ? completions.length > 0 : completions.items.length > 0)) {
				const items = Array.isArray(completions) ? completions : completions.items
				const firstCompletion = items[0]

				if (firstCompletion && firstCompletion.insertText) {
					const insertText =
						typeof firstCompletion.insertText === "string"
							? firstCompletion.insertText
							: firstCompletion.insertText.value

					await editor.edit((editBuilder) => {
						editBuilder.insert(position, insertText)
					})
				}
			}
		} finally {
			tokenSource.dispose()
		}
	}

	private async updateGlobalContext() {
		await vscode.commands.executeCommand(
			"setContext",
			"ivol-code-agent-5.autocomplete.enableSmartInlineTaskKeybinding",
			this.settings?.enableSmartInlineTaskKeybinding || false,
		)
	}

	private initializeStatusBar() {
		this.statusBar = new AutocompleteStatusBar({
			enabled: false,
			model: "loading...",
			provider: "loading...",
			totalSessionCost: 0,
			completionCount: 0,
			sessionStartTime: this.sessionStartTime,
		})
	}

	private getCurrentModelName(): string | undefined {
		if (!this.model.loaded) {
			return
		}
		return this.model.getModelName()
	}

	private getCurrentProviderKey(): string | undefined {
		if (!this.model.loaded) {
			return
		}
		return this.model.getProviderKey()
	}

	private getCurrentProviderDisplayName(): string | undefined {
		if (!this.model.loaded) {
			return
		}
		return this.model.getProviderDisplayName()
	}

	private hasNoUsableProvider(): boolean {
		// We have no usable provider if the model is loaded but has no valid credentials
		// and it's not because of a kilocode profile with no balance (that's a different error)
		return this.model.loaded && !this.model.hasValidCredentials() && !this.model.hasKilocodeProfileWithNoBalance
	}

	private updateCostTracking(cost: number, inputTokens: number, outputTokens: number): void {
		this.completionCount++
		this.sessionCost += cost
		this.updateStatusBar()
	}

	private updateStatusBar() {
		if (!this.statusBar) {
			this.initializeStatusBar()
		}

		this.statusBar?.update({
			enabled: this.settings?.enableAutoTrigger,
			snoozed: this.isSnoozed(),
			model: this.getCurrentModelName(),
			provider: this.getCurrentProviderDisplayName(),
			profileName: this.model.profileName,
			hasKilocodeProfileWithNoBalance: this.model.hasKilocodeProfileWithNoBalance,
			hasNoUsableProvider: this.hasNoUsableProvider(),
			totalSessionCost: this.sessionCost,
			completionCount: this.completionCount,
			sessionStartTime: this.sessionStartTime,
		})
	}

	public async showIncompatibilityExtensionPopup() {
		const message = t("kilocode:autocomplete.incompatibilityExtensionPopup.message")
		const disableCopilot = t("kilocode:autocomplete.incompatibilityExtensionPopup.disableCopilot")
		const disableInlineAssist = t("kilocode:autocomplete.incompatibilityExtensionPopup.disableInlineAssist")
		const response = await vscode.window.showErrorMessage(message, disableCopilot, disableInlineAssist)

		if (response === disableCopilot) {
			await vscode.commands.executeCommand<any>("github.copilot.completions.disable")
		} else if (response === disableInlineAssist) {
			await vscode.commands.executeCommand<any>("ivol-code-agent-5.autocomplete.disable")
		}
	}

	/**
	 * Dispose of all resources used by the AutocompleteServiceManager
	 */
	public dispose(): void {
		this.statusBar?.dispose()

		if (this.snoozeTimer) {
			clearTimeout(this.snoozeTimer)
			this.snoozeTimer = null
		}

		// Dispose inline completion provider registration
		if (this.inlineCompletionProviderDisposable) {
			this.inlineCompletionProviderDisposable.dispose()
			this.inlineCompletionProviderDisposable = null
		}

		// Dispose inline completion provider resources
		this.inlineCompletionProvider.dispose()

		// Clear singleton instance
		AutocompleteServiceManager._instance = null
	}

	/**
	 * Reset the singleton instance (for testing purposes only)
	 * @internal
	 */
	public static _resetInstance(): void {
		AutocompleteServiceManager._instance = null
	}
}
