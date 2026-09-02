// npx vitest run __tests__/extension.spec.ts

import type * as vscode from "vscode"

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
		}),
		registerWebviewViewProvider: vi.fn(),
		registerUriHandler: vi.fn(),
		tabGroups: {
			onDidChangeTabs: vi.fn(),
		},
		onDidChangeActiveTextEditor: vi.fn(),
		onDidChangeTextEditorSelection: vi.fn().mockReturnValue({
			dispose: vi.fn(),
		}),
		createTextEditorDecorationType: vi.fn().mockReturnValue({
			dispose: vi.fn(),
		}),
		onDidOpenTerminal: vi.fn().mockReturnValue({
			dispose: vi.fn(),
		}),
		terminals: [],
		activeTextEditor: null,
	},
	workspace: {
		registerTextDocumentContentProvider: vi.fn(),
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
		}),
		createFileSystemWatcher: vi.fn().mockReturnValue({
			onDidCreate: vi.fn(),
			onDidChange: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		}),
		onDidChangeWorkspaceFolders: vi.fn(),
		onDidChangeConfiguration: vi.fn().mockReturnValue({
			dispose: vi.fn(),
		}),
		onDidChangeTextDocument: vi.fn().mockReturnValue({
			dispose: vi.fn(),
		}),
		onDidOpenTextDocument: vi.fn().mockReturnValue({
			dispose: vi.fn(),
		}),
		onDidCloseTextDocument: vi.fn().mockReturnValue({
			dispose: vi.fn(),
		}),
	},
	languages: {
		registerCodeActionsProvider: vi.fn(),
	},
	commands: {
		executeCommand: vi.fn(),
		registerCommand: vi.fn().mockReturnValue({
			dispose: vi.fn(),
		}),
	},
	env: {
		language: "en",
		appName: "Visual Studio Code",
	},
	ExtensionMode: {
		Production: 1,
	},
	ThemeColor: vi.fn((color: any) => ({ id: color })),
	OverviewRulerLane: {
		Right: 1,
	},
	Range: vi.fn().mockImplementation((start, end) => ({
		start,
		end,
		isEmpty: vi.fn().mockReturnValue(false),
		isSingleLine: vi.fn().mockReturnValue(true),
	})),
	Uri: {
		joinPath: vi.fn().mockImplementation((...paths) => ({
			toString: () => paths.join("/"),
			path: paths.join("/"),
		})),
		parse: vi.fn().mockImplementation((uri) => ({
			toString: () => uri,
			path: uri,
		})),
		file: vi.fn().mockImplementation((path) => ({
			toString: () => `file://${path}`,
			path,
		})),
	},
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
	},
	EventEmitter: vi.fn().mockImplementation(() => ({
		event: vi.fn(),
		fire: vi.fn(),
		dispose: vi.fn(),
	})),
}))

vi.mock("@dotenvx/dotenvx", () => ({
	config: vi.fn(),
}))

const mockBridgeOrchestratorDisconnect = vi.fn().mockResolvedValue(undefined)

const mockCloudServiceInstance = {
	off: vi.fn(),
	on: vi.fn(),
	getUserInfo: vi.fn().mockReturnValue(null),
	isTaskSyncEnabled: vi.fn().mockReturnValue(false),
	authService: {
		getSessionToken: vi.fn().mockReturnValue("test-session-token"),
	},
}

vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		createInstance: vi.fn(),
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return mockCloudServiceInstance
		},
	},
	BridgeOrchestrator: {
		disconnect: mockBridgeOrchestratorDisconnect,
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://app.roocode.com"),
}))

const mockTelemetryService = {
	register: vi.fn(),
	updateTelemetryState: vi.fn(),
	setProvider: vi.fn(),
	shutdown: vi.fn(),
}

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		createInstance: vi.fn().mockReturnValue(mockTelemetryService),
		get instance() {
			return mockTelemetryService
		},
	},
	PostHogTelemetryClient: vi.fn(),
}))

vi.mock("../utils/outputChannelLogger", () => ({
	createOutputChannelLogger: vi.fn().mockReturnValue(vi.fn()),
	createDualLogger: vi.fn().mockReturnValue(vi.fn()),
}))

vi.mock("../shared/package", () => ({
	Package: {
		name: "test-extension",
		outputChannel: "Test Output",
		version: "1.0.0",
	},
}))

vi.mock("../shared/language", () => ({
	formatLanguage: vi.fn().mockReturnValue("en"),
}))

vi.mock("../core/config/ContextProxy", () => ({
	ContextProxy: {
		getInstance: vi.fn().mockResolvedValue({
			getValue: vi.fn(),
			setValue: vi.fn(),
			getValues: vi.fn().mockReturnValue({
				ghostServiceSettings: {
					enabled: true,
				},
			}),
			getProviderSettings: vi.fn().mockReturnValue({}),
		}),
		get instance() {
			return {
				getValue: vi.fn(),
				setValue: vi.fn(),
				getValues: vi.fn().mockReturnValue({
					ghostServiceSettings: {
						enabled: true,
					},
				}),
				getProviderSettings: vi.fn().mockReturnValue({}),
			}
		},
	},
}))

vi.mock("../integrations/editor/DiffViewProvider", () => ({
	DIFF_VIEW_URI_SCHEME: "test-diff-scheme",
}))

