// kilocode_change - new file
import { act, fireEvent, render, screen } from "@/utils/test-utils"
import type { ProviderSettings } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

import { OpenRouterPricing } from "../OpenRouterPricing"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick, disabled, "data-testid": testId }: any) => (
		<button onClick={onClick} disabled={disabled} data-testid={testId}>
			{children}
		</button>
	),
}))

const match = {
	id: "anthropic/claude-opus-5.5",
	inputPrice: 4,
	outputPrice: 20,
	cacheReadsPrice: 0.2,
	cacheWritesPrice: 5,
}

const reply = (requestId: string) =>
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "openRouterPricing", requestId, success: true, values: { match } },
			}),
		)
	})

describe("OpenRouterPricing", () => {
	beforeEach(() => vi.mocked(vscode.postMessage).mockClear())

	it("looks up the current model and shows the automatic match", () => {
		const config: ProviderSettings = { apiProvider: "openai", openAiModelId: "3-claude-opus" }
		render(<OpenRouterPricing apiConfiguration={config} setApiConfigurationField={vi.fn()} />)

		const request = vi.mocked(vscode.postMessage).mock.calls[0][0] as any
		expect(request).toMatchObject({
			type: "requestOpenRouterPricing",
			values: { modelId: "3-claude-opus", force: false },
		})
		reply(request.requestId)
		expect(screen.getByTestId("openrouter-pricing").textContent).toContain(
			"settings:providers.customModel.openRouterPricing.auto",
		)
	})

	it("writes OpenRouter prices into the profile when the button is clicked", () => {
		const setField = vi.fn()
		const config: ProviderSettings = { apiProvider: "openai", openAiModelId: "3-claude-opus" }
		render(<OpenRouterPricing apiConfiguration={config} setApiConfigurationField={setField} />)

		// The initial lookup must finish before the button is enabled.
		reply((vscode.postMessage as any).mock.calls[0][0].requestId)
		expect(setField).not.toHaveBeenCalled()

		fireEvent.click(screen.getByTestId("openrouter-pricing-apply"))
		const request = vi.mocked(vscode.postMessage).mock.calls.at(-1)![0] as any
		expect(request.values.force).toBe(true)
		reply(request.requestId)

		expect(setField).toHaveBeenCalledWith(
			"openAiCustomModelInfo",
			expect.objectContaining({ inputPrice: 4, outputPrice: 20, cacheReadsPrice: 0.2, cacheWritesPrice: 5 }),
		)
	})

	it("renders nothing without a model", () => {
		render(<OpenRouterPricing apiConfiguration={{ apiProvider: "openai" }} setApiConfigurationField={vi.fn()} />)
		expect(screen.queryByTestId("openrouter-pricing")).toBeNull()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
})
