// kilocode_change - new file
import { act, fireEvent, render, screen } from "@testing-library/react"
import { vscode } from "@src/utils/vscode"
import { ProjectTaskStorageSettings } from "../ProjectTaskStorageSettings"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
function respond(extra: Record<string, unknown> = {}) {
	act(() =>
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "projectTaskStorage",
					projectTaskStorage: {
						workspace: "/project",
						enabled: false,
						hide: true,
						busy: false,
						tasksToCopy: 1,
						...extra,
					},
				},
			}),
		),
	)
}
beforeEach(() => vi.clearAllMocks())

describe("project task storage settings", () => {
	it("loads settings and only enables local storage on explicit interaction", () => {
		render(<ProjectTaskStorageSettings />)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "getProjectTaskStorage" })
		respond()
		fireEvent.click(screen.getByLabelText("settings:projectTaskStorage.enabled"))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "setProjectTaskStorage",
			projectTaskStorage: { enabled: true, hide: true },
		})
	})
	it("keeps copying separate from enabling and displays backend failures", () => {
		render(<ProjectTaskStorageSettings />)
		respond({ enabled: true })
		fireEvent.click(screen.getByText("settings:projectTaskStorage.copy"))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "copyTasksToProject" })
		respond({ enabled: true, error: "Permission denied" })
		expect(screen.getByRole("alert").textContent).toBe("Permission denied")
	})
	it("blocks mutation while a task is open", () => {
		render(<ProjectTaskStorageSettings />)
		respond({ enabled: true, busy: true })
		expect(screen.getByLabelText("settings:projectTaskStorage.enabled")).toBeDisabled()
		expect(screen.getByLabelText("settings:projectTaskStorage.hide")).toBeDisabled()
		expect(screen.getByText("settings:projectTaskStorage.copy")).toBeDisabled()
	})
})

it("hides copy controls for empty or fully local projects", () => {
	render(<ProjectTaskStorageSettings />)
	respond({ enabled: true, tasksToCopy: 0 })
	expect(screen.queryByText("settings:projectTaskStorage.copy")).toBeNull()
	expect(screen.queryByText("settings:projectTaskStorage.copyHint")).toBeNull()
	respond({ enabled: true, tasksToCopy: 2 })
	expect(screen.getByText("settings:projectTaskStorage.copy")).toBeVisible()
	respond({ enabled: true, tasksToCopy: 0, copied: 2 })
	expect(screen.queryByText("settings:projectTaskStorage.copy")).toBeNull()
})
