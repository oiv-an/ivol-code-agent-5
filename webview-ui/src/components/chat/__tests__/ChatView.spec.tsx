// pnpm --filter @roo-code/vscode-webview test src/components/chat/__tests__/ChatView.spec.tsx

import React from "react"
import { render, waitFor, act, fireEvent } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import ChatView, { ChatViewProps, ChatViewRef } from "../ChatView" // kilocode_change: exercise the same acceptance shortcut exposed to the host.

// Define minimal types needed for testing
interface ClineMessage {
	type: "say" | "ask"
	say?: string
	ask?: string
	ts: number
	text?: string
	partial?: boolean
}

interface ExtensionState {
	version: string
	clineMessages: ClineMessage[]
	taskHistory: any[]
	shouldShowAnnouncement: boolean
	allowedCommands: string[]
	alwaysAllowExecute: boolean
	[key: string]: any
}

// Mock vscode API
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock use-sound hook
const mockPlayFunction = vi.fn()
vi.mock("use-sound", () => ({
	default: vi.fn().mockImplementation(() => {
		return [mockPlayFunction]
	}),
}))

// Mock components that use ESM dependencies
vi.mock("../BrowserSessionRow", () => ({
	default: function MockBrowserSessionRow({ messages }: { messages: ClineMessage[] }) {
		return <div data-testid="browser-session">{JSON.stringify(messages)}</div>
	},
}))

vi.mock("../ChatRow", () => ({
	default: function MockChatRow({ message }: { message: ClineMessage }) {
		return <div data-testid="chat-row">{JSON.stringify(message)}</div>
	},
}))

vi.mock("../AutoApproveMenu", () => ({
	default: () => null,
}))

// Mock react-virtuoso to render items directly without virtualization
// This allows tests to verify items rendered in the chat list
vi.mock("react-virtuoso", () => ({
	Virtuoso: function MockVirtuoso({
		data,
		itemContent,
	}: {
		data: ClineMessage[]
		itemContent: (index: number, item: ClineMessage) => React.ReactNode
	}) {
		return (
			<div data-testid="virtuoso-item-list">
				{data.map((item, index) => (
					<div key={item.ts} data-testid={`virtuoso-item-${index}`}>
						{itemContent(index, item)}
					</div>
				))}
			</div>
		)
	},
}))

// Mock VersionIndicator - returns null by default to prevent rendering in tests
vi.mock("../../common/VersionIndicator", () => ({
	default: vi.fn(() => null),
}))

// Get the mock function after the module is mocked
const mockVersionIndicator = vi.mocked((await import("../../common/VersionIndicator")).default)

vi.mock("../Announcement", () => ({
	default: function MockAnnouncement({ hideAnnouncement }: { hideAnnouncement: () => void }) {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const React = require("react")
		return React.createElement(
			"div",
			{ "data-testid": "announcement-modal" },
			React.createElement("div", null, "What's New"),
			React.createElement("button", { onClick: hideAnnouncement }, "Close"),
		)
	},
}))

// Mock DismissibleUpsell component
vi.mock("@/components/common/DismissibleUpsell", () => ({
	default: function MockDismissibleUpsell({ children }: { children: React.ReactNode }) {
		return <div data-testid="dismissible-upsell">{children}</div>
	},
}))

// Mock QueuedMessages component
vi.mock("../QueuedMessages", () => ({
	QueuedMessages: function MockQueuedMessages({
		queue = [],
		onRemove,
	}: {
		queue?: Array<{ id: string; text: string; images?: string[] }>
		onRemove?: (index: number) => void
		onUpdate?: (index: number, newText: string) => void
	}) {
		if (!queue || queue.length === 0) {
			return null
		}
		return (
			<div data-testid="queued-messages">
				{queue.map((msg, index) => (
					<div key={msg.id}>
						<span>{msg.text}</span>
						<button aria-label="Remove message" onClick={() => onRemove?.(index)}>
							Remove
						</button>
					</div>
				))}
			</div>
		)
	},
}))

// Mock RooTips component
vi.mock("@src/components/welcome/RooTips", () => ({
	default: function MockRooTips() {
		return <div data-testid="roo-tips">Tips content</div>
	},
}))

// Mock RooHero component
vi.mock("@src/components/welcome/RooHero", () => ({
	default: function MockRooHero() {
		return <div data-testid="roo-hero">Hero content</div>
	},
}))

// Mock TelemetryBanner component
vi.mock("../common/TelemetryBanner", () => ({
	default: function MockTelemetryBanner() {
		return null // Don't render anything to avoid interference
	},
}))

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: any) => {
			if (key === "chat:versionIndicator.ariaLabel" && options?.version) {
				return `Version ${options.version}`
			}
			return key
		},
	}),
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
	Trans: ({ i18nKey, children }: { i18nKey: string; children?: React.ReactNode }) => {
		return <>{children || i18nKey}</>
	},
}))

interface ChatTextAreaProps {
	onSend: () => void
	inputValue?: string
	setInputValue?: (value: string) => void
	sendingDisabled?: boolean
	placeholderText?: string
	selectedImages?: string[]
	shouldDisableImages?: boolean
}

const mockInputRef = React.createRef<HTMLInputElement>()
const mockFocus = vi.fn()

vi.mock("../ChatTextArea", () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const mockReact = require("react")

	const ChatTextAreaComponent = mockReact.forwardRef(function MockChatTextArea(
		props: ChatTextAreaProps,
		ref: React.ForwardedRef<{ focus: () => void }>,
	) {
		// Use useImperativeHandle to expose the mock focus method
		mockReact.useImperativeHandle(ref, () => ({
			focus: mockFocus,
		}))

		return (
			<div data-testid="chat-textarea">
				<input
					ref={mockInputRef}
					type="text"
					value={props.inputValue || ""}
					onChange={(e) => {
						// Use parent's setInputValue if available
						if (props.setInputValue) {
							props.setInputValue(e.target.value)
						}
					}}
					onKeyDown={(e) => {
						// Only call onSend when Enter is pressed (simulating real behavior)
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault()
							props.onSend()
						}
					}}
					data-sending-disabled={props.sendingDisabled}
				/>
			</div>
		)
	})

	return {
		default: ChatTextAreaComponent,
		ChatTextArea: ChatTextAreaComponent, // Export as named export too
	}
})

// Mock VSCode components
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: function MockVSCodeButton({
		children,
		onClick,
		appearance,
	}: {
		children: React.ReactNode
		onClick?: () => void
		appearance?: string
	}) {
		return (
			<button onClick={onClick} data-appearance={appearance}>
				{children}
			</button>
		)
	},
	VSCodeTextField: function MockVSCodeTextField({
		value,
		onInput,
		placeholder,
	}: {
		value?: string
		onInput?: (e: { target: { value: string } }) => void
		placeholder?: string
	}) {
		return (
			<input
				type="text"
				value={value}
				onChange={(e) => onInput?.({ target: { value: e.target.value } })}
				placeholder={placeholder}
			/>
		)
	},
	VSCodeLink: function MockVSCodeLink({ children, href }: { children: React.ReactNode; href?: string }) {
		return <a href={href}>{children}</a>
	},
}))

