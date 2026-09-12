// kilocode_change - new file
import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import PromptsSettings from "../PromptsSettings"

const state = vi.hoisted(() => ({
	apiConfiguration: { intelligentTaskEnabled: false },
	taskDocumentSettings: { supported: true } as { supported: boolean } | undefined,
	setApiConfiguration: vi.fn(),
}))
vi.mock("@src/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("../SearchableSetting", () => ({ SearchableSetting: ({ children }: any) => <div>{children}</div> }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextArea: () => <textarea />,
	VSCodeCheckbox: ({ children, checked, onChange, ...props }: any) => (
		<label>
			<input {...props} type="checkbox" checked={checked} onChange={onChange} />
			{children}
		</label>
	),
}))
vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
	Select: ({ children, onValueChange }: any) => (
		<div>
			<button onClick={() => onValueChange("CONDENSE")}>condense</button>
			{children}
		</div>
	),
	SelectContent: ({ children }: any) => <div>{children}</div>,
	SelectItem: () => null,
	SelectTrigger: () => null,
	SelectValue: () => null,
	StandardTooltip: ({ children }: any) => <div>{children}</div>,
}))

describe("Current Task draft profile preference", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		state.taskDocumentSettings = { supported: true }
	})

	function show(props = {}) {
		const result = render(
			<PromptsSettings customSupportPrompts={{}} setCustomSupportPrompts={vi.fn()} {...props} />,
		)
		fireEvent.click(screen.getAllByText("condense")[0])
		return result
	}

	it("uses an unspecified draft's default instead of the active profile's explicit opt-out", () => {
		const onIntelligentTaskEnabledChange = vi.fn()
		show({ intelligentTaskEnabled: undefined, onIntelligentTaskEnabledChange })
		const checkbox = screen.getByTestId("intelligent-task-checkbox")
		expect(checkbox).toBeChecked()
		expect(onIntelligentTaskEnabledChange).not.toHaveBeenCalled()
		fireEvent.click(checkbox)
		expect(onIntelligentTaskEnabledChange).toHaveBeenCalledWith(false)
		expect(state.setApiConfiguration).not.toHaveBeenCalled()
	})

	it("retains an explicit draft opt-out", () => {
		show({ intelligentTaskEnabled: false, onIntelligentTaskEnabledChange: vi.fn() })
		expect(screen.getByTestId("intelligent-task-checkbox")).not.toBeChecked()
	})

	it("uses the active profile only when no draft editor is supplied", () => {
		show()
		expect(screen.getByTestId("intelligent-task-checkbox")).not.toBeChecked()
	})

	it.each([false, undefined])("does not infer support from a default preference (%s)", (supported) => {
		state.taskDocumentSettings = supported === undefined ? undefined : { supported }
		show({ onIntelligentTaskEnabledChange: vi.fn() })
		expect(screen.queryByTestId("intelligent-task-checkbox")).not.toBeInTheDocument()
	})
})
