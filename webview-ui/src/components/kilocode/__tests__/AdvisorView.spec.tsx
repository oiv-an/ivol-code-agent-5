import { act, fireEvent, render as baseRender, screen } from "@testing-library/react"
import type { AdvisorState } from "@roo-code/types"
import { vscode } from "@src/utils/vscode"
import AdvisorView from "../AdvisorView"
import { AdvisorProvider, useAdvisor } from "../AdvisorContext"
import BottomButton from "../BottomButton"
import type { ReactElement } from "react"
const render = (ui: ReactElement) => baseRender(ui, { wrapper: AdvisorProvider })

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
const state: AdvisorState = {
	workspace: "file:///project",
	platformSupported: true,
	canScan: true,
	entries: [
		{
			id: "redhat.java",
			name: "Java",
			version: "1",
			active: true,
		},
	],
}
const ai = {
	model: "current-model",
	recommendations: [{ id: "redhat.java", reason: "Optional IDE support", loss: "Java completion" }],
	usage: { inputTokens: 100, outputTokens: 20 },
	complete: false,
	files: 12,
	inventoryCount: 1,
}
function publish(
	value: AdvisorState,
	id = (vi.mocked(vscode.postMessage).mock.calls.at(-1)![0] as { advisorRequestId?: string }).advisorRequestId,
) {
	act(() =>
		window.dispatchEvent(
			new MessageEvent("message", { data: { type: "advisorState", advisorState: value, advisorRequestId: id } }),
		),
	)
}
beforeEach(() => vi.clearAllMocks())
it("renders the compiler-safe initial state and scans only on request", () => {
	render(<AdvisorView onDone={vi.fn()} />)
	expect(vscode.postMessage).toHaveBeenCalledTimes(1)
	publish(state)
	expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
	fireEvent.click(screen.getByText("common:advisor.scan"))
	expect(vscode.postMessage).toHaveBeenLastCalledWith({
		type: "startAdvisorCheck",
		advisorRequestId: expect.any(String),
	})
	publish({ ...state, ai })
	expect(screen.getByText("Optional IDE support")).toBeInTheDocument()
	expect(screen.getByText(/Java completion/)).toBeInTheDocument()
	expect(screen.getByText("common:advisor.aiUsage")).toBeInTheDocument()
	expect(screen.getByText("common:advisor.analysisIncomplete")).toBeInTheDocument()
})
it("opens the exact ID without writes and preserves recommendations after the reply", () => {
	render(<AdvisorView onDone={vi.fn()} />)
	publish(state)
	fireEvent.click(screen.getByText("common:advisor.scan"))
	publish({ ...state, ai })
	fireEvent.click(screen.getByText("common:advisor.openExtension"))
	expect(vscode.postMessage).toHaveBeenLastCalledWith({
		type: "openAdvisorExtension",
		advisorExtensionId: "redhat.java",
		advisorRequestId: expect.any(String),
	})
	publish(state)
	expect(screen.getByText("Optional IDE support")).toBeInTheDocument()
	expect(vi.mocked(vscode.postMessage).mock.calls.map(([message]) => message.type)).toEqual([
		"getAdvisorState",
		"startAdvisorCheck",
		"openAdvisorExtension",
	])
})
it("shows workspace-disabled IDs independently of the public inventory and refreshes without AI or writes", () => {
	render(<AdvisorView onDone={vi.fn()} />)
	publish(state)
	fireEvent.click(screen.getByText("common:advisor.showWorkspaceDisabled"))
	publish({ ...state, workspaceDisabled: { status: "available", entries: [{ id: "vue.volar", name: "Vue" }] } })
	expect(screen.getByText("Vue")).toBeInTheDocument()
	expect(screen.getByText("vue.volar")).toBeInTheDocument()
	fireEvent.click(screen.getByText("common:advisor.openExtension"))
	expect(vscode.postMessage).toHaveBeenLastCalledWith(
		expect.objectContaining({ type: "openAdvisorExtension", advisorExtensionId: "vue.volar" }),
	)
	publish(state)
	fireEvent.click(screen.getByText("common:advisor.refreshDisabled"))
	expect(vscode.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: "getAdvisorState" }))
	publish({ ...state, workspaceDisabled: { status: "unsupported", entries: [], reason: "Unsupported version" } })
	expect(screen.getByText("common:advisor.workspaceDisabledUnsupported")).toBeInTheDocument()
	expect(screen.queryByText("common:advisor.workspaceDisabledEmpty")).not.toBeInTheDocument()
	expect(
		vi
			.mocked(vscode.postMessage)
			.mock.calls.every(([message]) => ["getAdvisorState", "openAdvisorExtension"].includes(message.type)),
	).toBe(true)
})
it("offers only scan and workspace inspection, without legacy controls or confirmation", () => {
	render(<AdvisorView onDone={vi.fn()} />)
	publish(state)
	expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
		"common:advisor.back",
		"common:advisor.scan",
		"common:advisor.showWorkspaceDisabled",
	])
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
	expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
})
it("cancels using the active request ID and displays errors", () => {
	render(<AdvisorView onDone={vi.fn()} />)
	publish(state)
	fireEvent.click(screen.getByText("common:advisor.scan"))
	const id = (vi.mocked(vscode.postMessage).mock.calls.at(-1)![0] as { advisorRequestId?: string }).advisorRequestId
	fireEvent.click(screen.getByText("common:answers.cancel"))
	expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "cancelAdvisorCheck", advisorRequestId: id })
	publish({ ...state, ai: { ...ai, recommendations: [], error: "Advisor cancelled", cancelled: true } }, id)
	expect(screen.getByRole("alert")).toHaveTextContent("Advisor cancelled")
	expect(screen.getByText("common:advisor.scan")).not.toBeDisabled()
})
it("times out, requests cancellation and ignores stale responses", () => {
	vi.useFakeTimers()
	try {
		render(<AdvisorView onDone={vi.fn()} />)
		publish(state)
		fireEvent.click(screen.getByText("common:advisor.scan"))
		const id = (vi.mocked(vscode.postMessage).mock.calls.at(-1)![0] as { advisorRequestId?: string })
			.advisorRequestId
		publish({ ...state, ai }, "old")
		expect(screen.queryByText("Optional IDE support")).not.toBeInTheDocument()
		act(() => vi.advanceTimersByTime(100000))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "cancelAdvisorCheck", advisorRequestId: id })
		publish({ ...state, ai }, id)
		expect(screen.queryByText("Optional IDE support")).not.toBeInTheDocument()
		expect(screen.getByRole("alert")).toHaveTextContent("common:advisor.aiTimeout")
	} finally {
		vi.useRealTimers()
	}
})
it("cancels on unmount", () => {
	const view = render(<AdvisorView onDone={vi.fn()} />)
	publish(state)
	fireEvent.click(screen.getByText("common:advisor.scan"))
	view.unmount()
	expect(vscode.postMessage).toHaveBeenLastCalledWith({
		type: "cancelAdvisorCheck",
		advisorRequestId: expect.any(String),
	})
})
it("does not simulate native extension actions on JetBrains", () => {
	render(<AdvisorView onDone={vi.fn()} />)
	publish({ ...state, platformSupported: false, canScan: false, entries: [] })
	expect(screen.getByText("common:advisor.aiPlatform")).toBeInTheDocument()
	expect(screen.getByText("common:advisor.scan")).toBeDisabled()
})
it("filters recommendations by ID without sending requests", () => {
	render(<AdvisorView onDone={vi.fn()} />)
	publish(state)
	fireEvent.click(screen.getByText("common:advisor.scan"))
	publish({ ...state, ai })
	fireEvent.change(screen.getByRole("searchbox"), { target: { value: "no-match" } })
	expect(screen.queryByText("Optional IDE support")).not.toBeInTheDocument()
	fireEvent.change(screen.getByRole("searchbox"), { target: { value: "redhat.java" } })
	expect(screen.getByText("Optional IDE support")).toBeInTheDocument()
	expect(vscode.postMessage).toHaveBeenCalledTimes(2)
})

