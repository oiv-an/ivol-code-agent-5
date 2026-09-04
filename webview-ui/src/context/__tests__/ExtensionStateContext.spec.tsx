import { render, screen, act } from "@/utils/test-utils"

import {
	type ProviderSettings,
	type ExperimentId,
	type ClineMessage,
	type ExtensionMessage,
	type ExtensionState,
	openRouterDefaultModelId, // kilocode_change
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
} from "@roo-code/types"

import {
	ExtensionStateContextProvider,
	useExtensionState,
	mergeExtensionState,
	applyIncrementalTaskMessage,
} from "../ExtensionStateContext"

const TestComponent = () => {
	const {
		allowedCommands,
		setAllowedCommands,
		soundEnabled,
		showRooIgnoredFiles,
		setShowRooIgnoredFiles,
		autoApprovalEnabled,
		alwaysAllowReadOnly,
		alwaysAllowWrite,
	} = useExtensionState()
	return (
		<div>
			<div data-testid="allowed-commands">{JSON.stringify(allowedCommands)}</div>
			<div data-testid="sound-enabled">{JSON.stringify(soundEnabled)}</div>
			<div data-testid="show-rooignored-files">{JSON.stringify(showRooIgnoredFiles)}</div>
			<div data-testid="auto-approval-enabled">{JSON.stringify(autoApprovalEnabled)}</div>
			<div data-testid="always-allow-read-only">{JSON.stringify(alwaysAllowReadOnly)}</div>
			<div data-testid="always-allow-write">{JSON.stringify(alwaysAllowWrite)}</div>
			<button data-testid="update-button" onClick={() => setAllowedCommands(["npm install", "git status"])}>
				Update Commands
			</button>
			<button data-testid="toggle-rooignore-button" onClick={() => setShowRooIgnoredFiles(!showRooIgnoredFiles)}>
				Update Commands
			</button>
		</div>
	)
}

const ApiConfigTestComponent = () => {
	const { apiConfiguration, setApiConfiguration } = useExtensionState()

	return (
		<div>
			<div data-testid="api-configuration">{JSON.stringify(apiConfiguration)}</div>
			<button
				data-testid="update-api-config-button"
				onClick={() => setApiConfiguration({ apiModelId: "new-model", apiProvider: "anthropic" })}>
				Update API Config
			</button>
			<button data-testid="partial-update-button" onClick={() => setApiConfiguration({ modelTemperature: 0.7 })}>
				Partial Update
			</button>
		</div>
	)
}

