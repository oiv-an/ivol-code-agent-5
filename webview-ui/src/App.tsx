import React, { useCallback, useEffect, useRef, useState, useMemo } from "react"
import { useEvent } from "react-use"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { type ExtensionMessage, TelemetryEventName } from "@roo-code/types"

import TranslationProvider from "./i18n/TranslationContext"
import { MarketplaceViewStateManager } from "./components/marketplace/MarketplaceViewStateManager"

import { vscode } from "./utils/vscode"
import { telemetryClient } from "./utils/TelemetryClient"
import { initializeSourceMaps, exposeSourceMapsForDebugging } from "./utils/sourceMapInitializer"
import { ExtensionStateContextProvider, useExtensionState } from "./context/ExtensionStateContext"
import ChatView, { ChatViewRef } from "./components/chat/ChatView"
import HistoryView from "./components/history/HistoryView"
import SettingsView, { SettingsViewRef } from "./components/settings/SettingsView"
import OnboardingView from "./components/kilocode/welcome/OnboardingView" // kilocode_change
import McpView from "./components/mcp/McpView" // kilocode_change
import { MarketplaceView } from "./components/marketplace/MarketplaceView"
import BottomControls from "./components/kilocode/BottomControls" // kilocode_change
import { MemoryService } from "./services/MemoryService" // kilocode_change
import { HumanRelayDialog } from "./components/human-relay/HumanRelayDialog"
import { CheckpointRestoreDialog } from "./components/chat/CheckpointRestoreDialog"
import { DeleteMessageDialog, EditMessageDialog } from "./components/chat/MessageModificationConfirmationDialog"
import ErrorBoundary from "./components/ErrorBoundary"
// import { AccountView } from "./components/account/AccountView" // kilocode_change: we have our own profile view
// import { CloudView } from "./components/cloud/CloudView" // kilocode_change: not rendering this
import { useAddNonInteractiveClickListener } from "./components/ui/hooks/useNonInteractiveClick"
import { TooltipProvider } from "./components/ui/tooltip"
import { STANDARD_TOOLTIP_DELAY } from "./components/ui/standard-tooltip"
import { MemoryWarningBanner } from "./kilocode/MemoryWarningBanner"

type Tab = "settings" | "history" | "mcp" | "modes" | "chat" | "marketplace" // kilocode_change: personal tabs

interface HumanRelayDialogState {
	isOpen: boolean
	requestId: string
	promptText: string
}

interface DeleteMessageDialogState {
	isOpen: boolean
	messageTs: number
	hasCheckpoint: boolean
}

interface EditMessageDialogState {
	isOpen: boolean
	messageTs: number
	text: string
	hasCheckpoint: boolean
	images?: string[]
}

// Memoize dialog components to prevent unnecessary re-renders
const MemoizedDeleteMessageDialog = React.memo(DeleteMessageDialog)
const MemoizedEditMessageDialog = React.memo(EditMessageDialog)
const MemoizedCheckpointRestoreDialog = React.memo(CheckpointRestoreDialog)
const MemoizedHumanRelayDialog = React.memo(HumanRelayDialog)

const tabsByMessageAction: Partial<Record<NonNullable<ExtensionMessage["action"]>, Tab>> = {
	chatButtonClicked: "chat",
	settingsButtonClicked: "settings",
	historyButtonClicked: "history",
	profileButtonClicked: "settings", // kilocode_change: legacy profile action opens local provider settings
	marketplaceButtonClicked: "marketplace",
	promptsButtonClicked: "settings", // kilocode_change: Navigate to settings with modes section
	// cloudButtonClicked: "cloud", // kilocode_change: no cloud
}

// kilocode_change start: Map certain actions to a default section when navigating to settings
const defaultSectionByAction: Partial<Record<NonNullable<ExtensionMessage["action"]>, string>> = {
	promptsButtonClicked: "modes",
	profileButtonClicked: "providers", // kilocode_change: the personal build has no Kilo account page
}
// kilocode_change end