// Mock window.postMessage to trigger state hydration
const mockPostMessage = (state: Partial<ExtensionState>) => {
	window.postMessage(
		{
			type: "state",
			state: {
				version: "1.0.0",
				clineMessages: [],
				taskHistory: [],
				shouldShowAnnouncement: false,
				allowedCommands: [],
				alwaysAllowExecute: false,
				cloudIsAuthenticated: false,
				telemetrySetting: "enabled",
				...state,
			},
		},
		"*",
	)
}

const defaultProps: ChatViewProps = {
	isHidden: false,
	showAnnouncement: false,
	hideAnnouncement: () => {},
}

const queryClient = new QueryClient()

const renderChatView = (props: Partial<ChatViewProps> = {}, ref?: React.Ref<ChatViewRef>) => {
	// kilocode_change
	return render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<ChatView {...defaultProps} {...props} ref={ref} />
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)
}

// kilocode_change start: completion acknowledgments must not navigate away from the result.
describe("ChatView - keep completed task open", () => {
	beforeEach(() => vi.clearAllMocks())

	const taskMessage: ClineMessage = { type: "say", say: "text", ts: 1, text: "Original task" }
	const completionMessage: ClineMessage = {
		type: "ask",
		ask: "completion_result",
		ts: 3,
		text: "Task completed successfully",
		partial: false,
	}
	const invokePrimary = (text = "") => {
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "invoke", invoke: "primaryButtonClick", text },
				}),
			),
		)
	}
	const openCompletedTask = async (ask = "completion_result", parentTaskId?: string) => {
		const ref = React.createRef<ChatViewRef>()
		const view = renderChatView({}, ref)
		mockPostMessage({
			currentTaskId: "task-a",
			currentTaskItem: { id: "task-a", ts: 1, task: "Original task", parentTaskId },
			clineMessages: [
				taskMessage,
				completionMessage,
				...(ask === "completion_result"
					? []
					: [{ type: "ask" as const, ask, ts: 4, text: "Resume finished task" }]),
			],
		})
		await waitFor(() => expect(view.getByText("chat:startNewTask.title")).toBeInTheDocument())
		expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: "clearTask" })
		vi.mocked(vscode.postMessage).mockClear()
		return { ...view, ref }
	}

	it.each(["completion_result", "resume_completed_task", "resume_task"])(
		"keeps %s visible after generic approval and empty keyboard acceptance",
		async (ask) => {
			const view = await openCompletedTask(ask, ask === "resume_task" ? "parent-a" : undefined)
			invokePrimary()
			act(() => view.ref.current?.acceptInput())
			expect(vscode.postMessage).not.toHaveBeenCalled()
			expect(view.getByText("chat:startNewTask.title")).toBeInTheDocument()
			expect(view.getByTestId("chat-textarea").querySelector("input")).toHaveAttribute(
				"data-sending-disabled",
				"false",
			)
			expect(view.container).toHaveTextContent("Task completed successfully")
		},
	)

	it.each(["completion_result", "resume_completed_task", "resume_task"])(
		"sends keyboard feedback to the same task for %s",
		async (ask) => {
			const view = await openCompletedTask(ask, ask === "resume_task" ? "parent-a" : undefined)
			fireEvent.change(view.getByTestId("chat-textarea").querySelector("input")!, {
				target: { value: "Please also verify the result" },
			})
			act(() => view.ref.current?.acceptInput())
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "askResponse",
				askResponse: "messageResponse",
				text: "Please also verify the result",
				images: [],
			})
			expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: "clearTask" })
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "newTask" }))
		},
	)

	it("sends text from a generic completion invocation as same-task feedback", async () => {
		await openCompletedTask()
		invokePrimary("Add one more check")
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "askResponse",
			askResponse: "messageResponse",
			text: "Add one more check",
			images: [],
		})
		expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: "clearTask" })
	})

	it("still closes a completed task from its explicit header close button", async () => {
		const view = await openCompletedTask()
		const closeButton = view.container.querySelector(".codicon-close")?.closest("button")
		expect(closeButton).toBeTruthy()
		fireEvent.click(closeButton!)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "clearTask" })
	})

	it.each(["completion_result", "resume_completed_task", "resume_task"])(
		"still starts a new task from the explicit button for %s",
		async (ask) => {
			const view = await openCompletedTask(ask, ask === "resume_task" ? "parent-a" : undefined)
			fireEvent.click(view.getByText("chat:startNewTask.title"))
			expect(vscode.postMessage).toHaveBeenCalledWith({ type: "clearTask" })
		},
	)

	it("ignores stale approval callbacks when an incremental completion arrives", async () => {
		const ref = React.createRef<ChatViewRef>()
		const view = renderChatView({}, ref)
		mockPostMessage({
			currentTaskId: "task-a",
			currentTaskItem: { id: "task-a", ts: 1, task: "Original task" },
			clineMessages: [
				taskMessage,
				{ type: "ask", ask: "tool", ts: 2, text: JSON.stringify({ tool: "readFile", path: "a.ts" }) },
			],
		})
		await waitFor(() => expect(view.getByText("chat:approve.title")).toBeInTheDocument())
		const staleAcceptInput = ref.current!.acceptInput
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "messageCreated", taskId: "task-a", clineMessage: completionMessage },
				}),
			),
		)
		await waitFor(() => expect(view.getByText("chat:startNewTask.title")).toBeInTheDocument())
		vi.mocked(vscode.postMessage).mockClear()
		act(() => staleAcceptInput())
		invokePrimary()
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(view.container).toHaveTextContent("Task completed successfully")
	})

	it.each(["readFile", "finishTask"])("preserves generic approval for %s", async (tool) => {
		const ref = React.createRef<ChatViewRef>()
		const view = renderChatView({}, ref)
		mockPostMessage({
			currentTaskId: "task-a",
			currentTaskItem: {
				id: "task-a",
				ts: 1,
				task: "Original task",
				parentTaskId: tool === "finishTask" ? "parent-a" : undefined,
			},
			clineMessages: [
				taskMessage,
				{ type: "ask", ask: "tool", ts: 2, text: JSON.stringify({ tool, path: "a.ts" }) },
			],
		})
		await waitFor(() =>
			expect(
				view.getByText(tool === "finishTask" ? "chat:completeSubtaskAndReturn" : "chat:approve.title"),
			).toBeInTheDocument(),
		)
		vi.mocked(vscode.postMessage).mockClear()
		act(() => ref.current?.acceptInput())
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "askResponse", askResponse: "yesButtonClicked" })
		expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: "clearTask" })
	})

	it("preserves host-invoked tool approval", async () => {
		const view = renderChatView()
		mockPostMessage({
			clineMessages: [
				taskMessage,
				{ type: "ask", ask: "tool", ts: 2, text: JSON.stringify({ tool: "readFile", path: "a.ts" }) },
			],
		})
		await waitFor(() => expect(view.getByText("chat:approve.title")).toBeInTheDocument())
		vi.mocked(vscode.postMessage).mockClear()
		invokePrimary()
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "askResponse", askResponse: "yesButtonClicked" })
		expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: "clearTask" })
	})

	it("continues a command after a trailing output message without losing the pending ask", async () => {
		const view = renderChatView()
		const commandAsk: ClineMessage = { type: "ask", ask: "command_output", ts: 2, text: "Process running" }
		mockPostMessage({
			currentTaskId: "task-a",
			currentTaskItem: { id: "task-a", ts: 1, task: "Original task" },
			clineMessages: [taskMessage, commandAsk],
		})
		await waitFor(() => expect(view.getByText("chat:proceedWhileRunning.title")).toBeInTheDocument())
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "messageCreated",
						taskId: "task-a",
						clineMessage: { type: "say", say: "command_output", ts: 3, text: "Additional terminal output" },
					},
				}),
			),
		)
		// Output-only rows are combined/hidden by the chat renderer; the pending controls must remain usable.
		expect(view.getByText("chat:proceedWhileRunning.title")).toBeInTheDocument()
		vi.mocked(vscode.postMessage).mockClear()
		invokePrimary()
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "terminalOperation", terminalOperation: "continue" })
		expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: "clearTask" })
	})
})
// kilocode_change end