describe("ExtensionStateContext", () => {
	it("initializes with empty allowedCommands array", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("allowed-commands").textContent!)).toEqual([])
	})

	it("initializes with soundEnabled set to false", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("sound-enabled").textContent!)).toBe(false)
	})

	it("initializes with showRooIgnoredFiles set to true", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("show-rooignored-files").textContent!)).toBe(true)
	})

	it("initializes with autoApprovalEnabled set to true", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("auto-approval-enabled").textContent!)).toBe(true)
	})

	it("initializes with alwaysAllowReadOnly set to true", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("always-allow-read-only").textContent!)).toBe(true)
	})

	it("initializes with alwaysAllowWrite set to true", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		expect(JSON.parse(screen.getByTestId("always-allow-write").textContent!)).toBe(true)
	})

	it("updates showRooIgnoredFiles through setShowRooIgnoredFiles", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			screen.getByTestId("toggle-rooignore-button").click()
		})

		expect(JSON.parse(screen.getByTestId("show-rooignored-files").textContent!)).toBe(false)
	})

	it("updates allowedCommands through setAllowedCommands", () => {
		render(
			<ExtensionStateContextProvider>
				<TestComponent />
			</ExtensionStateContextProvider>,
		)

		act(() => {
			screen.getByTestId("update-button").click()
		})

		expect(JSON.parse(screen.getByTestId("allowed-commands").textContent!)).toEqual(["npm install", "git status"])
	})

	it("throws error when used outside provider", () => {
		// Suppress console.error for this test since we expect an error
		const consoleSpy = vi.spyOn(console, "error")
		consoleSpy.mockImplementation(() => {})

		expect(() => {
			render(<TestComponent />)
		}).toThrow("useExtensionState must be used within an ExtensionStateContextProvider")

		consoleSpy.mockRestore()
	})

	it("updates apiConfiguration through setApiConfiguration", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiConfigTestComponent />
			</ExtensionStateContextProvider>,
		)

		const initialContent = screen.getByTestId("api-configuration").textContent!
		expect(initialContent).toBeDefined()

		act(() => {
			screen.getByTestId("update-api-config-button").click()
		})

		const updatedContent = screen.getByTestId("api-configuration").textContent!
		const updatedConfig = JSON.parse(updatedContent || "{}")

		expect(updatedConfig).toEqual(
			expect.objectContaining({
				apiModelId: "new-model",
				apiProvider: "anthropic",
			}),
		)
	})

	it("correctly merges partial updates to apiConfiguration", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiConfigTestComponent />
			</ExtensionStateContextProvider>,
		)

		// First set the initial configuration
		act(() => {
			screen.getByTestId("update-api-config-button").click()
		})

		// Verify initial update
		const initialContent = screen.getByTestId("api-configuration").textContent!
		const initialConfig = JSON.parse(initialContent || "{}")
		expect(initialConfig).toEqual(
			expect.objectContaining({
				apiModelId: "new-model",
				apiProvider: "anthropic",
			}),
		)

		// Now perform a partial update
		act(() => {
			screen.getByTestId("partial-update-button").click()
		})

		// Verify that the partial update was merged with the existing configuration
		const updatedContent = screen.getByTestId("api-configuration").textContent!
		const updatedConfig = JSON.parse(updatedContent || "{}")
		expect(updatedConfig).toEqual(
			expect.objectContaining({
				apiModelId: "new-model", // Should retain this from previous update
				apiProvider: "anthropic", // Should retain this from previous update
				modelTemperature: 0.7, // Should add this from partial update
			}),
		)
	})
})

// kilocode_change start: long conversations are updated incrementally
describe("applyIncrementalTaskMessage", () => {
	const createState = (messages: ExtensionState["clineMessages"] = []): ExtensionState =>
		({ currentTaskId: "task-a", clineMessages: messages }) as ExtensionState

	it("appends a newly created message for the active task", () => {
		const state = createState()
		const message = {
			type: "messageCreated",
			taskId: "task-a",
			clineMessage: { ts: 1, type: "say", say: "text", text: "hello" },
		} satisfies ExtensionMessage

		expect(applyIncrementalTaskMessage(state, message).clineMessages).toEqual([message.clineMessage])
	})

	it("deduplicates a created message already present in a full state", () => {
		const state = createState([{ ts: 1, type: "say", say: "text", text: "old" }])
		const message = {
			type: "messageCreated",
			taskId: "task-a",
			clineMessage: { ts: 1, type: "say", say: "text", text: "new" },
		} satisfies ExtensionMessage

		const result = applyIncrementalTaskMessage(state, message)
		expect(result.clineMessages).toHaveLength(1)
		expect(result.clineMessages[0].text).toBe("new")
	})

	it("ignores a delayed message from a different task", () => {
		const state = createState([{ ts: 1, type: "say", say: "text", text: "active" }])
		const message = {
			type: "messageCreated",
			taskId: "task-b",
			clineMessage: { ts: 2, type: "say", say: "text", text: "stale" },
		} satisfies ExtensionMessage

		expect(applyIncrementalTaskMessage(state, message)).toBe(state)
	})

	it("inserts a delayed message for the active task by timestamp", () => {
		const apiMessage = {
			ts: 2,
			type: "say",
			say: "api_req_started",
			text: '{"apiProtocol":"openai"}',
		} satisfies ClineMessage
		const state = createState([apiMessage])
		const taskMessage = { ts: 1, type: "say", say: "text", text: "Entered task text" } satisfies ClineMessage

		const result = applyIncrementalTaskMessage(state, {
			type: "messageCreated",
			taskId: "task-a",
			clineMessage: taskMessage,
		})

		expect(result.clineMessages).toEqual([taskMessage, apiMessage])
	})

	it("updates task totals without replacing the message array", () => {
		const state = createState([{ ts: 1, type: "say", say: "text", text: "active" }])
		const result = applyIncrementalTaskMessage(state, {
			type: "currentTaskStateUpdated",
			taskId: "task-a",
			taskState: { currentTaskCumulativeCost: 12.5, messageQueue: [] },
		})

		expect(result.clineMessages).toBe(state.clineMessages)
		expect(result.currentTaskCumulativeCost).toBe(12.5)
	})
})
// kilocode_change end

