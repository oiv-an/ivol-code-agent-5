// kilocode_change - new file
import { render, screen, fireEvent } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import { ChatRowContent } from "../ChatRow"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

describe("Telegram image feedback in the ordinary chat row", () => {
	it.each(["Screenshot from phone", ""])("renders and opens the image with caption '%s'", (text) => {
		const image = "data:image/png;base64,iVBORw0KGgoA"
		render(
			<ExtensionStateContextProvider>
				<QueryClientProvider client={new QueryClient()}>
					<ChatRowContent
						message={{ ts: 1, type: "say", say: "user_feedback", text, images: [image] }}
						isExpanded={false}
						isLast={false}
						isStreaming={false}
						onToggleExpand={() => {}}
						onSuggestionClick={() => {}}
						onBatchFileResponse={() => {}}
						onFollowUpUnmount={() => {}}
						isFollowUpAnswered={false}
					/>
				</QueryClientProvider>
			</ExtensionStateContextProvider>,
		)
		const thumbnail = screen.getByRole("img", { name: "Thumbnail 1" })
		expect(thumbnail).toHaveAttribute("src", image)
		if (text) expect(screen.getByText(text)).toBeInTheDocument()
		fireEvent.click(thumbnail)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openImage", text: image })
	})
})
