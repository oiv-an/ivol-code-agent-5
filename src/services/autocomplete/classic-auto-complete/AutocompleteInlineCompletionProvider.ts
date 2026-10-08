import * as vscode from "vscode"
import {
	extractPrefixSuffix,
	AutocompleteSuggestionContext,
	contextToAutocompleteInput,
	AutocompleteContextProvider,
	FillInAtCursorSuggestion,
	AutocompletePrompt,
	MatchingSuggestionResult,
	CostTrackingCallback,
	LLMRetrievalResult,
	PendingRequest,
	AutocompleteContext,
	LastSuggestionInfo,
} from "../types"
import { HoleFiller } from "./HoleFiller"
import { FimPromptBuilder } from "./FillInTheMiddle"
import { AutocompleteModel } from "../AutocompleteModel"
import { ContextRetrievalService } from "../continuedev/core/autocomplete/context/ContextRetrievalService"
import { VsCodeIde } from "../continuedev/core/vscode-test-harness/src/VSCodeIde"
import { RecentlyVisitedRangesService } from "../continuedev/core/vscode-test-harness/src/autocomplete/RecentlyVisitedRangesService"
import { RecentlyEditedTracker } from "../continuedev/core/vscode-test-harness/src/autocomplete/recentlyEdited"
import type { AutocompleteServiceSettings } from "@roo-code/types"
import { postprocessAutocompleteSuggestion } from "./uselessSuggestionFilter"
import { shouldSkipAutocomplete } from "./contextualSkip"
import { RooIgnoreController } from "../../../core/ignore/RooIgnoreController"
import { ClineProvider } from "../../../core/webview/ClineProvider"
import { AutocompleteTelemetry } from "./AutocompleteTelemetry"

const MAX_SUGGESTIONS_HISTORY = 20

/**
 * Minimum debounce delay in milliseconds.
 * The adaptive debounce delay will never go below this value, even when
 * average latencies are very fast.
 */
const MIN_DEBOUNCE_DELAY_MS = 150

/**
 * Initial debounce delay in milliseconds.
 * This value is used as the starting debounce delay before enough latency samples
 * are collected. Once LATENCY_SAMPLE_SIZE samples are collected, the debounce delay
 * is dynamically adjusted to the average of recent request latencies.
 */
const INITIAL_DEBOUNCE_DELAY_MS = 300

/**
 * Maximum debounce delay in milliseconds.
 * This caps the adaptive debounce delay to prevent excessive waiting times
 * even when latencies are high.
 */
const MAX_DEBOUNCE_DELAY_MS = 1000

/**
 * Number of latency samples to collect before using adaptive debounce delay.
 * Once this many samples are collected, the debounce delay becomes the average
 * of the stored latencies, updated after each request.
 */
const LATENCY_SAMPLE_SIZE = 10

export type { CostTrackingCallback, AutocompletePrompt, MatchingSuggestionResult, LLMRetrievalResult }

/**
 * Result from findMatchingSuggestion including the original suggestion for telemetry tracking
 */
export interface MatchingSuggestionWithFillIn extends MatchingSuggestionResult {
	/** The original FillInAtCursorSuggestion for telemetry tracking */
	fillInAtCursor: FillInAtCursorSuggestion
}

/**
 * Find a matching suggestion from the history based on current prefix and suffix.
 *
 * @param prefix - The text before the cursor position
 * @param suffix - The text after the cursor position
 * @param suggestionsHistory - Array of previous suggestions (most recent last)
 * @returns The matching suggestion with match type and the original FillInAtCursorSuggestion, or null if no match found
 */
