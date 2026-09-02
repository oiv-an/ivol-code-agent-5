import { vscode } from "../utils/vscode"
import debounce from "debounce"

export const showSystemNotification = debounce((message: string) => {
	vscode.postMessage({
		type: "showSystemNotification",
		notificationOptions: {
			message,
		},
	})
})

export interface WebviewMemoryInfo {
	usedJSHeapSize: number
	jsHeapSizeLimit: number
}

export function getMemoryPercentage(memoryInfo?: WebviewMemoryInfo) {
	const memory =
		memoryInfo ??
		("memory" in performance && typeof performance.memory === "object"
			? (performance.memory as WebviewMemoryInfo)
			: undefined)

	if (!memory || !Number.isFinite(memory.jsHeapSizeLimit) || memory.jsHeapSizeLimit <= 0) {
		return 0
	}

	return Math.min(100, Math.floor((100 * memory.usedJSHeapSize) / memory.jsHeapSizeLimit))
}