describe("ChatView - restored task controls", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(vscode.postMessage).mockClear()
	})

	// kilocode_change: exhausted transport retries must expose user controls, not a stale Cancel state.
	it("shows an enabled Retry after a terminated countdown even with auto-approval enabled", async () => {
		const view = renderChatView()
		const taskTs = Date.now() - 2_000
		mockPostMessage({
			autoApprovalEnabled: true,
			currentTaskId: "task-a",
			currentTaskItem: { id: "task-a", ts: taskTs, task: "Original task" },
			clineMessages: [
				{ type: "say", say: "text", ts: taskTs, text: "Original task" },
				{
					type: "say",
					say: "api_req_started",
					ts: taskTs + 1,
					text: JSON.stringify({ apiProtocol: "openai" }),
				},
				{
					type: "say",
					say: "api_req_retry_delayed",
					ts: taskTs + 2,
					text: "terminated\n<retry_timer>1</retry_timer>",
					partial: true,
				},
				{
					type: "ask",
					ask: "api_req_failed",
					ts: taskTs + 3,
					text: "OpenAI response stream timed out. Automatic retry limit reached.",
					partial: false,
				},
			],
		})

		await waitFor(() => {
			expect(view.getByText("chat:retry.title")).toBeEnabled()
			expect(view.getByText("chat:startNewTask.title")).toBeEnabled()
			expect(view.queryByText("chat:cancel.title")).not.toBeInTheDocument()
		})
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(view.getByText("chat:retry.title"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "askResponse", askResponse: "yesButtonClicked" })
		expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: "cancelTask" })

		// The backend clears the failed request marker before starting the explicit retry.
		mockPostMessage({
			autoApprovalEnabled: true,
			currentTaskId: "task-a",
			currentTaskItem: { id: "task-a", ts: taskTs, task: "Original task" },
			clineMessages: [
				{ type: "say", say: "text", ts: taskTs, text: "Original task" },
				{
					type: "say",
					say: "api_req_started",
					ts: taskTs + 1,
					text: JSON.stringify({ apiProtocol: "openai" }),
				},
				{ type: "ask", ask: "api_req_failed", ts: taskTs + 3, text: "Previous error", partial: false },
				{ type: "say", say: "api_req_retried", ts: taskTs + 4 },
			],
		})
		await waitFor(() => {
			expect(view.getByText("chat:cancel.title")).toBeEnabled()
			expect(view.queryByText("chat:retry.title")).not.toBeInTheDocument()
		})
	})

	it.each(["user_cancelled", "streaming_failed"])(
		"shows Resume/Terminate instead of a false Cancel after %s",
		async (cancelReason) => {
			const view = renderChatView()
			const taskTs = Date.now() - 2_000

			mockPostMessage({
				currentTaskId: "task-a",
				currentTaskItem: { id: "task-a", ts: taskTs, task: "Original task" },
				clineMessages: [
					{ type: "say", say: "text", ts: taskTs, text: "Original task" },
					{
						type: "say",
						say: "api_req_started",
						ts: taskTs + 1,
						text: JSON.stringify({ apiProtocol: "openai", cancelReason }),
					},
					{
						type: "say",
						say: "api_req_retry_delayed",
						ts: taskTs + 2,
						text: "Stopped retry",
						partial: true,
					},
				],
			})

			await waitFor(() => {
				expect(view.queryByText("chat:cancel.title")).not.toBeInTheDocument()
			})

			window.postMessage(
				{
					type: "messageCreated",
					taskId: "task-a",
					clineMessage: {
						type: "ask",
						ask: "resume_task",
						ts: taskTs + 3,
						partial: false,
					},
				},
				"*",
			)

			await waitFor(() => {
				expect(view.getByText("chat:resumeTask.title")).toBeInTheDocument()
				expect(view.getByText("chat:terminate.title")).toBeInTheDocument()
				expect(view.queryByText("chat:cancel.title")).not.toBeInTheDocument()
			})

			vi.mocked(vscode.postMessage).mockClear()
			fireEvent.click(view.getByText("chat:terminate.title"))
			expect(vscode.postMessage).toHaveBeenCalledWith({ type: "clearTask" })
			expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: "cancelTask" })
		},
	)
})

