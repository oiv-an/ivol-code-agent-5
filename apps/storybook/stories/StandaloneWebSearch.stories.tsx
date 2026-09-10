// kilocode_change - new file: entirely synthetic interaction; never contacts a provider or writes a file.
import { useEffect } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { StandaloneWebSearch } from "../../../webview-ui/src/components/chat/StandaloneWebSearch"
import { vscode } from "../../../webview-ui/src/utils/vscode"

function SearchPreview() {
	useEffect(() => {
		const original = vscode.postMessage
		const timers = new Set<ReturnType<typeof setTimeout>>()
		vscode.postMessage = (message) => {
			if (message.type === "saveStandaloneWebSearch") {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "standaloneWebSearchSaveResult",
							standaloneWebSearchSaveResult: { requestId: message.requestId, status: "cancelled" },
						},
					}),
				)
				return
			}
			if (message.type === "cancelStandaloneWebSearch") {
				for (const timer of timers) clearTimeout(timer)
				timers.clear()
				return
			}
			if (message.type !== "startStandaloneWebSearch") return
			const timer = setTimeout(() => {
				timers.delete(timer)
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "standaloneWebSearchUpdate",
							standaloneWebSearchUpdate: {
								requestId: message.requestId,
								status: "success",
								result: {
									requestId: message.requestId,
									query: message.text,
									answer: "## Example answer\n\nThis is a **synthetic preview**, not a live search. A source is [clickable](https://example.com/search).\n\n- A concise finding.\n- Another useful detail.\n\n![Images are not loaded](https://example.com/image.png)",
									sources: [
										{
											url: "https://example.com/search",
											title: "Example source — synthetic fixture",
										},
									],
									model: "search-model-preview",
									createdAt: "2026-09-09T00:00:00.000Z",
									truncated: false,
								},
							},
						},
					}),
				)
			}, 600)
			timers.add(timer)
		}
		return () => {
			for (const timer of timers) clearTimeout(timer)
			vscode.postMessage = original
		}
	}, [])
	return (
		<div style={{ padding: 16, minHeight: "100vh" }}>
			<StandaloneWebSearch
				apiConfiguration={{ apiProvider: "openai", openAiWebSearchModelId: "search-model-preview" }}
				currentApiConfigName="Synthetic preview"
			/>
		</div>
	)
}

const meta: Meta<typeof SearchPreview> = {
	title: "Chat/StandaloneWebSearch",
	component: SearchPreview,
}

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