export function findMatchingSuggestion(
	prefix: string,
	suffix: string,
	suggestionsHistory: FillInAtCursorSuggestion[],
): MatchingSuggestionWithFillIn | null {
	// Search from most recent to least recent
	for (let i = suggestionsHistory.length - 1; i >= 0; i--) {
		const fillInAtCursor = suggestionsHistory[i]

		// First, try exact prefix/suffix match
		if (prefix === fillInAtCursor.prefix && suffix === fillInAtCursor.suffix) {
			return {
				text: fillInAtCursor.text,
				matchType: "exact",
				fillInAtCursor,
			}
		}

		// If no exact match, but suggestion is available, check for partial typing
		// The user may have started typing the suggested text
		if (
			fillInAtCursor.text !== "" &&
			prefix.startsWith(fillInAtCursor.prefix) &&
			suffix === fillInAtCursor.suffix
		) {
			// Extract what the user has typed between the original prefix and current position
			const typedContent = prefix.substring(fillInAtCursor.prefix.length)

			// Check if the typed content matches the beginning of the suggestion
			if (fillInAtCursor.text.startsWith(typedContent)) {
				// Return the remaining part of the suggestion (with already-typed portion removed)
				return {
					text: fillInAtCursor.text.substring(typedContent.length),
					matchType: "partial_typing",
					fillInAtCursor,
				}
			}
		}

		// Check for backward deletion: user deleted characters from the end of the prefix
		// The stored prefix should start with the current prefix (current is shorter)
		// Only use this logic if the original suggestion is non-empty
		if (
			fillInAtCursor.text !== "" &&
			fillInAtCursor.prefix.startsWith(prefix) &&
			suffix === fillInAtCursor.suffix
		) {
			// Extract the deleted portion of the prefix
			const deletedContent = fillInAtCursor.prefix.substring(prefix.length)

			// Return the deleted portion plus the original suggestion text
			return {
				text: deletedContent + fillInAtCursor.text,
				matchType: "backward_deletion",
				fillInAtCursor,
			}
		}
	}

	return null
}

/**
 * Transforms a matching suggestion result by applying first-line-only logic if needed.
 * Use this at call sites where you want to show only the first line of multi-line completions
 * when the cursor is in the middle of a line.
 *
 * @param result - The result from findMatchingSuggestion
 * @param prefix - The text before the cursor position
 * @returns A new result with potentially truncated text, or null if input was null
 */
export function applyFirstLineOnly(
	result: MatchingSuggestionWithFillIn | null,
	prefix: string,
	fullBlock = false,
): MatchingSuggestionWithFillIn | null {
	if (fullBlock || result === null || result.text === "") {
		return result
	}
	if (shouldShowOnlyFirstLine(prefix, result.text)) {
		const firstLineText = getFirstLine(result.text)
		return {
			text: firstLineText,
			matchType: result.matchType,
			fillInAtCursor: result.fillInAtCursor,
		}
	}
	return result
}

/**
 * Command ID for tracking inline completion acceptance.
 * This command is executed after the user accepts an inline completion.
 */
export const INLINE_COMPLETION_ACCEPTED_COMMAND = "ivol-code-agent-5.autocomplete.inline-completion.accepted"

/**
 * Counts the number of lines in a text string.
 *
 * Notes:
 * - Returns 0 for an empty string
 * - A single trailing newline (or CRLF) does not count as an additional line
 *
 * @param text - The text to count lines in
 * @returns The number of lines
 */
export function countLines(text: string): number {
	if (text === "") {
		return 0
	}

	// Count line breaks and add 1 for the first line.
	// If the text ends with a line break, don't count the implicit trailing empty line.
	const lineBreakCount = (text.match(/\r?\n/g) || []).length
	const endsWithLineBreak = text.endsWith("\n")

	return lineBreakCount + 1 - (endsWithLineBreak ? 1 : 0)
}

/**
 * Determines if only the first line of a completion should be shown.
 *
 * The logic is:
 * - If the suggestion starts with a newline → show the whole block
 * - If the prefix's last line has non-whitespace text → show only the first line
 * - If at start of line and suggestion is 3+ lines → show only the first line
 * - Otherwise → show the whole block
 *
 * @param prefix - The text before the cursor position
 * @param suggestion - The completion text being suggested
 * @returns true if only the first line should be shown
 */
export function shouldShowOnlyFirstLine(prefix: string, suggestion: string): boolean {
	// If the suggestion starts with a newline, show the whole block
	if (suggestion.startsWith("\n") || suggestion.startsWith("\r\n")) {
		return false
	}

	// Check if the current line (before cursor) has non-whitespace text
	const lastNewlineIndex = prefix.lastIndexOf("\n")
	const currentLinePrefix = prefix.slice(lastNewlineIndex + 1)

	// if the first line contains no word characters, show the whole block
	if (!currentLinePrefix.match(/\w/)) {
		return false
	}

	// If the current line prefix contains non-whitespace, only show the first line
	if (currentLinePrefix.trim().length > 0) {
		return true
	}

	// At start of line (only whitespace before cursor on this line)
	// Show only first line if suggestion is 3 or more lines
	const lineCount = countLines(suggestion)
	return lineCount >= 3
}