describe("ChatView - Sound Playing Tests", () => {
	beforeEach(() => vi.clearAllMocks())

	it("plays celebration sound for completion results", async () => {
		renderChatView()

		// First hydrate state with initial task
		mockPostMessage({
			soundEnabled: true, // Enable sound
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
			],
		})

		// Clear any initial calls
		mockPlayFunction.mockClear()

		// Add completion result
		mockPostMessage({
			soundEnabled: true, // Enable sound
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "ask",
					ask: "completion_result",
					ts: Date.now(),
					text: "Task completed successfully",
					partial: false, // Ensure it's not partial
				},
			],
		})

		// Wait for sound to be played
		await waitFor(() => {
			expect(mockPlayFunction).toHaveBeenCalled()
		})
	})

	it("plays progress_loop sound for api failures", async () => {
		renderChatView()

		// First hydrate state with initial task
		mockPostMessage({
			soundEnabled: true, // Enable sound
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
			],
		})

		// Clear any initial calls
		mockPlayFunction.mockClear()

		// Add API failure
		mockPostMessage({
			soundEnabled: true, // Enable sound
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "ask",
					ask: "api_req_failed",
					ts: Date.now(),
					text: "API request failed",
					partial: false, // Ensure it's not partial
				},
			],
		})

		// Wait for sound to be played
		await waitFor(() => {
			expect(mockPlayFunction).toHaveBeenCalled()
		})
	})

	it("does not play sound when resuming a task from history", () => {
		renderChatView()

		// Clear any initial calls
		mockPlayFunction.mockClear()

		// Hydrate state with a task that has a resumeTaskId (indicating it's resumed from history)
		mockPostMessage({
			resumeTaskId: "task-123",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Resumed task",
				},
				{
					type: "ask",
					ask: "tool",
					ts: Date.now(),
					text: JSON.stringify({ tool: "readFile", path: "test.txt" }),
				},
			],
		})

		// Should not play sound when resuming from history
		expect(mockPlayFunction).not.toHaveBeenCalled()
	})

	it("does not play sound when resuming a completed task from history", () => {
		renderChatView()

		// Clear any initial calls
		mockPlayFunction.mockClear()

		// Hydrate state with a completed task that has a resumeTaskId
		mockPostMessage({
			resumeTaskId: "task-123",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Resumed task",
				},
				{
					type: "ask",
					ask: "completion_result",
					ts: Date.now(),
					text: "Task completed",
				},
			],
		})

		// Should not play sound for completion when resuming from history
		expect(mockPlayFunction).not.toHaveBeenCalled()
	})
})

describe("ChatView - Focus Grabbing Tests", () => {
	beforeEach(() => vi.clearAllMocks())

	it("does not grab focus when follow-up question presented", async () => {
		const { getByTestId } = renderChatView()

		// First hydrate state with initial task
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
			],
		})

		// Wait for the component to fully render and settle before clearing mocks
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Wait for the debounced focus effect to fire (50ms debounce + buffer for CI variability)
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 100))
		})

		// Clear any initial calls after state has settled
		mockFocus.mockClear()

		// Add follow-up question
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "ask",
					ask: "followup",
					ts: Date.now(),
					text: "Should I continue?",
				},
			],
		})

		// Wait for state update to complete
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Should not grab focus for follow-up questions
		expect(mockFocus).not.toHaveBeenCalled()
	})
})

describe.skip("ChatView - Version Indicator Tests", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Reset the mock to return null by default
		mockVersionIndicator.mockReturnValue(null)
	})

	it("displays version indicator button", () => {
		// Mock VersionIndicator to return a button
		mockVersionIndicator.mockReturnValue(
			React.createElement("button", {
				"data-testid": "version-indicator",
				"aria-label": "Version 1.0.0",
				className: "version-indicator-button",
			}),
		)

		const { getByTestId } = renderChatView()

		// Hydrate state with no active task
		mockPostMessage({
			version: "1.0.0",
			clineMessages: [],
		})

		// Should display version indicator
		expect(getByTestId("version-indicator")).toBeInTheDocument()
	})

	it("opens announcement modal when version indicator is clicked", async () => {
		// Mock VersionIndicator to return a button with onClick
		mockVersionIndicator.mockImplementation(({ onClick }: { onClick?: () => void }) =>
			React.createElement("button", {
				"data-testid": "version-indicator",
				onClick,
			}),
		)

		const { getByTestId, queryByTestId } = renderChatView({ showAnnouncement: false })

		// Hydrate state
		mockPostMessage({
			version: "1.0.0",
			clineMessages: [],
		})

		// Wait for component to render
		await waitFor(() => {
			expect(getByTestId("version-indicator")).toBeInTheDocument()
		})

		// Click version indicator
		const versionIndicator = getByTestId("version-indicator")
		act(() => {
			versionIndicator.click()
		})

		// Wait for announcement modal to appear
		await waitFor(() => {
			expect(queryByTestId("announcement-modal")).toBeInTheDocument()
		})
	})

	it("version indicator has correct styling classes", () => {
		// Mock VersionIndicator to return a button with specific classes
		mockVersionIndicator.mockReturnValue(
			React.createElement("button", {
				"data-testid": "version-indicator",
				className: "version-indicator-button absolute top-2 right-2",
			}),
		)

		const { getByTestId } = renderChatView()

		// Hydrate state
		mockPostMessage({
			version: "1.0.0",
			clineMessages: [],
		})

		const versionIndicator = getByTestId("version-indicator")
		expect(versionIndicator.className).toContain("version-indicator-button")
		expect(versionIndicator.className).toContain("absolute")
		expect(versionIndicator.className).toContain("top-2")
		expect(versionIndicator.className).toContain("right-2")
	})

	it("version indicator has proper accessibility attributes", () => {
		// Mock VersionIndicator to return a button with aria-label
		mockVersionIndicator.mockReturnValue(
			React.createElement("button", {
				"data-testid": "version-indicator",
				"aria-label": "Version 1.0.0",
				role: "button",
			}),
		)

		const { getByTestId } = renderChatView()

		// Hydrate state
		mockPostMessage({
			version: "1.0.0",
			clineMessages: [],
		})

		const versionIndicator = getByTestId("version-indicator")
		expect(versionIndicator.getAttribute("aria-label")).toBe("Version 1.0.0")
		expect(versionIndicator.getAttribute("role")).toBe("button")
	})

	it("does not display version indicator when there is an active task", () => {
		// Mock VersionIndicator to return null (simulating hidden state)
		mockVersionIndicator.mockReturnValue(null)

		const { queryByTestId } = renderChatView()

		// Hydrate state with active task
		mockPostMessage({
			version: "1.0.0",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now(),
					text: "Active task",
				},
			],
		})

		// Should not display version indicator during active task
		expect(queryByTestId("version-indicator")).not.toBeInTheDocument()
	})

	it("displays version indicator only on welcome screen (no task)", () => {
		// Mock VersionIndicator to return a button
		mockVersionIndicator.mockReturnValue(React.createElement("button", { "data-testid": "version-indicator" }))

		const { queryByTestId } = renderChatView()

		// Hydrate state with no active task
		mockPostMessage({
			version: "1.0.0",
			clineMessages: [],
		})

		// Should display version indicator on welcome screen
		expect(queryByTestId("version-indicator")).toBeInTheDocument()
	})
})

