import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as vscode from "vscode"
import { AutocompleteServiceManager } from "../AutocompleteServiceManager"

vi.mock("vscode", () => {
	class Position {
		constructor(
			public line: number,
			public character: number,
		) {}
	}

	class Range {
		constructor(
			public start: any,
			public end: any,
		) {}
	}

	class CancellationTokenSource {
		public token = {
			isCancellationRequested: false,
			onCancellationRequested: vi.fn(),
		}

		dispose = vi.fn()
	}

	return {
		Uri: {
			parse: (uriString: string) => ({
				toString: () => uriString,
				fsPath: uriString.replace("file://", ""),
				scheme: "file",
				path: uriString.replace("file://", ""),
			}),
		},
		Position,
		Range,
		CancellationTokenSource,
		InlineCompletionTriggerKind: {
			Invoke: 1,
		},
		workspace: {
			openTextDocument: vi.fn(),
			applyEdit: vi.fn(),
			asRelativePath: vi.fn().mockImplementation((uri) => {
				if (typeof uri === "string") return uri.replace("file:///", "")
				return uri.toString().replace("file:///", "")
			}),
		},
		window: {
			activeTextEditor: null as any,
		},
		languages: {
			registerInlineCompletionItemProvider: vi.fn(),
		},
		commands: {
			executeCommand: vi.fn(),
		},
	}
})

vi.mock("../AutocompleteModel", () => {
	class AutocompleteModel {
		public loaded = false
		public profileName = "test-profile"

		public invalidate(): void {
			this.loaded = false
		}

		public async reload(): Promise<void> {
			this.loaded = true
		}

		public getModelName(): string {
			return "test-model"
		}

		public getProviderDisplayName(): string {
			return "Ollama"
		}

		public getProviderKey(): string {
			return "ollama"
		}

		public hasValidCredentials(): boolean {
			return true
		}
	}

	return { AutocompleteModel }
})

vi.mock("../AutocompleteStatusBar", () => {
	class AutocompleteStatusBar {
		public update = vi.fn()
		public dispose = vi.fn()
		constructor(_args: any) {}
	}
	return { AutocompleteStatusBar }
})

vi.mock("../AutocompleteCodeActionProvider", () => {
	class AutocompleteCodeActionProvider {}
	return { AutocompleteCodeActionProvider }
})

vi.mock("../classic-auto-complete/AutocompleteInlineCompletionProvider", () => {
	class AutocompleteInlineCompletionProvider {
		public resetModelCache = vi.fn()
		public provideInlineCompletionItems_Internal = vi.fn()
		public dispose = vi.fn()

		constructor(..._args: any[]) {}
	}
	return { AutocompleteInlineCompletionProvider }
})

vi.mock("../classic-auto-complete/AutocompleteTelemetry", () => {
	class AutocompleteTelemetry {}
	return { AutocompleteTelemetry }
})

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vi.fn(),
		},
	},
}))

vi.mock("../../../core/config/ContextProxy", () => {
	const state: Record<string, any> = {}

	const api = {
		getGlobalState: (key: string) => state[key],
		setValues: async (values: Record<string, any>) => {
			Object.assign(state, values)
		},
	}

	class ContextProxy {
		static instance = api
	}

	const __resetState = () => {
		for (const key of Object.keys(state)) delete state[key]
	}

	const __setState = (values: Record<string, any>) => {
		Object.assign(state, values)
	}

	return { ContextProxy, __resetState, __setState }
})

type TestCline = {
	providerSettingsManager: { initialize: () => Promise<void> }
	postStateToWebview: () => Promise<void>
}

async function createManager(): Promise<AutocompleteServiceManager> {
	const { __setState } = (await import("../../../core/config/ContextProxy")) as any

	__setState({
		ghostServiceSettings: {
			enableAutoTrigger: false,
			enableSmartInlineTaskKeybinding: true,
		},
	})

	const context = { subscriptions: [] } as unknown as vscode.ExtensionContext
	const cline: TestCline = {
		providerSettingsManager: { initialize: vi.fn().mockResolvedValue(undefined) },
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
	}

	const manager = new AutocompleteServiceManager(context, cline as any)

	await manager.load()

	return manager
}