function LampProbe() {
	const { unread, checking, hasStarted } = useAdvisor()
	if (!hasStarted) return null
	return (
		<BottomButton
			iconClass="codicon-lightbulb"
			highlighted={unread}
			ariaLabel={checking ? "running" : unread ? "ready" : "idle"}
			onClick={() => {}}
		/>
	)
}
it("continues in background, notifies once and retains results across navigation", () => {
	const view = render(
		<>
			<LampProbe />
			<AdvisorView onDone={vi.fn()} />
		</>,
	)
	expect(screen.queryByRole("button", { name: "idle" })).not.toBeInTheDocument()
	publish(state)
	expect(screen.queryByRole("button", { name: "idle" })).not.toBeInTheDocument()
	fireEvent.click(screen.getByText("common:advisor.scan"))
	const id = (vi.mocked(vscode.postMessage).mock.calls.at(-1)![0] as { advisorRequestId: string }).advisorRequestId
	view.rerender(<LampProbe />)
	expect(screen.getByRole("button", { name: "running" })).toBeInTheDocument()
	expect(vscode.postMessage).toHaveBeenCalledTimes(2)
	view.rerender(
		<>
			<LampProbe />
			<AdvisorView onDone={vi.fn()} />
		</>,
	)
	expect(screen.getByText("common:advisor.loading")).toBeDisabled()
	expect(vscode.postMessage).toHaveBeenCalledTimes(2)
	view.rerender(<LampProbe />)
	publish({ ...state, ai }, id)
	expect(screen.getByRole("button", { name: "ready" })).toHaveClass("text-yellow-400")
	expect(screen.getByText("common:advisor.ready")).toBeInTheDocument()
	fireEvent.click(screen.getByText("common:advisor.dismissNotice"))
	expect(screen.getByRole("button", { name: "ready" })).toBeInTheDocument()
	view.rerender(
		<>
			<LampProbe />
			<AdvisorView onDone={vi.fn()} />
		</>,
	)
	expect(screen.getByRole("button", { name: "idle" })).not.toHaveClass("text-yellow-400")
	expect(screen.getByText("Optional IDE support")).toBeInTheDocument()
	expect(vscode.postMessage).toHaveBeenCalledTimes(2)
	publish({ ...state, ai }, id)
	expect(screen.queryByText("common:advisor.ready")).not.toBeInTheDocument()
})
it.each([false, true])("does not light up or notify success for failed/cancelled scans (%s)", (cancelled) => {
	const view = render(
		<>
			<LampProbe />
			<AdvisorView onDone={vi.fn()} />
		</>,
	)
	publish(state)
	fireEvent.click(screen.getByText("common:advisor.scan"))
	view.rerender(<LampProbe />)
	publish({ ...state, ai: { ...ai, error: "Analysis failed", cancelled } })
	expect(screen.getByRole("button", { name: "idle" })).toBeInTheDocument()
	expect(screen.queryByText("common:advisor.ready")).not.toBeInTheDocument()
})