// kilocode_change skip
it.skip("ChatView - RooCloudCTA Display Tests", () => {
	beforeEach(() => vi.clearAllMocks())

	it("does not show DismissibleUpsell when user is authenticated to Cloud", () => {
		const { queryByTestId } = renderChatView()

		// Hydrate state with user authenticated to cloud
		mockPostMessage({
			cloudIsAuthenticated: true,
			taskHistory: [
				{ id: "1", ts: Date.now() - 3000 },
				{ id: "2", ts: Date.now() - 2000 },
				{ id: "3", ts: Date.now() - 1000 },
				{ id: "4", ts: Date.now() },
			],
			clineMessages: [], // No active task
		})

		// Should not show DismissibleUpsell when authenticated
		expect(queryByTestId("dismissible-upsell")).not.toBeInTheDocument()
	})

	it("does not show DismissibleUpsell when user has only run 3 tasks in their history", () => {
		const { queryByTestId } = renderChatView()

		// Hydrate state with user not authenticated but only 3 tasks
		mockPostMessage({
			cloudIsAuthenticated: false,
			taskHistory: [
				{ id: "1", ts: Date.now() - 2000 },
				{ id: "2", ts: Date.now() - 1000 },
				{ id: "3", ts: Date.now() },
			],
			clineMessages: [], // No active task
		})

		// Should not show DismissibleUpsell with less than 4 tasks
		expect(queryByTestId("dismissible-upsell")).not.toBeInTheDocument()
	})

	// kilocode_change skip
	it.skip("shows DismissibleUpsell when user is not authenticated and has run 6 or more tasks", async () => {
		const { getByTestId } = renderChatView()

		// Hydrate state with user not authenticated and 4 tasks
		mockPostMessage({
			cloudIsAuthenticated: false,
			taskHistory: [
				{ id: "1", ts: Date.now() - 6000 },
				{ id: "2", ts: Date.now() - 5000 },
				{ id: "3", ts: Date.now() - 4000 },
				{ id: "4", ts: Date.now() - 3000 },
				{ id: "5", ts: Date.now() - 2000 },
				{ id: "6", ts: Date.now() - 1000 },
				{ id: "7", ts: Date.now() },
			],
			clineMessages: [], // No active task
		})

		// Wait for component to render and show DismissibleUpsell
		await waitFor(() => {
			expect(getByTestId("dismissible-upsell")).toBeInTheDocument()
		})
	})

	it("does not show DismissibleUpsell when there is an active task (regardless of auth status)", async () => {
		const { queryByTestId } = renderChatView()

		// Hydrate state with active task
		mockPostMessage({
			cloudIsAuthenticated: false,
			taskHistory: [
				{ id: "1", ts: Date.now() - 3000 },
				{ id: "2", ts: Date.now() - 2000 },
				{ id: "3", ts: Date.now() - 1000 },
				{ id: "4", ts: Date.now() },
			],
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now(),
					text: "Active task",
				},
			],
		})

		// Wait for component to render with active task
		await waitFor(() => {
			// Should not show DismissibleUpsell during active task
			expect(queryByTestId("dismissible-upsell")).not.toBeInTheDocument()
			// Should not show RooTips either since the entire welcome screen is hidden during active tasks
			expect(queryByTestId("roo-tips")).not.toBeInTheDocument()
			// Should not show RooHero either since the entire welcome screen is hidden during active tasks
			expect(queryByTestId("roo-hero")).not.toBeInTheDocument()
		})
	})

	// kilocode_change skip
	it.skip("shows RooTips when user is authenticated (instead of RooCloudCTA)", () => {
		const { queryByTestId, getByTestId } = renderChatView()

		// Hydrate state with user authenticated to cloud
		mockPostMessage({
			cloudIsAuthenticated: true,
			taskHistory: [
				{ id: "1", ts: Date.now() - 3000 },
				{ id: "2", ts: Date.now() - 2000 },
				{ id: "3", ts: Date.now() - 1000 },
				{ id: "4", ts: Date.now() },
			],
			clineMessages: [], // No active task
		})

		// Should not show DismissibleUpsell but should show RooTips
		expect(queryByTestId("dismissible-upsell")).not.toBeInTheDocument()
		expect(getByTestId("roo-tips")).toBeInTheDocument()
	})

	// kilocode_change skip
	it.skip("shows RooTips when user has fewer than 6 tasks (instead of DismissibleUpsell)", () => {
		const { queryByTestId, getByTestId } = renderChatView()

		// Hydrate state with user not authenticated but fewer than 4 tasks
		mockPostMessage({
			cloudIsAuthenticated: false,
			taskHistory: [
				{ id: "1", ts: Date.now() - 2000 },
				{ id: "2", ts: Date.now() - 1000 },
				{ id: "3", ts: Date.now() },
			],
			clineMessages: [], // No active task
		})

		// Should not show DismissibleUpsell but should show RooTips
		expect(queryByTestId("dismissible-upsell")).not.toBeInTheDocument()
		expect(getByTestId("roo-tips")).toBeInTheDocument()
	})
})