/**
 * Extracts the first line from a completion text.
 *
 * @param text - The full completion text
 * @returns The first line of the completion (without the newline)
 */
export function getFirstLine(text: string): string {
	return text.split(/\r?\n/, 1)[0]
}

export function stringToInlineCompletions(
	text: string,
	position: vscode.Position,
	document?: vscode.TextDocument,
	selected?: vscode.SelectedCompletionInfo,
): vscode.InlineCompletionItem[] {
	if (text === "") {
		return []
	}

	let range = new vscode.Range(position, position)
	if (selected && document) {
		// VS Code only previews an extension of the selected IntelliSense item with the same range.
		// Never manufacture a different completion just to make an incompatible item visible.
		if (
			selected.range.start.line !== position.line ||
			selected.range.end.line !== position.line ||
			selected.range.start.character > position.character ||
			selected.range.end.character < position.character
		)
			return []
		const before = document.getText(new vscode.Range(selected.range.start, position))
		const after = document.getText(new vscode.Range(position, selected.range.end))
		text = before + text + after
		if (!text.startsWith(selected.text)) return []
		range = selected.range
	}
	const item = new vscode.InlineCompletionItem(text, range, {
		command: INLINE_COMPLETION_ACCEPTED_COMMAND,
		title: "Autocomplete Accepted",
	})
	return [item]
}