const App = () => {
	const {
		didHydrateState,
		shouldShowAnnouncement,
		telemetrySetting,
		telemetryKey,
		machineId,
		// kilocode_change start: unused
		// cloudUserInfo,
		// cloudIsAuthenticated,
		// cloudApiUrl,
		// cloudOrganizations,
		// kilocode_change end
		renderContext,
		mdmCompliant,
		hasCompletedOnboarding, // kilocode_change: Track onboarding state
		taskHistoryFullLength, // kilocode_change: Used to detect existing users
	} = useExtensionState()

	// Create a persistent state manager
	const marketplaceStateManager = useMemo(() => new MarketplaceViewStateManager(), [])

	const [showAnnouncement, setShowAnnouncement] = useState(false)
	const [tab, setTab] = useState<Tab>("chat")
	// kilocode_change: personal build has no cloud-auth return state
	const [settingsEditingProfile, setSettingsEditingProfile] = useState<string | undefined>(undefined)

	const [humanRelayDialogState, setHumanRelayDialogState] = useState<HumanRelayDialogState>({
		isOpen: false,
		requestId: "",
		promptText: "",
	})

	const [deleteMessageDialogState, setDeleteMessageDialogState] = useState<DeleteMessageDialogState>({
		isOpen: false,
		messageTs: 0,
		hasCheckpoint: false,
	})

	const [editMessageDialogState, setEditMessageDialogState] = useState<EditMessageDialogState>({
		isOpen: false,
		messageTs: 0,
		text: "",
		hasCheckpoint: false,
		images: [],
	})

	const settingsRef = useRef<SettingsViewRef>(null)
	const chatViewRef = useRef<ChatViewRef & { focusInput: () => void }>(null) // kilocode_change

	const switchTab = useCallback(
		(newTab: Tab) => {
			// kilocode_change start: personal tabs do not require cloud authentication
			// Only check MDM compliance if mdmCompliant is explicitly false (meaning there's an MDM policy and user is non-compliant)
			// If mdmCompliant is undefined or true, allow tab switching
			if (mdmCompliant === false) {
				// Notify the user that authentication is required by their organization
				vscode.postMessage({ type: "showMdmAuthRequiredNotification" })
				return
			}

			setCurrentSection(undefined)
			setCurrentMarketplaceTab(undefined)

			if (settingsRef.current?.checkUnsaveChanges) {
				settingsRef.current.checkUnsaveChanges(() => setTab(newTab))
			} else {
				setTab(newTab)
			}
			// kilocode_change end
		},
		[mdmCompliant],
	)

	const [currentSection, setCurrentSection] = useState<string | undefined>(undefined)
	const [_currentMarketplaceTab, setCurrentMarketplaceTab] = useState<string | undefined>(undefined)

	const onMessage = useCallback(
		(e: MessageEvent) => {
			const message: ExtensionMessage = e.data

			if (message.type === "action" && message.action) {
				// kilocode_change begin
				if (message.action === "focusChatInput") {
					if (tab !== "chat") {
						switchTab("chat")
					}
					chatViewRef.current?.focusInput()
					return
				}
				// kilocode_change end

				// Handle switchTab action with tab parameter
				if (message.action === "switchTab" && message.tab) {
					// kilocode_change start: legacy Kilo account/auth actions are redirected
					const requestedTab = message.tab
					// to the local provider editor and never mount a vendor login view.
					if (["auth", "profile", "account", "cloud"].includes(requestedTab ?? "")) {
						const profileName = message.values?.profileName as string | undefined
						if (profileName) setSettingsEditingProfile(profileName)
						switchTab("settings")
						setCurrentSection("providers")
						return
					}
					switchTab(requestedTab as Tab)
					// kilocode_change end
					// Extract targetSection from values if provided
					const targetSection = message.values?.section as string | undefined
					setCurrentSection(targetSection)
					setCurrentMarketplaceTab(undefined)
				} else {
					// Handle other actions using the mapping
					const newTab = tabsByMessageAction[message.action]
					// kilocode_change start
					const section =
						(message.values?.section as string | undefined) ?? defaultSectionByAction[message.action]
					// kilocode_change end
					const marketplaceTab = message.values?.marketplaceTab as string | undefined
					const editingProfile = message.values?.editingProfile as string | undefined // kilocode_change

					if (newTab) {
						switchTab(newTab)
						setCurrentSection(section)
						setCurrentMarketplaceTab(marketplaceTab)
						// kilocode_change start - If navigating to settings with editingProfile, forward it
						if (newTab === "settings" && editingProfile) {
							// Re-send the message to SettingsView with the editingProfile
							setTimeout(() => {
								window.postMessage(
									{
										type: "action",
										action: "settingsButtonClicked",
										values: { editingProfile },
									},
									"*",
								)
							}, 100)
						}
						// kilocode_change end
					}
				}
			}

			if (message.type === "showHumanRelayDialog" && message.requestId && message.promptText) {
				const { requestId, promptText } = message
				setHumanRelayDialogState({ isOpen: true, requestId, promptText })
			}

			if (message.type === "showDeleteMessageDialog" && message.messageTs) {
				setDeleteMessageDialogState({
					isOpen: true,
					messageTs: message.messageTs,
					hasCheckpoint: message.hasCheckpoint || false,
				})
			}

			if (message.type === "showEditMessageDialog" && message.messageTs && message.text) {
				setEditMessageDialogState({
					isOpen: true,
					messageTs: message.messageTs,
					text: message.text,
					hasCheckpoint: message.hasCheckpoint || false,
					images: message.images || [],
				})
			}

			if (message.type === "acceptInput") {
				chatViewRef.current?.acceptInput()
			}
		},
		// kilocode_change: add tab
		[tab, switchTab],
	)

	useEvent("message", onMessage)

	useEffect(() => {
		if (shouldShowAnnouncement && tab === "chat") {
			setShowAnnouncement(true)
			vscode.postMessage({ type: "didShowAnnouncement" })
		}
	}, [shouldShowAnnouncement, tab])

	// kilocode_change start
	const telemetryDistinctId = machineId ?? "" // kilocode_change: do not fetch Kilo identity in the personal build
	useEffect(() => {
		if (didHydrateState) {
			telemetryClient.updateTelemetryState(telemetrySetting, telemetryKey, telemetryDistinctId)

			// kilocode_change start
			const memoryService = new MemoryService()
			memoryService.start()
			return () => memoryService.stop()
			// kilocode_change end
		}
	}, [telemetrySetting, telemetryKey, telemetryDistinctId, didHydrateState])
	// kilocode_change end

	// Tell the extension that we are ready to receive messages.
	useEffect(() => vscode.postMessage({ type: "webviewDidLaunch" }), [])

	// Initialize source map support for better error reporting
	useEffect(() => {
		// Initialize source maps for better error reporting in production
		initializeSourceMaps()

		// Expose source map debugging utilities in production
		if (process.env.NODE_ENV === "production") {
			exposeSourceMapsForDebugging()
		}

		// Log initialization for debugging
		console.debug("App initialized with source map support")
	}, [])

	// Focus the WebView when non-interactive content is clicked (only in editor/tab mode)
	useAddNonInteractiveClickListener(
		useCallback(() => {
			// Only send focus request if we're in editor (tab) mode, not sidebar
			if (renderContext === "editor") {
				vscode.postMessage({ type: "focusPanelRequest" })
			}
		}, [renderContext]),
	)
	// Track marketplace tab views
	useEffect(() => {
		if (tab === "marketplace") {
			telemetryClient.capture(TelemetryEventName.MARKETPLACE_TAB_VIEWED)
		}
	}, [tab])

	// kilocode_change start: Onboarding handlers
	const handleConfigureProviders = useCallback(() => {
		// Mark onboarding as complete
		vscode.postMessage({ type: "hasCompletedOnboarding", bool: true })
		// Navigate to the allowlisted provider settings.
		switchTab("settings")
		setCurrentSection("providers")
	}, [switchTab])

	// One-time migration: mark existing users as having completed onboarding
	useEffect(() => {
		if (hasCompletedOnboarding !== true && (taskHistoryFullLength ?? 0) > 0) {
			vscode.postMessage({ type: "hasCompletedOnboarding", bool: true })
		}
	}, [hasCompletedOnboarding, taskHistoryFullLength])
	// kilocode_change end

	if (!didHydrateState) {
		return null
	}

	// kilocode_change start: Show OnboardingView for new users who haven't completed onboarding
	const showOnboarding = hasCompletedOnboarding !== true

	// Do not conditionally load ChatView, it's expensive and there's state we
	// don't want to lose (user input, disableInput, askResponse promise, etc.)
	return showOnboarding ? (
		<OnboardingView onConfigureProviders={handleConfigureProviders} />
	) : (
		// kilocode_change end
		<>
			{/* kilocode_change start */}
			<MemoryWarningBanner />
			{tab === "mcp" && <McpView onDone={() => switchTab("chat")} />}
			{/* kilocode_change end */}
			{tab === "history" && <HistoryView onDone={() => switchTab("chat")} />}
			{/* kilocode_change: auth redirect / editingProfile */}
			{tab === "settings" && (
				<SettingsView
					ref={settingsRef}
					onDone={() => switchTab("chat")}
					targetSection={currentSection}
					editingProfile={settingsEditingProfile}
				/>
			)}
			{tab === "marketplace" && (
				<MarketplaceView
					stateManager={marketplaceStateManager}
					onDone={() => switchTab("chat")}
					// kilocode_change: targetTab="mode"
					targetTab="mode"
				/>
			)}
			{/* kilocode_change: no cloud view */}
			{/* {tab === "cloud" && (
				<CloudView
					userInfo={cloudUserInfo}
					isAuthenticated={cloudIsAuthenticated}
					cloudApiUrl={cloudApiUrl}
					organizations={cloudOrganizations}
				/>
			)} */}
			{/* kilocode_change: we have our own profile view */}
			{/* {tab === "account" && (
				<AccountView userInfo={cloudUserInfo} isAuthenticated={false} onDone={() => switchTab("chat")} />
			)} */}
			<ChatView
				ref={chatViewRef}
				isHidden={tab !== "chat"}
				showAnnouncement={showAnnouncement}
				hideAnnouncement={() => setShowAnnouncement(false)}
			/>
			<MemoizedHumanRelayDialog
				isOpen={humanRelayDialogState.isOpen}
				requestId={humanRelayDialogState.requestId}
				promptText={humanRelayDialogState.promptText}
				onClose={() => setHumanRelayDialogState((prev) => ({ ...prev, isOpen: false }))}
				onSubmit={(requestId, text) => vscode.postMessage({ type: "humanRelayResponse", requestId, text })}
				onCancel={(requestId) => vscode.postMessage({ type: "humanRelayCancel", requestId })}
			/>
			{deleteMessageDialogState.hasCheckpoint ? (
				<MemoizedCheckpointRestoreDialog
					open={deleteMessageDialogState.isOpen}
					type="delete"
					hasCheckpoint={deleteMessageDialogState.hasCheckpoint}
					onOpenChange={(open: boolean) => setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: open }))}
					onConfirm={(restoreCheckpoint: boolean) => {
						vscode.postMessage({
							type: "deleteMessageConfirm",
							messageTs: deleteMessageDialogState.messageTs,
							restoreCheckpoint,
						})
						setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: false }))
					}}
				/>
			) : (
				<MemoizedDeleteMessageDialog
					open={deleteMessageDialogState.isOpen}
					onOpenChange={(open: boolean) => setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: open }))}
					onConfirm={() => {
						vscode.postMessage({
							type: "deleteMessageConfirm",
							messageTs: deleteMessageDialogState.messageTs,
						})
						setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: false }))
					}}
				/>
			)}
			{editMessageDialogState.hasCheckpoint ? (
				<MemoizedCheckpointRestoreDialog
					open={editMessageDialogState.isOpen}
					type="edit"
					hasCheckpoint={editMessageDialogState.hasCheckpoint}
					onOpenChange={(open: boolean) => setEditMessageDialogState((prev) => ({ ...prev, isOpen: open }))}
					onConfirm={(restoreCheckpoint: boolean) => {
						vscode.postMessage({
							type: "editMessageConfirm",
							messageTs: editMessageDialogState.messageTs,
							text: editMessageDialogState.text,
							restoreCheckpoint,
							images: editMessageDialogState.images,
						})
						setEditMessageDialogState((prev) => ({ ...prev, isOpen: false }))
					}}
				/>
			) : (
				<MemoizedEditMessageDialog
					open={editMessageDialogState.isOpen}
					onOpenChange={(open: boolean) => setEditMessageDialogState((prev) => ({ ...prev, isOpen: open }))}
					onConfirm={() => {
						vscode.postMessage({
							type: "editMessageConfirm",
							messageTs: editMessageDialogState.messageTs,
							text: editMessageDialogState.text,
							images: editMessageDialogState.images,
						})
						setEditMessageDialogState((prev) => ({ ...prev, isOpen: false }))
					}}
				/>
			)}
			{/* kilocode_change */}
			{/* Chat, and history view contain their own bottom controls, settings doesn't need it */}
			{!["chat", "settings", "history"].includes(tab) && (
				<div className="fixed inset-0 top-auto">
					<BottomControls />
				</div>
			)}
		</>
	)
}

const queryClient = new QueryClient()

const AppWithProviders = () => (
	<ErrorBoundary>
		<ExtensionStateContextProvider>
			<TranslationProvider>
				<QueryClientProvider client={queryClient}>
					<TooltipProvider delayDuration={STANDARD_TOOLTIP_DELAY}>
						<App />
					</TooltipProvider>
				</QueryClientProvider>
			</TranslationProvider>
		</ExtensionStateContextProvider>
	</ErrorBoundary>
)

export default AppWithProviders
