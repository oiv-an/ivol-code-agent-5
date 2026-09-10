import { fireEvent, render, screen } from "@/utils/test-utils"
import { DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT } from "@roo-code/types"
import english from "@/i18n/locales/en/settings.json" // kilocode_change
import russian from "@/i18n/locales/ru/settings.json" // kilocode_change

import PromptsSettings from "../PromptsSettings"

const mocks = vi.hoisted(() => ({
	extensionState: {} as any,
	postMessage: vi.fn(),
}))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mocks.extensionState,
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: mocks.postMessage },
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) =>
			key === "prompts:supportPrompts.condense.intelligentContextReset.label"
				? "Интеллектуальный сброс контекста"
				: key,
	}),
}))

vi.mock("@src/components/ui", async () => {
	const ReactModule = await vi.importActual<typeof import("react")>("react")
	const SelectContext = ReactModule.createContext<((value: string) => void) | undefined>(undefined)

	return {
		Button: ({ children, onClick, ...props }: any) => (
			<button onClick={onClick} {...props}>
				{children}
			</button>
		),
		Select: ({ children, onValueChange }: any) => (
			<SelectContext.Provider value={onValueChange}>
				<div>{children}</div>
			</SelectContext.Provider>
		),
		SelectContent: ({ children }: any) => <div>{children}</div>,
		SelectItem: ({ children, value, ...props }: any) => {
			const onValueChange = ReactModule.useContext(SelectContext)
			return (
				<button onClick={() => onValueChange?.(value)} {...props}>
					{children}
				</button>
			)
		},
		SelectTrigger: ({ children, ...props }: any) => <div {...props}>{children}</div>,
		SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
		StandardTooltip: ({ children }: any) => <div>{children}</div>,
	}
})

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	// kilocode_change: honor disabled draft-only controls.
	VSCodeCheckbox: ({ children, checked, disabled, onChange, "data-testid": dataTestId }: any) => (
		<label data-testid={dataTestId}>
			<input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
			{children}
		</label>
	),
	VSCodeTextArea: ({ value, onInput, onChange, "data-testid": dataTestId, ...props }: any) => (
		<textarea
			value={value}
			onChange={(event) => {
				onInput?.(event)
				onChange?.(event)
			}}
			data-testid={dataTestId}
			{...props}
		/>
	),
}))

