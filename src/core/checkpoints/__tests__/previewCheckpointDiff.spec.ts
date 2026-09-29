// kilocode_change - new file
import * as vscode from "vscode"
import { previewCheckpointDiff } from "../previewCheckpointDiff"
import type { ShadowCheckpointService } from "../../../services/checkpoints/ShadowCheckpointService"

vi.mock("../../../i18n", () => ({ t: (key: string) => key }))
vi.mock("vscode", () => ({
	window: { withProgress: vi.fn(), showWarningMessage: vi.fn() },
	ProgressLocation: { Notification: 15 },
}))
let cancel: () => void
beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(vscode.window.withProgress).mockImplementation(async (_options, action) =>
		action(
			{ report: vi.fn() },
			{
				isCancellationRequested: false,
				onCancellationRequested: vi.fn((callback) => {
					cancel = callback
					return { dispose: vi.fn() }
				}),
			},
		),
	)
})

it("warns about omitted content without treating it as no changes", async () => {
	const rows = [
		{
			omitted: "binary",
			paths: { relative: "a", absolute: "/a" },
			content: { before: "omitted", after: "omitted" },
		},
	]
	const service = { getDiff: vi.fn().mockResolvedValue(rows) } as unknown as ShadowCheckpointService
	expect(await previewCheckpointDiff(service, {})).toBe(rows)
	expect(vscode.window.showWarningMessage).toHaveBeenCalledWith("common:errors.checkpoint_preview_omitted")
})

it("cancels the pending read without disabling checkpoints or showing an error", async () => {
	const service = {
		getDiff: vi.fn(
			({ signal }: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true })
				}),
		),
	} as unknown as ShadowCheckpointService
	const pending = previewCheckpointDiff(service, {})
	await vi.waitFor(() => expect(service.getDiff).toHaveBeenCalled())
	cancel()
	expect(await pending).toBeUndefined()
	expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
})

it("cancels and serializes a superseded preview", async () => {
	let active = 0
	let maximum = 0
	const getDiff = vi.fn(({ signal }: { signal: AbortSignal }) => {
		active++
		maximum = Math.max(maximum, active)
		if (getDiff.mock.calls.length > 1) {
			active--
			return Promise.resolve([])
		}
		return new Promise((_resolve, reject) => {
			signal.addEventListener(
				"abort",
				() => {
					active--
					reject(signal.reason)
				},
				{ once: true },
			)
		})
	})
	const service = { getDiff } as unknown as ShadowCheckpointService
	const first = previewCheckpointDiff(service, {})
	await vi.waitFor(() => expect(getDiff).toHaveBeenCalledTimes(1))
	const second = previewCheckpointDiff(service, {})
	expect(await first).toBeUndefined()
	expect(await second).toEqual([])
	expect(maximum).toBe(1)
})

it("reports a failed preview without changing checkpoint availability", async () => {
	const service = {
		getDiff: vi.fn().mockRejectedValue(new Error("bounded output")),
	} as unknown as ShadowCheckpointService
	expect(await previewCheckpointDiff(service, {})).toBeUndefined()
	expect(vscode.window.showWarningMessage).toHaveBeenCalledWith("common:errors.checkpoint_preview_error")
})