describe("mergeExtensionState", () => {
	it("should correctly merge extension states", () => {
		const baseState: ExtensionState = {
			version: "",
			mcpEnabled: false,
			enableMcpServerCreation: false,
			clineMessages: [],
			taskHistoryFullLength: 0, // kilocode_change
			taskHistoryVersion: 0, // kilocode_change
			shouldShowAnnouncement: false,
			enableCheckpoints: true,
			writeDelayMs: 1000,
			mode: "default",
			experiments: {} as Record<ExperimentId, boolean>,
			customModes: [],
			maxOpenTabsContext: 20,
			maxWorkspaceFiles: 100,
			apiConfiguration: { providerId: "openrouter" } as ProviderSettings,
			telemetrySetting: "unset",
			showRooIgnoredFiles: true,
			enableSubfolderRules: false,
			renderContext: "sidebar",
			maxReadFileLine: 500,
			showAutoApproveMenu: false,
			cloudUserInfo: null,
			organizationAllowList: { allowAll: true, providers: {} },
			autoCondenseContext: true,
			autoCondenseContextPercent: 90,
			cloudIsAuthenticated: false,
			sharingEnabled: false,
			publicSharingEnabled: false,
			profileThresholds: {},
			hasOpenedModeSelector: false, // Add the new required property
			maxImageFileSize: 5,
			maxTotalImageSize: 20,
			kilocodeDefaultModel: openRouterDefaultModelId,
			remoteControlEnabled: false,
			taskSyncEnabled: false,
			featureRoomoteControlEnabled: false,
			isBrowserSessionActive: false,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS, // Add the checkpoint timeout property
		}

		const prevState: ExtensionState = {
			...baseState,
			apiConfiguration: { modelMaxTokens: 1234, modelMaxThinkingTokens: 123 },
			experiments: {} as Record<ExperimentId, boolean>,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS - 5,
		}

		const newState: ExtensionState = {
			...baseState,
			apiConfiguration: { modelMaxThinkingTokens: 456, modelTemperature: 0.3 },
			experiments: {
				powerSteering: true,
				multiFileApplyDiff: true,
				preventFocusDisruption: false,
				morphFastApply: false, // kilocode_change
				speechToText: false, // kilocode_change
				newTaskRequireTodos: false,
				imageGeneration: false,
				runSlashCommand: false,
				nativeToolCalling: false,
				multipleNativeToolCalls: false,
				customTools: false,
			} as Record<ExperimentId, boolean>,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS + 5,
		}

		const result = mergeExtensionState(prevState, newState)

		expect(result.apiConfiguration).toEqual({
			modelMaxThinkingTokens: 456,
			modelTemperature: 0.3,
		})

		expect(result.experiments).toEqual({
			powerSteering: true,
			multiFileApplyDiff: true,
			preventFocusDisruption: false,
			morphFastApply: false, // kilocode_change
			speechToText: false, // kilocode_change
			newTaskRequireTodos: false,
			imageGeneration: false,
			runSlashCommand: false,
			nativeToolCalling: false,
			multipleNativeToolCalls: false,
			customTools: false,
		})
	})
})