describe("AutocompleteServiceManager (less mocked logic)", () => {
	beforeEach(async () => {
		vi.clearAllMocks()

		const { __resetState } = (await import("../../../core/config/ContextProxy")) as any
		__resetState()
		;(vscode.window as any).activeTextEditor = null
		vi.mocked(vscode.languages.registerInlineCompletionItemProvider).mockReset()

		// Reset singleton instance before each test
		AutocompleteServiceManager._resetInstance()
	})

	afterEach(() => {
		;(vscode.window as any).activeTextEditor = null
	})

	it("preserves pending completions when the same provider profile is activated again", async () => {
		const manager = await createManager()
		const { __setState } = (await import("../../../core/config/ContextProxy")) as any
		const profile = { id: "proxy", name: "Proxy", apiProvider: "openai", openAiModelId: "chat" }
		const getProfile = vi.fn().mockImplementation(async () => ({ ...profile }))
		;(manager as any).cline.providerSettingsManager.getProfile = getProfile
		__setState({ currentApiConfigName: "Proxy", ghostServiceSettings: { useCurrentProvider: true } })
		await manager.load()
		vi.mocked(manager.inlineCompletionProvider.resetModelCache).mockClear()
		const reload = vi.spyOn((manager as any).model, "reload")

		await manager.loadIfProfileChanged()
		expect(manager.inlineCompletionProvider.resetModelCache).not.toHaveBeenCalled()
		expect(reload).not.toHaveBeenCalled()

		getProfile.mockResolvedValue({ ...profile, openAiBaseUrl: "https://changed.invalid" })
		await manager.loadIfProfileChanged()
		expect(manager.inlineCompletionProvider.resetModelCache).toHaveBeenCalledTimes(1)
		expect(reload).toHaveBeenCalledTimes(1)
	})

	it("ignores chat profile activation for a dedicated autocomplete model but keeps explicit reload", async () => {
		const manager = await createManager()
		vi.mocked(manager.inlineCompletionProvider.resetModelCache).mockClear()
		await manager.loadIfProfileChanged()
		expect(manager.inlineCompletionProvider.resetModelCache).not.toHaveBeenCalled()
		await manager.load()
		expect(manager.inlineCompletionProvider.resetModelCache).toHaveBeenCalledTimes(1)
	})

	it("reloads when the active profile is removed", async () => {
		const manager = await createManager()
		const { __setState } = (await import("../../../core/config/ContextProxy")) as any
		;(manager as any).cline.providerSettingsManager.getProfile = vi.fn().mockResolvedValue({ id: "proxy" })
		__setState({ currentApiConfigName: "Proxy", ghostServiceSettings: { useCurrentProvider: true } })
		await manager.load()
		vi.mocked(manager.inlineCompletionProvider.resetModelCache).mockClear()
		__setState({ currentApiConfigName: undefined })
		await manager.loadIfProfileChanged()
		expect(manager.inlineCompletionProvider.resetModelCache).toHaveBeenCalledTimes(1)
	})

	it("does not overwrite settings saved while model reload is publishing its status", async () => {
		const manager = await createManager()
		const { ContextProxy, __setState } = (await import("../../../core/config/ContextProxy")) as any
		const saved = {
			useCurrentProvider: true,
			enableChatAutocomplete: true,
			currentProviderModels: { proxy: { provider: "openai", modelId: "luna" } },
		}
		vi.mocked(vscode.commands.executeCommand).mockImplementationOnce(async () => {
			__setState({ ghostServiceSettings: saved })
		})
		await manager.load()
		expect(ContextProxy.instance.getGlobalState("ghostServiceSettings")).toEqual(saved)
	})

	describe("personal defaults", () => {
		it.each([{}, { enableAutoTrigger: true, enableChatAutocomplete: true }])(
			"defaults missing flags to false and preserves explicit opt-in: %j",
			async (saved) => {
				const manager = await createManager()
				const { ContextProxy, __setState } = (await import("../../../core/config/ContextProxy")) as any
				__setState({ ghostServiceSettings: saved })
				await manager.load()
				expect(ContextProxy.instance.getGlobalState("ghostServiceSettings")).toMatchObject({
					enableAutoTrigger: saved.enableAutoTrigger ?? false,
					enableChatAutocomplete: saved.enableChatAutocomplete ?? false,
				})
			},
		)

		it("keeps editor and chat autocomplete disabled until explicit opt-in", async () => {
			const context = { subscriptions: [] } as unknown as vscode.ExtensionContext
			const cline: TestCline = {
				providerSettingsManager: { initialize: vi.fn().mockResolvedValue(undefined) },
				postStateToWebview: vi.fn().mockResolvedValue(undefined),
			}

			new AutocompleteServiceManager(context, cline as any)

			await vi.waitFor(() => expect(cline.postStateToWebview).toHaveBeenCalled())
			const { ContextProxy } = (await import("../../../core/config/ContextProxy")) as any
			const settings = ContextProxy.instance.getGlobalState("ghostServiceSettings")

			expect(settings).toMatchObject({
				enableAutoTrigger: false,
				enableChatAutocomplete: false,
				provider: "ollama",
				model: "test-model",
			})
			expect(vscode.languages.registerInlineCompletionItemProvider).not.toHaveBeenCalled()
		})
	})

	describe("codeSuggestion()", () => {
		it("calls the provider and inserts the first completion into the editor", async () => {
			const manager = await createManager()

			const document = { uri: vscode.Uri.parse("file:///test.ts") }
			const position = new vscode.Position(0, 0)
			const inserted: { position?: any; text?: string } = {}

			;(vscode.window as any).activeTextEditor = {
				document,
				selection: { active: position },
				edit: vi.fn().mockImplementation(async (cb: any) => {
					const editBuilder = {
						insert: vi.fn((pos: any, text: string) => {
							inserted.position = pos
							inserted.text = text
						}),
					}
					cb(editBuilder)
					return true
				}),
			}

			const provider = manager.inlineCompletionProvider as any
			provider.provideInlineCompletionItems_Internal.mockResolvedValueOnce([
				{
					insertText: "// suggestion",
					range: new vscode.Range(position, position),
				},
			])

			await manager.codeSuggestion()

			expect(provider.provideInlineCompletionItems_Internal).toHaveBeenCalledWith(
				document,
				position,
				expect.objectContaining({
					triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
				}),
				expect.any(Object),
			)

			expect(inserted.position).toBe(position)
			expect(inserted.text).toBe("// suggestion")
		})

		it("does nothing when there is no active editor", async () => {
			const manager = await createManager()

			;(vscode.window as any).activeTextEditor = null

			await manager.codeSuggestion()

			const provider = manager.inlineCompletionProvider as any
			expect(provider.provideInlineCompletionItems_Internal).not.toHaveBeenCalled()
		})
	})

	describe("updateInlineCompletionProviderRegistration()", () => {
		it("registers the provider when enableAutoTrigger is true and not snoozed", async () => {
			const manager = await createManager()

			const disposable = { dispose: vi.fn() }
			vi.mocked(vscode.languages.registerInlineCompletionItemProvider).mockReturnValue(disposable as any)
			;(manager as any).settings = {
				enableAutoTrigger: true,
				enableSmartInlineTaskKeybinding: true,
			}

			await (manager as any).updateInlineCompletionProviderRegistration()

			expect(vscode.languages.registerInlineCompletionItemProvider).toHaveBeenCalledWith(
				{ scheme: "file" },
				manager.inlineCompletionProvider,
			)
			expect((manager as any).inlineCompletionProviderDisposable).toBe(disposable)
		})

		it("does not register the provider when snoozed", async () => {
			const manager = await createManager()

			vi.mocked(vscode.languages.registerInlineCompletionItemProvider).mockReturnValue({
				dispose: vi.fn(),
			} as any)
			;(manager as any).settings = {
				enableAutoTrigger: true,
				snoozeUntil: Date.now() + 60_000,
				enableSmartInlineTaskKeybinding: true,
			}

			await (manager as any).updateInlineCompletionProviderRegistration()

			expect(vscode.languages.registerInlineCompletionItemProvider).not.toHaveBeenCalled()
			expect((manager as any).inlineCompletionProviderDisposable).toBeNull()
		})

		it("disposes an existing registration before applying the new registration decision", async () => {
			const manager = await createManager()

			const existingDisposable = { dispose: vi.fn() }
			;(manager as any).inlineCompletionProviderDisposable = existingDisposable
			;(manager as any).settings = {
				enableAutoTrigger: false,
				enableSmartInlineTaskKeybinding: true,
			}

			await (manager as any).updateInlineCompletionProviderRegistration()

			expect(existingDisposable.dispose).toHaveBeenCalledTimes(1)
			expect((manager as any).inlineCompletionProviderDisposable).toBeNull()
		})
	})

	describe("snooze state helpers", () => {
		it("isSnoozed() returns false when snoozeUntil is not set", async () => {
			const manager = await createManager()
			;(manager as any).settings = { enableAutoTrigger: true }

			expect(manager.isSnoozed()).toBe(false)
		})

		it("isSnoozed() returns false when snoozeUntil is in the past", async () => {
			const manager = await createManager()
			;(manager as any).settings = { snoozeUntil: Date.now() - 1000 }

			expect(manager.isSnoozed()).toBe(false)
		})

		it("isSnoozed() returns true when snoozeUntil is in the future", async () => {
			const manager = await createManager()
			;(manager as any).settings = { snoozeUntil: Date.now() + 60_000 }

			expect(manager.isSnoozed()).toBe(true)
		})

		it("getSnoozeRemainingSeconds() returns 0 when not snoozed", async () => {
			const manager = await createManager()
			;(manager as any).settings = {}

			expect(manager.getSnoozeRemainingSeconds()).toBe(0)
		})

		it("getSnoozeRemainingSeconds() returns a positive number when snoozed", async () => {
			const manager = await createManager()
			;(manager as any).settings = { snoozeUntil: Date.now() + 30_000 }

			const remaining = manager.getSnoozeRemainingSeconds()
			expect(remaining).toBeGreaterThan(0)
			expect(remaining).toBeLessThanOrEqual(30)
		})
	})
})