// kilocode_change skip: these tests are flaky and only reliably pass when run individually, not as a set
describe.skip("ChatView - Message Queueing Tests", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Reset the mock to clear any initial calls
		vi.mocked(vscode.postMessage).mockClear()
	})

	it("shows sending is disabled when task is active", async () => {
		const { getByTestId } = renderChatView()

		// Hydrate state with active task that should disable sending
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 1000,
					text: "Task in progress",
				},
				{
					type: "ask",
					ask: "tool",
					ts: Date.now(),
					text: JSON.stringify({ tool: "readFile", path: "test.txt" }),
					partial: true, // Partial messages disable sending
				},
			],
		})

		// Wait for state to be updated and check that sending is disabled
		await waitFor(() => {
			const chatTextArea = getByTestId("chat-textarea")
			const input = chatTextArea.querySelector("input")!
			expect(input.getAttribute("data-sending-disabled")).toBe("true")
		})
	})

	it("shows sending is enabled when no task is active", async () => {
		const { getByTestId } = renderChatView()

		// Hydrate state with completed task
		mockPostMessage({
			clineMessages: [
				{
					type: "ask",
					ask: "completion_result",
					ts: Date.now(),
					text: "Task completed",
					partial: false,
				},
			],
		})

		// Wait for state to be updated
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Check that sending is enabled
		const chatTextArea = getByTestId("chat-textarea")
		const input = chatTextArea.querySelector("input")!
		expect(input.getAttribute("data-sending-disabled")).toBe("false")
	})

	// kilocode_change start
	it.each(["Retry update", "Continue without updating"])(
		"sends preparation decision %s directly despite a busy request and queue",
		async (answer) => {
			const { getByTestId } = renderChatView()
			mockPostMessage({
				messageQueue: [{ id: "queued", text: "Unrelated queued work", images: [], timestamp: 1 }],
				clineMessages: [
					{ type: "say", say: "task", ts: 1, text: "Initial task" },
					{ type: "say", say: "api_req_started", ts: 2, text: JSON.stringify({ apiProtocol: "anthropic" }) },
					{
						type: "ask",
						ask: "followup",
						ts: 3,
						partial: false,
						text: JSON.stringify({
							contextPreparationDecision: true,
							question: "Preparation failed",
							suggest: [{ answer }],
						}),
					},
				],
			})
			await waitFor(() =>
				expect(getByTestId("chat-textarea").querySelector("input")!.getAttribute("data-sending-disabled")).toBe(
					"false",
				),
			)
			vi.mocked(vscode.postMessage).mockClear()
			await act(async () => {
				const input = getByTestId("chat-textarea").querySelector("input")!
				fireEvent.change(input, { target: { value: answer } })
				fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
			})
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "askResponse",
				askResponse: "messageResponse",
				text: answer,
				images: [],
			})
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "queueMessage" }))
		},
	)
	// kilocode_change end

	it("queues messages when API request is in progress (spinner visible)", async () => {
		const { getByTestId } = renderChatView()

		// First hydrate state with initial task
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
			],
		})

		// Clear any initial calls
		vi.mocked(vscode.postMessage).mockClear()

		// Add api_req_started without cost (spinner state - API request in progress)
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now(),
					text: JSON.stringify({ apiProtocol: "anthropic" }), // No cost = still streaming
				},
			],
		})

		// Wait for state to be updated
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Clear message calls before simulating user input
		vi.mocked(vscode.postMessage).mockClear()

		// Simulate user typing and sending a message during the spinner
		const chatTextArea = getByTestId("chat-textarea")
		const input = chatTextArea.querySelector("input")! as HTMLInputElement

		// Trigger message send by simulating typing and Enter key press
		await act(async () => {
			// Use fireEvent to properly trigger React's onChange handler
			fireEvent.change(input, { target: { value: "follow-up question during spinner" } })

			// Simulate pressing Enter to send
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		// Verify that the message was queued, not sent as askResponse
		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "queueMessage",
				text: "follow-up question during spinner",
				images: [],
			})
		})

		// Verify it was NOT sent as a direct askResponse (which would get lost)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
				askResponse: "messageResponse",
			}),
		)
	})

	it("sends messages normally when API request is complete (cost present)", async () => {
		const { getByTestId } = renderChatView()

		// Hydrate state with completed API request (cost present)
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now(),
					text: JSON.stringify({
						apiProtocol: "anthropic",
						cost: 0.05, // Cost present = streaming complete
						tokensIn: 100,
						tokensOut: 50,
					}),
				},
				{
					type: "say",
					say: "text",
					ts: Date.now(),
					text: "Response from API",
				},
			],
		})

		// Wait for state to be updated
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Clear message calls before simulating user input
		vi.mocked(vscode.postMessage).mockClear()

		// Simulate user sending a message when API is done
		const chatTextArea = getByTestId("chat-textarea")
		const input = chatTextArea.querySelector("input")! as HTMLInputElement

		await act(async () => {
			// Use fireEvent to properly trigger React's onChange handler
			fireEvent.change(input, { target: { value: "follow-up after completion" } })

			// Simulate pressing Enter to send
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		// Verify that the message was sent as askResponse, not queued
		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "askResponse",
				askResponse: "messageResponse",
				text: "follow-up after completion",
				images: [],
			})
		})

		// Verify it was NOT queued
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "queueMessage",
			}),
		)
	})

	it("preserves message order when messages sent during queue drain", async () => {
		const { getByTestId } = renderChatView()

		// Hydrate state with API request in progress and existing queue
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now(),
					text: JSON.stringify({ apiProtocol: "anthropic" }), // No cost = still streaming
				},
			],
			messageQueue: [
				{ id: "msg1", text: "queued message 1", images: [] },
				{ id: "msg2", text: "queued message 2", images: [] },
			],
		})

		// Wait for state to be updated
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Clear message calls before simulating user input
		vi.mocked(vscode.postMessage).mockClear()

		// Simulate user sending a new message while queue has items
		const chatTextArea = getByTestId("chat-textarea")
		const input = chatTextArea.querySelector("input")! as HTMLInputElement

		await act(async () => {
			fireEvent.change(input, { target: { value: "message during queue drain" } })
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		// Verify that the new message was queued (not sent directly) to preserve order
		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "queueMessage",
				text: "message during queue drain",
				images: [],
			})
		})

		// Verify it was NOT sent as askResponse (which would break ordering)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
				askResponse: "messageResponse",
			}),
		)
	})
})