describe("PromptsSettings intelligent context reset", () => {
	const setApiConfiguration = vi.fn()
	const setIntelligentContextResetPrompt = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
		mocks.extensionState = {
			listApiConfigMeta: [],
			enhancementApiConfigId: "",
			setEnhancementApiConfigId: vi.fn(),
			condensingApiConfigId: "",
			setCondensingApiConfigId: vi.fn(),
			customCondensingPrompt: undefined,
			setCustomCondensingPrompt: vi.fn(),
			apiConfiguration: { apiProvider: "openai" },
			currentApiConfigName: "My provider",
			setApiConfiguration,
			intelligentContextResetPrompt: undefined,
			setIntelligentContextResetPrompt,
			includeTaskHistoryInEnhance: true,
			setIncludeTaskHistoryInEnhance: vi.fn(),
		}
	})

	function renderCondenseSettings() {
		render(<PromptsSettings customSupportPrompts={{}} setCustomSupportPrompts={vi.fn()} />)
		fireEvent.click(screen.getByTestId("CONDENSE-option"))
	}

	it("defaults to enabled and shows the complete editable prompt for existing installations", () => {
		renderCondenseSettings()

		const checkbox = screen.getByTestId("intelligent-context-reset-checkbox").querySelector("input")!
		expect(checkbox).toBeChecked()
		expect(screen.getByText("Интеллектуальный сброс контекста")).toBeInTheDocument()
		expect(screen.getByTestId("intelligent-context-reset-prompt")).toHaveValue(
			DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT,
		)
	})

	it("saves the checkbox in the provider profile while keeping the prompt shared", () => {
		renderCondenseSettings()

		fireEvent.click(screen.getByTestId("intelligent-context-reset-checkbox").querySelector("input")!)
		expect(setApiConfiguration).toHaveBeenCalledWith({
			apiProvider: "openai",
			intelligentContextResetEnabled: false,
		})
		expect(mocks.postMessage).toHaveBeenCalledWith({
			type: "upsertApiConfiguration",
			text: "My provider",
			apiConfiguration: { apiProvider: "openai", intelligentContextResetEnabled: false },
		})

		fireEvent.change(screen.getByTestId("intelligent-context-reset-prompt"), {
			target: { value: "Preserve every implementation detail" },
		})
		expect(setIntelligentContextResetPrompt).toHaveBeenCalledWith("Preserve every implementation detail")
		expect(mocks.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { intelligentContextResetPrompt: "Preserve every implementation detail" },
		})
	})

	it("hides the snapshot prompt when intelligent reset is disabled", () => {
		mocks.extensionState.apiConfiguration.intelligentContextResetEnabled = false
		renderCondenseSettings()

		expect(screen.getByTestId("intelligent-context-reset-checkbox").querySelector("input")).not.toBeChecked()
		expect(screen.queryByTestId("intelligent-context-reset-prompt")).not.toBeInTheDocument()
	})

	it("uses the editing profile rather than the active profile and defers saving to SettingsView", () => {
		const onChange = vi.fn()
		mocks.extensionState.apiConfiguration.intelligentContextResetEnabled = true
		render(
			<PromptsSettings
				customSupportPrompts={{}}
				setCustomSupportPrompts={vi.fn()}
				intelligentContextResetEnabled={false}
				onIntelligentContextResetEnabledChange={onChange}
			/>,
		)
		fireEvent.click(screen.getByTestId("CONDENSE-option"))
		const checkbox = screen.getByTestId("intelligent-context-reset-checkbox").querySelector("input")!
		expect(checkbox).not.toBeChecked()
		fireEvent.click(checkbox)
		expect(onChange).toHaveBeenCalledWith(true)
		expect(setApiConfiguration).not.toHaveBeenCalled()
		expect(mocks.postMessage).not.toHaveBeenCalled()
	})

	it("opens and focuses the intelligent prompt directly even for a disabled profile", () => {
		// The shared test setup replaces DOM focus with a no-op for FAST components.
		const focus = vi.fn()
		const prototypeWithFocusGetter: { readonly focus: unknown } = HTMLElement.prototype
		const focusGetter = vi.spyOn(prototypeWithFocusGetter, "focus", "get").mockReturnValue(focus)
		render(
			<PromptsSettings
				customSupportPrompts={{}}
				setCustomSupportPrompts={vi.fn()}
				intelligentContextResetEnabled={false}
				onIntelligentContextResetEnabledChange={vi.fn()}
				focusIntelligentContextResetPrompt
			/>,
		)
		expect(screen.getByTestId("intelligent-context-reset-checkbox").querySelector("input")).not.toBeChecked()
		expect(focus.mock.contexts).toContain(screen.getByTestId("intelligent-context-reset-prompt"))
		expect(focus).toHaveBeenCalledWith({ preventScroll: true })
		expect(screen.getByTestId("intelligent-context-reset-prompt")).toHaveValue(
			DEFAULT_INTELLIGENT_CONTEXT_RESET_PROMPT,
		)
		expect(mocks.postMessage).not.toHaveBeenCalled()
		focusGetter.mockRestore()
	})

	// kilocode_change start: preserve profile drafts and mutually exclusive modes on the second settings surface.
	it("hides intelligent task until the host explicitly supports it", () => {
		renderCondenseSettings()
		expect(screen.queryByTestId("intelligent-task-checkbox")).not.toBeInTheDocument()
		expect(mocks.postMessage).not.toHaveBeenCalled()
	})

	it("preserves the legacy profile update shape when the host does not support intelligent task", () => {
		mocks.extensionState.taskDocumentSettings = { supported: false }
		mocks.extensionState.apiConfiguration = { apiProvider: "openai", intelligentContextResetEnabled: false }
		renderCondenseSettings()
		fireEvent.click(screen.getByTestId("intelligent-context-reset-checkbox").querySelector("input")!)
		expect(setApiConfiguration).toHaveBeenCalledWith({
			apiProvider: "openai",
			intelligentContextResetEnabled: true,
		})
		expect(mocks.postMessage).toHaveBeenCalledWith({
			type: "upsertApiConfiguration",
			text: "My provider",
			apiConfiguration: { apiProvider: "openai", intelligentContextResetEnabled: true },
		})
	})

	it("enables task mode atomically on the active profile when used outside SettingsView", () => {
		mocks.extensionState.taskDocumentSettings = { supported: true }
		renderCondenseSettings()
		expect(screen.getByTestId("intelligent-task-checkbox").querySelector("input")).not.toBeChecked()
		fireEvent.click(screen.getByTestId("intelligent-task-checkbox").querySelector("input")!)
		expect(setApiConfiguration).toHaveBeenCalledTimes(1)
		expect(setApiConfiguration).toHaveBeenCalledWith({
			apiProvider: "openai",
			intelligentTaskEnabled: true,
			intelligentContextResetEnabled: false,
		})
		expect(mocks.postMessage).toHaveBeenCalledTimes(1)
		expect(mocks.postMessage).toHaveBeenCalledWith({
			type: "upsertApiConfiguration",
			text: "My provider",
			apiConfiguration: {
				apiProvider: "openai",
				intelligentTaskEnabled: true,
				intelligentContextResetEnabled: false,
			},
		})
	})

	it("shows task mode for conflicting imported flags and switches back to context reset atomically", () => {
		mocks.extensionState.taskDocumentSettings = { supported: true }
		mocks.extensionState.apiConfiguration = {
			apiProvider: "openai",
			intelligentContextResetEnabled: true,
			intelligentTaskEnabled: true,
		}
		renderCondenseSettings()
		expect(screen.getByTestId("intelligent-task-checkbox").querySelector("input")).toBeChecked()
		expect(screen.getByTestId("intelligent-context-reset-checkbox").querySelector("input")).not.toBeChecked()
		expect(screen.queryByTestId("intelligent-context-reset-prompt")).not.toBeInTheDocument()
		fireEvent.click(screen.getByTestId("intelligent-context-reset-checkbox").querySelector("input")!)
		expect(setApiConfiguration).toHaveBeenCalledTimes(1)
		expect(setApiConfiguration).toHaveBeenCalledWith({
			apiProvider: "openai",
			intelligentContextResetEnabled: true,
			intelligentTaskEnabled: false,
		})
		expect(mocks.postMessage).toHaveBeenCalledTimes(1)
	})

	it("takes both flags from the editing profile and stages changes without touching the active profile", () => {
		const onContextChange = vi.fn()
		const onTaskChange = vi.fn()
		mocks.extensionState.taskDocumentSettings = { supported: true }
		mocks.extensionState.apiConfiguration = { apiProvider: "openai", intelligentTaskEnabled: true }
		render(
			<PromptsSettings
				customSupportPrompts={{}}
				setCustomSupportPrompts={vi.fn()}
				intelligentContextResetEnabled={true}
				intelligentTaskEnabled={false}
				onIntelligentContextResetEnabledChange={onContextChange}
				onIntelligentTaskEnabledChange={onTaskChange}
			/>,
		)
		fireEvent.click(screen.getByTestId("CONDENSE-option"))
		expect(screen.getByTestId("intelligent-context-reset-checkbox").querySelector("input")).toBeChecked()
		expect(screen.getByTestId("intelligent-task-checkbox").querySelector("input")).not.toBeChecked()
		fireEvent.click(screen.getByTestId("intelligent-task-checkbox").querySelector("input")!)
		expect(onContextChange).toHaveBeenCalledTimes(1)
		expect(onContextChange).toHaveBeenCalledWith(false)
		expect(onTaskChange).toHaveBeenCalledTimes(1)
		expect(onTaskChange).toHaveBeenCalledWith(true)
		expect(setApiConfiguration).not.toHaveBeenCalled()
		expect(mocks.postMessage).not.toHaveBeenCalled()
	})

	it("turns off the editing profile task flag before staging context reset", () => {
		const onContextChange = vi.fn()
		const onTaskChange = vi.fn()
		mocks.extensionState.taskDocumentSettings = { supported: true }
		render(
			<PromptsSettings
				customSupportPrompts={{}}
				setCustomSupportPrompts={vi.fn()}
				intelligentContextResetEnabled={false}
				intelligentTaskEnabled={true}
				onIntelligentContextResetEnabledChange={onContextChange}
				onIntelligentTaskEnabledChange={onTaskChange}
			/>,
		)
		fireEvent.click(screen.getByTestId("CONDENSE-option"))
		fireEvent.click(screen.getByTestId("intelligent-context-reset-checkbox").querySelector("input")!)
		expect(onTaskChange).toHaveBeenCalledTimes(1)
		expect(onTaskChange).toHaveBeenCalledWith(false)
		expect(onContextChange).toHaveBeenCalledTimes(1)
		expect(onContextChange).toHaveBeenCalledWith(true)
		expect(mocks.postMessage).not.toHaveBeenCalled()
	})

	it("can disable task mode without enabling context reset", () => {
		mocks.extensionState.taskDocumentSettings = { supported: true }
		mocks.extensionState.apiConfiguration = {
			apiProvider: "openai",
			intelligentTaskEnabled: true,
			intelligentContextResetEnabled: false,
		}
		renderCondenseSettings()
		fireEvent.click(screen.getByTestId("intelligent-task-checkbox").querySelector("input")!)
		expect(setApiConfiguration).toHaveBeenCalledTimes(1)
		expect(setApiConfiguration).toHaveBeenCalledWith({
			apiProvider: "openai",
			intelligentTaskEnabled: false,
			intelligentContextResetEnabled: false,
		})
	})

	it("does not save an editing-profile toggle to the active profile if its draft callback is absent", () => {
		mocks.extensionState.taskDocumentSettings = { supported: true }
		render(
			<PromptsSettings
				customSupportPrompts={{}}
				setCustomSupportPrompts={vi.fn()}
				onIntelligentContextResetEnabledChange={vi.fn()}
			/>,
		)
		fireEvent.click(screen.getByTestId("CONDENSE-option"))
		expect(screen.getByTestId("intelligent-task-checkbox").querySelector("input")).toBeDisabled()
		fireEvent.click(screen.getByTestId("intelligent-task-checkbox").querySelector("input")!)
		expect(setApiConfiguration).not.toHaveBeenCalled()
		expect(mocks.postMessage).not.toHaveBeenCalled()
	})

	it("keeps English and Russian experimental explanations aligned across supported editions", () => {
		expect(Object.keys(russian.intelligentTask).sort()).toEqual(Object.keys(english.intelligentTask).sort())
		for (const product of ["VS Code", "PhpStorm", "IntelliJ IDEA", "PyCharm"]) {
			expect(english.intelligentTask.scope).toContain(product)
			expect(russian.intelligentTask.scope).toContain(product)
		}
		expect(english.intelligentTask.scope).toContain("Off by default")
		expect(russian.intelligentTask.scope).toContain("По умолчанию выключено")
		for (const key of Object.keys(english.intelligentTask) as Array<keyof typeof english.intelligentTask>) {
			expect(russian.intelligentTask[key].match(/{{\w+}}/g) ?? []).toEqual(
				english.intelligentTask[key].match(/{{\w+}}/g) ?? [],
			)
		}
	})
	// kilocode_change end
})
