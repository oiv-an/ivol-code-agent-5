// kilocode_change - new file
import { render, fireEvent, act } from "@/utils/test-utils"
import type { WebviewMessage } from "@roo-code/types"
import ChatHistorySearch from "../ChatHistorySearch"
import { vscode } from "@src/utils/vscode"
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

describe("chat search", () => {
	it("ignores stale responses and requests context only for the selected result", () => {
		const view = render(<ChatHistorySearch taskId="current" />)
		fireEvent.change(view.getByRole("textbox"), { target: { value: "needle" } })
		fireEvent.submit(view.getByRole("textbox").closest("form")!)
		const request = (vi.mocked(vscode.postMessage).mock.calls.at(-1)![0] as WebviewMessage).chatSearchRequest!
		const reply = (taskId: string, requestId: string) =>
			act(() =>
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "chatSearchResult",
							chatSearchResult: {
								taskId,
								requestId,
								hits: [{ ts: 7, kind: "text", snippet: "found needle" }],
							},
						},
					}),
				),
			)
		reply("other", request.requestId)
		expect(view.queryByRole("button", { name: "found needle" })).toBeNull()
		reply("current", "old")
		expect(view.queryByRole("button", { name: "found needle" })).toBeNull()
		reply("current", request.requestId)
		fireEvent.click(view.getByRole("button", { name: "found needle" }))
		expect((vi.mocked(vscode.postMessage).mock.calls.at(-1)![0] as WebviewMessage).chatSearchRequest).toMatchObject(
			{ taskId: "current", messageTs: 7, query: "needle" },
		)
		fireEvent.change(view.getByRole("textbox"), { target: { value: "changed" } })
		reply("current", request.requestId)
		expect(view.queryByRole("button", { name: "found needle" })).toBeNull()
	})
})