vi.mock("../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		initialize: vi.fn(),
		cleanup: vi.fn(),
	},
}))

vi.mock("../services/mcp/McpServerManager", () => ({
	McpServerManager: {
		cleanup: vi.fn().mockResolvedValue(undefined),
		getInstance: vi.fn().mockResolvedValue(null),
		unregisterProvider: vi.fn(),
	},
}))

vi.mock("../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: vi.fn().mockReturnValue(null),
	},
}))

vi.mock("../services/mdm/MdmService", () => ({
	MdmService: {
		createInstance: vi.fn().mockResolvedValue(null),
	},
}))

vi.mock("../utils/migrateSettings", () => ({
	migrateSettings: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../utils/autoImportSettings", () => ({
	autoImportSettings: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../extension/api", () => ({
	API: vi.fn().mockImplementation(() => ({})),
}))

vi.mock("../activate", () => ({
	handleUri: vi.fn(),
	registerCommands: vi.fn(),
	registerCodeActions: vi.fn(),
	registerTerminalActions: vi.fn(),
	CodeActionProvider: vi.fn().mockImplementation(() => ({
		providedCodeActionKinds: [],
	})),
}))

vi.mock("../i18n", () => ({
	initializeI18n: vi.fn(),
	t: vi.fn().mockImplementation((key, options = {}) => {
		return `mocked-translation-${key}`
	}),
}))

vi.mock("../services/autocomplete/AutocompleteServiceManager", () => ({
	AutocompleteServiceManager: {
		initialize: vi.fn().mockReturnValue({
			load: vi.fn(),
		}),
		getInstance: vi.fn().mockReturnValue(null),
		instance: null,
	},
}))

vi.mock("../services/autocomplete", () => ({
	registerAutocompleteProvider: vi.fn(),
}))

vi.mock("../services/commit-message", () => ({
	registerCommitMessageProvider: vi.fn(),
}))

vi.mock("../services/terminal-welcome", () => ({
	registerWelcomeService: vi.fn(),
}))

vi.mock("../services/terminal-welcome/TerminalWelcomeService", () => ({
	TerminalWelcomeService: {
		register: vi.fn(),
	},
}))

const mockInitializeCloudProfileSyncWhenReady = vi.fn().mockResolvedValue(undefined)
const mockInitializePersonalProviderProfile = vi.fn().mockResolvedValue(undefined)

vi.mock("../core/webview/ClineProvider", async () => {
	const { BridgeOrchestrator } = await import("@roo-code/cloud")
	const mockInstance = {
		resolveWebviewView: vi.fn(),
		postMessageToWebview: vi.fn(),
		postStateToWebview: vi.fn(),
		getState: vi.fn().mockResolvedValue({}),
		remoteControlEnabled: vi.fn().mockImplementation(async (enabled: boolean) => {
			if (!enabled) {
				await BridgeOrchestrator.disconnect()
			}
		}),
		initializeCloudProfileSyncWhenReady: mockInitializeCloudProfileSyncWhenReady,
		initializePersonalProviderProfile: mockInitializePersonalProviderProfile,
		providerSettingsManager: {},
		contextProxy: { getGlobalState: vi.fn() },
		customModesManager: {},
		upsertProviderProfile: vi.fn().mockResolvedValue(undefined),
	}
	return {
		ClineProvider: Object.assign(
			vi.fn().mockImplementation(() => mockInstance),
			{
				// Static method used by extension.ts
				getVisibleInstance: vi.fn().mockReturnValue(mockInstance),
				sideBarId: "roo-cline-sidebar",
			},
		),
	}
})

// Mock modelCache to prevent network requests during module loading
const mockRefreshModels = vi.fn().mockResolvedValue({})
vi.mock("../api/providers/fetchers/modelCache", () => ({
	flushModels: vi.fn(),
	getModels: vi.fn().mockResolvedValue([]),
	initializeModelCacheRefresh: vi.fn(),
	refreshModels: mockRefreshModels,
}))

describe("extension.ts", () => {
	let mockContext: vscode.ExtensionContext

	beforeEach(() => {
		vi.clearAllMocks()
		mockBridgeOrchestratorDisconnect.mockClear()

		mockContext = {
			extensionPath: "/test/path",
			globalState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn(),
			},
			subscriptions: [],
		} as unknown as vscode.ExtensionContext
	})

	test("activates without cloud startup and keeps telemetry disabled", async () => {
		const { CloudService } = await import("@roo-code/cloud")
		const { TelemetryService, PostHogTelemetryClient } = await import("@roo-code/telemetry")
		const { activate } = await import("../extension")

		await activate(mockContext)

		expect(CloudService.createInstance).not.toHaveBeenCalled()
		expect(mockInitializeCloudProfileSyncWhenReady).not.toHaveBeenCalled()
		expect(mockInitializePersonalProviderProfile).toHaveBeenCalledTimes(1)
		expect(TelemetryService.createInstance).toHaveBeenCalledTimes(1)
		expect(mockTelemetryService.updateTelemetryState).toHaveBeenCalledWith(false)
		expect(mockTelemetryService.register).not.toHaveBeenCalled()
		expect(PostHogTelemetryClient).not.toHaveBeenCalled()
	})
})