describe("ChatView - Context Condensing Indicator Tests", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	// kilocode_change start: preparation and condensation must never be conflated.
	const taskMessages: ClineMessage[] = [
		{ type: "say", say: "text", ts: 1000, text: "Initial task" },
		{ type: "say", say: "text", ts: 2000, text: "Working on the task" },
	]
	const dispatchProgress = async (type: string, taskId = "test-task-id", contextMemoryMode?: "task" | "standard") => {
		await act(async () => {
			window.dispatchEvent(new MessageEvent("message", { data: { type, text: taskId, contextMemoryMode } }))
		})
	}
	const partialRows = (container: HTMLElement) =>
		Array.from(container.querySelectorAll('[data-testid="chat-row"]'))
			.map((row) => JSON.parse(row.textContent || "{}") as ClineMessage)
			.filter((message) => message.partial)

	it("shows preparation before compression and clears both indicators on response", async () => {
		const { container } = renderChatView()
		mockPostMessage({ clineMessages: taskMessages })
		await waitFor(() => expect(container.textContent).toContain("Working on the task"))

		await dispatchProgress("contextHandoffStarted")
		expect(partialRows(container).map((row) => row.say)).toEqual(["context_handoff"])

		await dispatchProgress("condenseTaskContextStarted")
		expect(partialRows(container).map((row) => row.say)).toEqual(["condense_context"])

		await dispatchProgress("condenseTaskContextResponse")
		expect(partialRows(container)).toEqual([])
	})

	it.each(["contextHandoffStarted", "condenseTaskContextStarted", "condenseTaskContextResponse"])(
		"ignores a late %s from the previous task without changing current manual progress",
		async (eventType) => {
			const { container } = renderChatView()
			mockPostMessage({
				clineMessages: taskMessages,
				currentTaskItem: { id: "previous-task", ts: 1000, task: "Initial task" },
				apiConfiguration: { apiProvider: "anthropic", intelligentTaskEnabled: true },
				taskDocumentSettings: { enabled: true, supported: true, fileName: "CURRENT_TASK.md" },
			})
			await waitFor(() => expect(container.textContent).toContain("Working on the task"))
			await dispatchProgress("contextHandoffStarted", "previous-task")
			expect(partialRows(container).map((row) => row.say)).toEqual(["context_handoff"])

			mockPostMessage({
				clineMessages: [
					{ type: "say", say: "text", ts: 4000, text: "Different task" },
					{ type: "say", say: "text", ts: 5000, text: "Different work" },
				],
				currentTaskItem: { id: "test-task-id", ts: 4000, task: "Different task" },
				apiConfiguration: { apiProvider: "anthropic", intelligentTaskEnabled: true },
				taskDocumentSettings: { enabled: true, supported: true, fileName: "CURRENT_TASK.md" },
			})
			await waitFor(() => expect(container.textContent).toContain("Different work"))
			expect(partialRows(container)).toEqual([])
			await dispatchProgress(eventType, "previous-task")
			expect(partialRows(container)).toEqual([])

			const button = container.querySelector("button:has(svg.lucide-fold-vertical)")
			expect(button).not.toBeNull()
			await act(async () => fireEvent.click(button!))
			expect(partialRows(container).map((row) => row.say)).toEqual(["context_handoff"])
			await dispatchProgress(eventType, "previous-task")
			expect(partialRows(container).map((row) => row.say)).toEqual(["context_handoff"])
			expect(container.querySelector("input[data-sending-disabled]")).toHaveAttribute(
				"data-sending-disabled",
				"true",
			)

			await dispatchProgress("condenseTaskContextResponse")
			expect(partialRows(container)).toEqual([])
			expect(container.querySelector("input[data-sending-disabled]")).toHaveAttribute(
				"data-sending-disabled",
				"false",
			)
		},
	)

	it("clears preparation when the file operation fails before compression", async () => {
		const { container } = renderChatView()
		mockPostMessage({ clineMessages: taskMessages })
		await waitFor(() => expect(container.textContent).toContain("Working on the task"))
		await dispatchProgress("contextHandoffStarted")
		expect(partialRows(container).map((row) => row.say)).toEqual(["context_handoff"])

		mockPostMessage({
			clineMessages: [
				...taskMessages,
				{ type: "say", say: "condense_context_error", ts: 3000, text: "Could not save continuation file" },
			],
		})
		await waitFor(() => expect(partialRows(container)).toEqual([]))
	})

	it("does not carry a live preparation indicator into another task", async () => {
		const { container } = renderChatView()
		mockPostMessage({ clineMessages: taskMessages })
		await waitFor(() => expect(container.textContent).toContain("Working on the task"))
		await dispatchProgress("contextHandoffStarted")

		mockPostMessage({
			clineMessages: [
				{ type: "say", say: "text", ts: 4000, text: "Different task" },
				{ type: "say", say: "text", ts: 5000, text: "Different work" },
			],
		})
		await waitFor(() => expect(container.textContent).toContain("Different work"))
		expect(partialRows(container)).toEqual([])
	})

	it.each([undefined, false])(
		"condenses without preparation while host support is unknown (%s)",
		async (intelligentTaskEnabled) => {
			const { container } = renderChatView()
			mockPostMessage({
				clineMessages: taskMessages,
				currentTaskItem: { id: "test-task-id", ts: 1000, task: "Initial task" },
				apiConfiguration: { apiProvider: "anthropic", intelligentTaskEnabled },
			})
			await waitFor(() => expect(container.textContent).toContain("Working on the task"))
			const button = container.querySelector("button:has(svg.lucide-fold-vertical)")
			expect(button).not.toBeNull()
			await act(async () => fireEvent.click(button!))

			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "condenseTaskContextRequest",
				text: "test-task-id",
			})
			expect(partialRows(container).map((row) => row.say)).toEqual(["condense_context"])
			await dispatchProgress("condenseTaskContextResponse")
			expect(partialRows(container)).toEqual([])
			expect(container.querySelector("input[data-sending-disabled]")).toHaveAttribute(
				"data-sending-disabled",
				"false",
			)
		},
	)

	// kilocode_change start: persistent task mode updates its file before showing compaction.
	it.each([true, false])(
		"prepares CURRENT_TASK.md on manual compression only on supported hosts (%s)",
		async (supported) => {
			const { container } = renderChatView()
			mockPostMessage({
				clineMessages: taskMessages,
				currentTaskItem: { id: "test-task-id", ts: 1000, task: "Initial task" },
				apiConfiguration: { apiProvider: "anthropic", intelligentTaskEnabled: true },
				taskDocumentSettings: { enabled: supported, supported, fileName: "CURRENT_TASK.md" },
			})
			await waitFor(() => expect(container.textContent).toContain("Working on the task"))
			const button = container.querySelector("button:has(svg.lucide-fold-vertical)")
			expect(button).not.toBeNull()
			expect(button).toHaveAttribute(
				"aria-label",
				supported ? "chat:task.condenseCurrentWorkNow" : "chat:task.condenseContext",
			)
			await act(async () => fireEvent.click(button!))
			const rows = partialRows(container)
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "condenseTaskContextRequest",
				text: "test-task-id",
				...(supported ? { contextMemoryMode: "task" } : {}),
			})
			expect(rows.map((row) => row.say)).toEqual([supported ? "context_handoff" : "condense_context"])
			if (supported) expect(JSON.parse(rows[0].text!)).toEqual({ phase: "preparing", path: "CURRENT_TASK.md" })
			await dispatchProgress("condenseTaskContextStarted")
			expect(partialRows(container).map((row) => row.say)).toEqual(["condense_context"])
		},
	)

	it.each([
		{ intelligentTaskEnabled: true, cachedEnabled: false, expectedMode: "task" },
		{ intelligentTaskEnabled: undefined, cachedEnabled: false, expectedMode: "task" },
		{ intelligentTaskEnabled: false, cachedEnabled: true, expectedMode: "standard" },
	])(
		"uses saved profile flags for manual mode $expectedMode even when derived settings are stale",
		async ({ intelligentTaskEnabled, cachedEnabled, expectedMode }) => {
			const { container } = renderChatView()
			mockPostMessage({
				clineMessages: taskMessages,
				currentTaskItem: { id: "test-task-id", ts: 1000, task: "Initial task" },
				apiConfiguration: { apiProvider: "anthropic", intelligentTaskEnabled },
				taskDocumentSettings: { enabled: cachedEnabled, supported: true, fileName: "CURRENT_TASK.md" },
			})
			await waitFor(() => expect(container.textContent).toContain("Working on the task"))
			const button = container.querySelector("button:has(svg.lucide-fold-vertical)")
			expect(button).not.toBeDisabled()
			await act(async () => fireEvent.click(button!))
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "condenseTaskContextRequest",
				text: "test-task-id",
				contextMemoryMode: expectedMode,
			})
			expect(partialRows(container).map((row) => row.say)).toEqual([
				expectedMode === "standard" ? "condense_context" : "context_handoff",
			])
		},
	)

	it("keeps preparation attached to its explicit backend mode across profile updates", async () => {
		const { container } = renderChatView()
		mockPostMessage({
			clineMessages: taskMessages,
			currentTaskItem: { id: "test-task-id", ts: 1000, task: "Initial task" },
			apiConfiguration: { apiProvider: "anthropic", intelligentTaskEnabled: false },
			taskDocumentSettings: { enabled: false, supported: true, fileName: "CURRENT_TASK.md" },
		})
		await waitFor(() => expect(container.textContent).toContain("Working on the task"))
		await dispatchProgress("contextHandoffStarted", "test-task-id", "task")
		expect(JSON.parse(partialRows(container)[0].text!)).toEqual({ phase: "preparing", path: "CURRENT_TASK.md" })
		mockPostMessage({
			clineMessages: taskMessages,
			apiConfiguration: { apiProvider: "anthropic", intelligentTaskEnabled: true },
		})
		await dispatchProgress("contextHandoffStarted", "test-task-id", "standard")
		expect(partialRows(container)[0].text).toBeUndefined()
		await dispatchProgress("contextHandoffStarted", "previous-task", "task")
		expect(partialRows(container)[0].text).toBeUndefined()
		await dispatchProgress("condenseTaskContextResponse")
		await dispatchProgress("contextHandoffStarted")
		expect(JSON.parse(partialRows(container)[0].text!)).toEqual({ phase: "preparing", path: "CURRENT_TASK.md" })
	})

	it("does not relabel a pending manual task-file operation when the saved profile changes", async () => {
		const { container } = renderChatView()
		mockPostMessage({
			clineMessages: taskMessages,
			currentTaskItem: { id: "test-task-id", ts: 1000, task: "Initial task" },
			apiConfiguration: { apiProvider: "anthropic", intelligentTaskEnabled: true },
			taskDocumentSettings: { enabled: true, supported: true, fileName: "CURRENT_TASK.md" },
		})
		await waitFor(() => expect(container.textContent).toContain("Working on the task"))
		const button = container.querySelector("button:has(svg.lucide-fold-vertical)")
		expect(button).not.toBeDisabled()
		await act(async () => fireEvent.click(button!))
		mockPostMessage({
			clineMessages: taskMessages,
			apiConfiguration: { apiProvider: "anthropic", intelligentTaskEnabled: false },
		})
		await waitFor(() => expect(button).toHaveAttribute("aria-label", "chat:task.condenseContext"))
		await dispatchProgress("contextHandoffStarted")
		expect(JSON.parse(partialRows(container)[0].text!)).toEqual({ phase: "preparing", path: "CURRENT_TASK.md" })
		await dispatchProgress("condenseTaskContextResponse")
		await dispatchProgress("contextHandoffStarted")
		expect(partialRows(container)[0].text).toBeUndefined()
	})

	it("identifies automatic persistent task preparation using the active profile", async () => {
		const { container } = renderChatView()
		mockPostMessage({
			clineMessages: taskMessages,
			apiConfiguration: {
				apiProvider: "anthropic",
				intelligentTaskEnabled: true,
			},
			taskDocumentSettings: { enabled: true, supported: true, fileName: "CURRENT_TASK.md" },
		})
		await waitFor(() => expect(container.textContent).toContain("Working on the task"))
		await dispatchProgress("contextHandoffStarted")
		expect(JSON.parse(partialRows(container)[0].text!)).toEqual({ phase: "preparing", path: "CURRENT_TASK.md" })
		await dispatchProgress("condenseTaskContextResponse")
		mockPostMessage({
			clineMessages: taskMessages,
			apiConfiguration: { apiProvider: "anthropic", intelligentTaskEnabled: false },
		})
		await waitFor(() => expect(container.textContent).toContain("Working on the task"))
		await dispatchProgress("contextHandoffStarted")
		expect(partialRows(container)[0].say).toBe("context_handoff")
		expect(partialRows(container)[0].text).toBeUndefined()
	})
	// kilocode_change end

	it("unlocks manual input on a terminal error row even if the response event is missing", async () => {
		const { container } = renderChatView()
		mockPostMessage({
			clineMessages: taskMessages,
			currentTaskItem: { id: "test-task-id", ts: 1000, task: "Initial task" },
		})
		await waitFor(() => expect(container.textContent).toContain("Working on the task"))
		const button = container.querySelector("button:has(svg.lucide-fold-vertical)")
		expect(button).not.toBeNull()
		await act(async () => fireEvent.click(button!))
		expect(container.querySelector("input[data-sending-disabled]")).toHaveAttribute("data-sending-disabled", "true")

		mockPostMessage({
			clineMessages: [
				...taskMessages,
				{ type: "say", say: "condense_context_error", ts: 3000, text: "Could not save continuation file" },
			],
		})
		await waitFor(() => expect(partialRows(container)).toEqual([]))
		expect(container.querySelector("input[data-sending-disabled]")).toHaveAttribute(
			"data-sending-disabled",
			"false",
		)
	})
	// kilocode_change end

	it("should add a condensing message to groupedMessages when isCondensing is true", async () => {
		// This test verifies that when the condenseTaskContextStarted message is received,
		// the isCondensing state is set to true and a synthetic condensing message is added
		// to the grouped messages list
		const { getByTestId, container } = renderChatView()

		// First hydrate state with an active task
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now() - 1000,
					text: JSON.stringify({ apiProtocol: "anthropic" }),
				},
			],
		})

		// Wait for component to render
		await waitFor(() => {
			expect(getByTestId("chat-view")).toBeInTheDocument()
		})

		// Allow time for useEvent hook to register message listener
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10))
		})

		// Dispatch a MessageEvent directly to trigger the message handler
		// This simulates the VSCode extension sending a message to the webview
		await act(async () => {
			const event = new MessageEvent("message", {
				data: {
					type: "condenseTaskContextStarted",
					text: "test-task-id",
				},
			})
			window.dispatchEvent(event)
			// Wait for React state updates
			await new Promise((resolve) => setTimeout(resolve, 0))
		})

		// Check that groupedMessages now includes a condensing message
		// With Virtuoso mocked, items render directly and we can find the ChatRow with partial condense_context message
		await waitFor(
			() => {
				const rows = container.querySelectorAll('[data-testid="chat-row"]')
				// Check for the actual message structure: partial condense_context message
				const condensingRow = Array.from(rows).find((row) => {
					const text = row.textContent || ""
					return text.includes('"say":"condense_context"') && text.includes('"partial":true')
				})
				expect(condensingRow).toBeTruthy()
			},
			{ timeout: 2000 },
		)
	})
})
