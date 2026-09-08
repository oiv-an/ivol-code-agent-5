// kilocode_change - new file
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react"
import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"
import { YoloModeControls } from "../YoloModeControls"
import { useYoloModeState } from "@/hooks/useYoloModeState"
import { useAutoApprovalState } from "@/hooks/useAutoApprovalState"

const { state } = vi.hoisted(() => ({ state: {} as Partial<ExtensionStateContextType> }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, values?: { remaining?: string }) => key + (values?.remaining ? ` ${values.remaining}` : ""),
	}),
}))

describe("YOLO timer controls", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-09-07T12:00:00Z"))
		Object.keys(state).forEach((key) => delete state[key as keyof ExtensionStateContextType])
		state.yoloMode = false
		vi.clearAllMocks()
	})
	afterEach(() => {
		cleanup()
		vi.useRealTimers()
	})

	it("defaults to one hour and never grants or renews permission on mount", () => {
		render(<YoloModeControls />)
		expect(screen.getByRole("spinbutton")).toHaveValue(60)
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(screen.getByTestId("yolo-mode-status")).toHaveTextContent("settings:yoloTimer.inactive")
	})

	it("starts only an explicit timer and waits for authoritative state", () => {
		const { rerender } = render(<YoloModeControls />)
		fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "90" } })
		fireEvent.click(screen.getByText("settings:yoloTimer.start"))
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "startYoloModeTimer", value: 90 })
		expect(screen.getByTestId("yolo-mode-status")).toHaveTextContent("settings:yoloTimer.inactive")
		expect(screen.getByText("settings:yoloTimer.start")).toBeDisabled()
		state.yoloMode = true
		state.yoloModeExpiresAt = Date.now() + 90 * 60000
		rerender(<YoloModeControls />)
		expect(screen.getByTestId("yolo-mode-status")).toHaveTextContent("01:30:00")
		expect(screen.getByText("settings:yoloTimer.restart")).toBeEnabled()
	})

	it.each(["", "0", "-1", "1.5", "1441"])("rejects invalid duration %s", (value) => {
		render(<YoloModeControls />)
		fireEvent.change(screen.getByRole("spinbutton"), { target: { value } })
		expect(screen.getByText("settings:yoloTimer.start")).toBeDisabled()
		expect(screen.getByRole("alert")).toHaveTextContent("settings:yoloTimer.invalidMinutes")
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it.each([1, 1440])("accepts duration boundary %i", (value) => {
		render(<YoloModeControls />)
		fireEvent.change(screen.getByRole("spinbutton"), { target: { value: String(value) } })
		fireEvent.click(screen.getByText("settings:yoloTimer.start"))
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "startYoloModeTimer", value })
	})

	it("expires visually without granting ordinary rules or sending backend tick messages", () => {
		state.yoloMode = true
		state.yoloModeExpiresAt = Date.now() + 2000
		render(<YoloModeControls />)
		act(() => vi.advanceTimersByTime(1000))
		expect(screen.getByTestId("yolo-mode-status")).toHaveTextContent("00:00:01")
		act(() => vi.advanceTimersByTime(1000))
		expect(screen.getByTestId("yolo-mode-status")).toHaveTextContent("settings:yoloTimer.expired")
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("allows explicit early stop without altering ordinary approval preferences", () => {
		state.yoloMode = true
		state.yoloModeExpiresAt = Date.now() + 60000
		render(<YoloModeControls />)
		fireEvent.click(screen.getByText("settings:yoloTimer.stop"))
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "yoloMode", bool: false })
	})

	it("requires an explicit separate action to enable unlimited YOLO", () => {
		render(<YoloModeControls />)
		fireEvent.click(screen.getByText("settings:yoloTimer.unlimited"))
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "yoloMode", bool: true })
		expect(screen.getByTestId("yolo-mode-status")).toHaveTextContent("settings:yoloTimer.inactive")
	})

	it.each([0, 10000])("can stop an unacknowledged start after %i ms", (delay) => {
		render(<YoloModeControls />)
		fireEvent.click(screen.getByText("settings:yoloTimer.start"))
		act(() => vi.advanceTimersByTime(delay))
		fireEvent.click(screen.getByText("settings:yoloTimer.stop"))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "yoloMode", bool: false })
		expect(vscode.postMessage).toHaveBeenCalledTimes(2)
	})

	it("shows unlimited mode without starting a countdown", () => {
		state.yoloMode = true
		render(<YoloModeControls />)
		expect(screen.getByTestId("yolo-mode-status")).toHaveTextContent("settings:yoloTimer.activeUnlimited")
		expect(vi.getTimerCount()).toBe(0)
	})

	it("does not restart or grant anything when remounted with an expired lease", () => {
		state.yoloMode = true
		state.yoloModeExpiresAt = Date.now() - 1
		const { unmount } = render(<YoloModeControls />)
		unmount()
		render(<YoloModeControls />)
		expect(screen.getByTestId("yolo-mode-status")).toHaveTextContent("settings:yoloTimer.expired")
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("stops all countdown timers on unmount", () => {
		state.yoloMode = true
		state.yoloModeExpiresAt = Date.now() + 60000
		const { unmount } = render(<YoloModeControls />)
		expect(vi.getTimerCount()).toBe(2)
		unmount()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("uses only a deadline wakeup on collapsed surfaces and restores ordinary off at expiry", () => {
		state.yoloMode = true
		state.yoloModeExpiresAt = Date.now() + 60000
		const { result } = renderHook(() => {
			const { active } = useYoloModeState()
			return useAutoApprovalState({}, false, active)
		})
		expect(result.current.effectiveAutoApprovalEnabled).toBe(true)
		expect(vi.getTimerCount()).toBe(1)
		act(() => vi.advanceTimersByTime(60000))
		expect(result.current.effectiveAutoApprovalEnabled).toBe(false)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("retains ordinary approval when a timer expires", () => {
		state.yoloMode = true
		state.yoloModeExpiresAt = Date.now() + 1000
		const { result } = renderHook(() => {
			const { active } = useYoloModeState()
			return useAutoApprovalState({ alwaysAllowReadOnly: true }, true, active)
		})
		act(() => vi.advanceTimersByTime(1000))
		expect(result.current.effectiveAutoApprovalEnabled).toBe(true)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("reports missing acknowledgement without silently enabling the lease", () => {
		render(<YoloModeControls />)
		fireEvent.click(screen.getByText("settings:yoloTimer.start"))
		act(() => vi.advanceTimersByTime(10000))
		expect(screen.getByRole("alert")).toHaveTextContent("settings:yoloTimer.timeout")
		expect(screen.getByTestId("yolo-mode-status")).toHaveTextContent("settings:yoloTimer.inactive")
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
	})
})