export class AutocompleteInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	public suggestionsHistory: FillInAtCursorSuggestion[] = []
	/** Tracks all pending/in-flight requests */
	private pendingRequests: (PendingRequest & { scope: string; waiters: (() => boolean)[] })[] = []
	private cancelDebounce: (() => void) | null = null
	private activeFetch: Promise<void> | null = null
	private suggestionScopes = new WeakMap<FillInAtCursorSuggestion, string>()

	private suggestionsForDocument(scope: string): FillInAtCursorSuggestion[] {
		return this.suggestionsHistory.filter((suggestion) => {
			const owner = this.suggestionScopes.get(suggestion)
			return owner === undefined || owner === scope
		})
	}
	private disposed = false
	public holeFiller: HoleFiller // publicly exposed for Jetbrains autocomplete code
	public fimPromptBuilder: FimPromptBuilder // publicly exposed for Jetbrains autocomplete code
	private model: AutocompleteModel
	private costTrackingCallback: CostTrackingCallback
	private getSettings: () => AutocompleteServiceSettings | null
	private recentlyVisitedRangesService: RecentlyVisitedRangesService
	private recentlyEditedTracker: RecentlyEditedTracker
	private debounceTimer: NodeJS.Timeout | null = null
	private isFirstCall: boolean = true
	private ignoreController?: Promise<RooIgnoreController>
	private acceptedCommand: vscode.Disposable | null = null
	private debounceDelayMs: number = INITIAL_DEBOUNCE_DELAY_MS
	private latencyHistory: number[] = []
	private telemetry: AutocompleteTelemetry | null
	/** Information about the last suggestion shown to the user */
	private lastSuggestion: LastSuggestionInfo | null = null
	private diagnosticLog: (message: string) => void = () => {}
	private lastDiagnostic = ""
	private lastDiagnosticTime = 0

	private trace(message: string): void {
		// No source text, paths, credentials or raw provider errors in diagnostic output.
		if (message === this.lastDiagnostic && Date.now() - this.lastDiagnosticTime < 2000) return
		this.lastDiagnostic = message
		this.lastDiagnosticTime = Date.now()
		this.diagnosticLog(`[Autocomplete] ${message}`)
	}

	constructor(
		context: vscode.ExtensionContext,
		model: AutocompleteModel,
		costTrackingCallback: CostTrackingCallback,
		getSettings: () => AutocompleteServiceSettings | null,
		cline: ClineProvider,
		telemetry: AutocompleteTelemetry | null = null,
	) {
		this.diagnosticLog = (message) => cline.log?.(message)
		this.telemetry = telemetry
		this.model = model
		this.costTrackingCallback = costTrackingCallback
		this.getSettings = getSettings

		// Create ignore controller internally
		this.ignoreController = (async () => {
			const ignoreController = new RooIgnoreController(cline.cwd)
			await ignoreController.initialize()
			return ignoreController
		})()

		const ide = new VsCodeIde(context)
		const contextService = new ContextRetrievalService(ide)
		const contextProvider: AutocompleteContextProvider = {
			ide,
			contextService,
			model,
			ignoreController: this.ignoreController,
		}
		this.holeFiller = new HoleFiller(contextProvider)
		this.fimPromptBuilder = new FimPromptBuilder(contextProvider)

		this.recentlyVisitedRangesService = new RecentlyVisitedRangesService(ide)
		this.recentlyEditedTracker = new RecentlyEditedTracker(ide)

		this.acceptedCommand = vscode.commands.registerCommand(INLINE_COMPLETION_ACCEPTED_COMMAND, () =>
			this.telemetry?.captureAcceptSuggestion(this.lastSuggestion?.length),
		)
	}

	private configurationGeneration = 0

	public resetModelCache(): void {
		this.configurationGeneration++
		this.suggestionsHistory = []
		this.cancelDebounce?.()
		this.pendingRequests = []
		this.lastSuggestion = null
		this.telemetry?.cancelVisibilityTracking()
	}

	public updateSuggestions(fillInAtCursor: FillInAtCursorSuggestion): void {
		const isDuplicate = this.suggestionsHistory.some(
			(existing) =>
				existing.text === fillInAtCursor.text &&
				existing.prefix === fillInAtCursor.prefix &&
				existing.suffix === fillInAtCursor.suffix &&
				this.suggestionScopes.get(existing) === this.suggestionScopes.get(fillInAtCursor),
		)

		if (isDuplicate) {
			return
		}

		// Add to the end of the array (most recent)
		this.suggestionsHistory.push(fillInAtCursor)

		// Remove oldest if we exceed the limit
		if (this.suggestionsHistory.length > MAX_SUGGESTIONS_HISTORY) {
			this.suggestionsHistory.shift()
		}
	}

	public async getPrompt(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<{ prompt: AutocompletePrompt; prefix: string; suffix: string }> {
		// Build complete context with all tracking data
		const recentlyVisitedRanges = this.recentlyVisitedRangesService.getSnippets()
		const recentlyEditedRanges = await this.recentlyEditedTracker.getRecentlyEditedRanges()

		const context: AutocompleteSuggestionContext = {
			document,
			range: new vscode.Range(position, position),
			recentlyVisitedRanges,
			recentlyEditedRanges,
		}

		const autocompleteInput = contextToAutocompleteInput(context)

		const { prefix, suffix } = extractPrefixSuffix(document, position)
		const languageId = document.languageId

		// Determine strategy based on model capabilities and call only the appropriate prompt builder
		const prompt = this.model.supportsFim()
			? await this.fimPromptBuilder.getFimPrompts(autocompleteInput, this.model.getModelName() ?? "codestral")
			: await this.holeFiller.getPrompts(autocompleteInput, languageId)

		return { prompt, prefix, suffix }
	}

	private processSuggestion(
		suggestionText: string,
		prefix: string,
		suffix: string,
		model: AutocompleteModel,
		telemetryContext: AutocompleteContext,
		languageId?: string,
	): FillInAtCursorSuggestion {
		if (!suggestionText) {
			this.telemetry?.captureSuggestionFiltered("empty_response", telemetryContext)
			return { text: "", prefix, suffix }
		}

		const processedText = postprocessAutocompleteSuggestion({
			suggestion: suggestionText,
			prefix,
			suffix,
			model: model.getModelName() || "",
			languageId,
		})

		if (processedText) {
			return { text: processedText, prefix, suffix }
		}

		this.telemetry?.captureSuggestionFiltered("filtered_by_postprocessing", telemetryContext)
		return { text: "", prefix, suffix }
	}

	private async disposeIgnoreController(): Promise<void> {
		if (this.ignoreController) {
			const ignoreController = this.ignoreController
			this.ignoreController = undefined
			;(await ignoreController).dispose()
		}
	}

	/**
	 * Records a latency measurement and updates the adaptive debounce delay.
	 * Maintains a rolling window of the last LATENCY_SAMPLE_SIZE latencies.
	 * Once enough samples are collected, the debounce delay is set to the
	 * average of all stored latencies, clamped between MIN_DEBOUNCE_DELAY_MS
	 * and MAX_DEBOUNCE_DELAY_MS.
	 *
	 * @param latencyMs - The latency of the most recent request in milliseconds
	 */
	public recordLatency(latencyMs: number): void {
		// Add the new latency to the history
		this.latencyHistory.push(latencyMs)

		// Remove oldest if we exceed the sample size
		if (this.latencyHistory.length > LATENCY_SAMPLE_SIZE) {
			this.latencyHistory.shift()

			// Once we have enough samples, update the debounce delay to the average
			const sum = this.latencyHistory.reduce((acc, val) => acc + val, 0)
			const averageLatency = Math.round(sum / this.latencyHistory.length)

			// Clamp the debounce delay between MIN and MAX
			this.debounceDelayMs = Math.max(MIN_DEBOUNCE_DELAY_MS, Math.min(averageLatency, MAX_DEBOUNCE_DELAY_MS))
		}
	}

	public dispose(): void {
		this.disposed = true
		this.resetModelCache()
		this.telemetry?.dispose()
		this.recentlyVisitedRangesService.dispose()
		this.recentlyEditedTracker.dispose()
		void this.disposeIgnoreController()
		if (this.acceptedCommand) {
			this.acceptedCommand.dispose()
			this.acceptedCommand = null
		}
	}

	public async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.InlineCompletionContext,
		_token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList> {
		this.trace("Editor requested inline completion")
		const settings = this.getSettings()
		const isAutoTriggerEnabled = settings?.enableAutoTrigger ?? false

		if (!isAutoTriggerEnabled) {
			this.trace("Skipped: editor autocomplete disabled")
			return []
		}

		return this.provideInlineCompletionItems_Internal(document, position, _context, _token)
	}

	public async provideInlineCompletionItems_Internal(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.InlineCompletionContext,
		_token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList> {
		if (!document?.uri?.fsPath) return []
		const version = document.version
		const generation = this.configurationGeneration
		const scope = document.uri.toString()
		const editor = vscode.window.activeTextEditor
		const tracksEditor = editor?.document === document
		const isCurrent = () =>
			!this.disposed &&
			!_token.isCancellationRequested &&
			generation === this.configurationGeneration &&
			document.version === version &&
			!document.isClosed &&
			(!tracksEditor ||
				(vscode.window.activeTextEditor === editor &&
					editor.selection.active.line === position.line &&
					editor.selection.active.character === position.character))
		if (!isCurrent()) return []
		// Build telemetry context
		const telemetryContext: AutocompleteContext = {
			languageId: document.languageId,
			modelId: this.model?.getModelName(),
			provider: this.model?.getProviderDisplayName(),
		}

		this.telemetry?.captureSuggestionRequested(telemetryContext)

		if (!this.model || !this.model.hasValidCredentials()) {
			this.trace("Skipped: no configured autocomplete model")
			// bail if no model is available or no valid API credentials configured
			// this prevents errors when autocomplete is enabled but no provider is set up
			return []
		}

		if (!document?.uri?.fsPath) {
			return []
		}

		try {
			// Check if file is ignored (for manual trigger via codeSuggestion)
			// Skip ignore check for untitled documents
			if (this.ignoreController && !document.isUntitled) {
				try {
					// Try to get the controller with a short timeout
					const controller = await Promise.race([
						this.ignoreController,
						new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
					])

					if (!controller) {
						this.trace("Skipped: file access check not ready")
						// If promise hasn't resolved yet, assume file is ignored
						return []
					}

					const isAccessible = controller.validateAccess(document.fileName)
					if (!isAccessible) {
						this.trace("Skipped: file excluded by ignore rules")
						return []
					}
				} catch (error) {
					console.error("[AutocompleteInlineCompletionProvider] Error checking file access:", error)
					// On error, assume file is ignored
					return []
				}
			}

			if (!isCurrent()) return []
			const { prefix, suffix } = extractPrefixSuffix(document, position)

			// Check cache first - allow mid-word lookups from cache
			const matchingResult = applyFirstLineOnly(
				findMatchingSuggestion(prefix, suffix, this.suggestionsForDocument(scope)),
				prefix,
				this.getSettings()?.fullBlock ?? true,
			)

			if (matchingResult !== null) {
				this.lastSuggestion = {
					...telemetryContext,
					length: matchingResult.text.length,
				}
				this.telemetry?.captureCacheHit(matchingResult.matchType, telemetryContext, matchingResult.text.length)
				this.telemetry?.startVisibilityTracking(matchingResult.fillInAtCursor, "cache", telemetryContext)
				return stringToInlineCompletions(
					matchingResult.text,
					position,
					document,
					_context.selectedCompletionInfo,
				)
			}

			this.telemetry?.cancelVisibilityTracking() // No suggestion to show - cancel any pending visibility tracking

			// Only skip new LLM requests during mid-word typing or at end of statement
			// Cache lookups above are still allowed
			if (
				_context.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke &&
				shouldSkipAutocomplete(prefix, suffix, document.languageId)
			) {
				this.trace("Skipped: automatic context filter (manual invocation can bypass it)")
				return []
			}

			this.trace("Preparing code context")
			const { prompt, prefix: promptPrefix, suffix: promptSuffix } = await this.getPrompt(document, position)
			if (!isCurrent() || promptPrefix !== prefix || promptSuffix !== suffix) return []

			// Update context with strategy now that we know it
			telemetryContext.strategy = prompt.strategy

			await this.debouncedFetchAndCacheSuggestion(
				prompt,
				promptPrefix,
				promptSuffix,
				document.languageId,
				scope,
				isCurrent,
			)
			if (!isCurrent()) {
				this.trace("Discarded: editor cancelled request, document or model changed")
				return []
			}

			const cachedResult = applyFirstLineOnly(
				findMatchingSuggestion(prefix, suffix, this.suggestionsForDocument(scope)),
				prefix,
				this.getSettings()?.fullBlock ?? true,
			)
			if (cachedResult) {
				this.lastSuggestion = {
					...telemetryContext,
					length: cachedResult.text.length,
				}
				this.telemetry?.captureLlmSuggestionReturned(telemetryContext, cachedResult.text.length)
				this.telemetry?.startVisibilityTracking(cachedResult.fillInAtCursor, "llm", telemetryContext)
			} else {
				this.telemetry?.cancelVisibilityTracking() // No suggestion to show - cancel any pending visibility tracking
			}

			const items = stringToInlineCompletions(
				cachedResult?.text ?? "",
				position,
				document,
				_context.selectedCompletionInfo,
			)
			this.trace(
				items.length ? "Completion ready for editor" : "No compatible completion for current editor context",
			)
			return items
		} catch (error) {
			// only big catch at the top of the call-chain, if anything goes wrong at a lower level
			// do not catch, just let the error cascade
			this.trace("Failed before displaying completion (context preparation or editor integration)")
			console.error("[AutocompleteInlineCompletionProvider] Error providing inline completion:", error)
			return []
		}
	}

	/**
	 * Find a pending request that covers the current prefix/suffix.
	 * A request covers the current position if:
	 * 1. The suffix matches (user hasn't changed text after cursor)
	 * 2. The current prefix either equals or extends the pending prefix
	 *    (user is typing forward, not backspacing or editing earlier)
	 *
	 * @returns The covering pending request, or null if none found
	 */
	private findCoveringPendingRequest(prefix: string, suffix: string, scope: string) {
		for (const pendingRequest of this.pendingRequests) {
			// Suffix must match exactly (text after cursor unchanged)
			if (scope !== pendingRequest.scope || suffix !== pendingRequest.suffix) {
				continue
			}

			// Current prefix must start with the pending prefix (user typed more)
			// or be exactly equal (same position)
			if (prefix.startsWith(pendingRequest.prefix)) {
				return pendingRequest
			}
		}
		return null
	}

	/**
	 * Remove a pending request from the list when it completes.
	 */
	private removePendingRequest(request: PendingRequest): void {
		const index = this.pendingRequests.findIndex((pending) => pending === request)
		if (index !== -1) {
			this.pendingRequests.splice(index, 1)
		}
	}

	/**
	 * Debounced fetch with leading edge execution and pending request reuse.
	 * - First call executes immediately (leading edge)
	 * - Subsequent calls reset the timer and wait for DEBOUNCE_DELAY_MS of inactivity (trailing edge)
	 * - If a pending request covers the current prefix/suffix, reuse it instead of starting a new one
	 */
	private debouncedFetchAndCacheSuggestion(
		prompt: AutocompletePrompt,
		prefix: string,
		suffix: string,
		languageId: string,
		scope: string,
		isCurrent: () => boolean,
	): Promise<void> {
		const generation = this.configurationGeneration
		const coveringRequest = this.findCoveringPendingRequest(prefix, suffix, scope)
		if (coveringRequest) {
			coveringRequest.waiters.push(isCurrent)
			return coveringRequest.promise
		}

		const leading = this.isFirstCall && !this.activeFetch
		this.cancelDebounce?.()
		this.isFirstCall = false
		let resolve!: () => void
		let reject!: (error: unknown) => void
		const pendingRequest = {
			prefix,
			suffix,
			scope,
			waiters: [isCurrent],
			promise: new Promise<void>((res, rej) => {
				resolve = res
				reject = rej
			}),
		}
		this.pendingRequests.push(pendingRequest)
		let cancelled = false
		const cancel = () => {
			cancelled = true
			if (this.debounceTimer) clearTimeout(this.debounceTimer)
			this.debounceTimer = null
			this.cancelDebounce = null
			this.removePendingRequest(pendingRequest)
			resolve()
		}
		this.cancelDebounce = cancel
		const run = async () => {
			this.debounceTimer = null
			// Keep at most one network request active, plus one replaceable trailing request.
			if (this.activeFetch) await this.activeFetch
			if (cancelled) return
			this.cancelDebounce = null
			if (!leading) this.isFirstCall = true
			if (generation !== this.configurationGeneration || !pendingRequest.waiters.some((current) => current()))
				return
			const fetch = this.fetchAndCacheSuggestion(prompt, prefix, suffix, languageId, scope)
			this.activeFetch = fetch
			try {
				await fetch
			} finally {
				if (this.activeFetch === fetch) this.activeFetch = null
			}
		}
		const start = () => {
			void run()
				.then(resolve, reject)
				.finally(() => this.removePendingRequest(pendingRequest))
		}
		if (leading) start()
		else this.debounceTimer = setTimeout(start, this.debounceDelayMs)
		return pendingRequest.promise
	}

	public async fetchAndCacheSuggestion(
		prompt: AutocompletePrompt,
		prefix: string,
		suffix: string,
		languageId: string,
		scope?: string,
	): Promise<void> {
		const startTime = performance.now()
		const generation = this.configurationGeneration

		// Build telemetry context for this request
		const telemetryContext: AutocompleteContext = {
			languageId,
			modelId: this.model?.getModelName(),
			provider: this.model?.getProviderDisplayName(),
			strategy: prompt.strategy,
		}

		// Defense-in-depth: credentials may become invalid between the provider gate and the actual
		// debounced execution (e.g., profile reload calling AutocompleteModel.cleanup()).
		// In that case, do not attempt an LLM call at all.
		if (!this.model || !this.model.hasValidCredentials()) {
			return
		}

		try {
			// Curry processSuggestion with prefix, suffix, model, telemetry context, and languageId
			const curriedProcessSuggestion = (text: string) =>
				this.processSuggestion(text, prefix, suffix, this.model, telemetryContext, languageId)

			this.trace(`Request started: strategy=${prompt.strategy}`)
			const result =
				prompt.strategy === "fim"
					? await this.fimPromptBuilder.getFromFIM(this.model, prompt, curriedProcessSuggestion)
					: await this.holeFiller.getFromChat(this.model, prompt, curriedProcessSuggestion, (message) =>
							this.trace(message),
						)

			const latencyMs = performance.now() - startTime
			this.trace(
				`Request finished: ${Math.round(latencyMs)}ms, suggestion=${result.suggestion.text.length} characters, output=${result.outputTokens} tokens`,
			)

			this.telemetry?.captureLlmRequestCompleted(
				{
					latencyMs,
					cost: result.cost,
					inputTokens: result.inputTokens,
					outputTokens: result.outputTokens,
				},
				telemetryContext,
			)

			// Record latency for adaptive debounce delay
			this.recordLatency(latencyMs)

			this.costTrackingCallback(result.cost, result.inputTokens, result.outputTokens)

			// Always update suggestions, even if text is empty (for caching)
			if (generation === this.configurationGeneration) {
				if (scope !== undefined) this.suggestionScopes.set(result.suggestion, scope)
				this.updateSuggestions(result.suggestion)
			}
		} catch (error) {
			this.trace("Request failed; no suggestion returned")
			const latencyMs = performance.now() - startTime
			this.telemetry?.captureLlmRequestFailed(
				{
					latencyMs,
					error: error instanceof Error ? error.message : String(error),
				},
				telemetryContext,
			)
			console.error("Error getting inline completion from LLM:", error)
		}
	}
}
