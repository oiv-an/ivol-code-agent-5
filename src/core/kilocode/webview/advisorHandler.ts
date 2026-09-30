import * as vscode from "vscode"
import type { AdvisorAIResult, WebviewMessage } from "@roo-code/types"
import { analyzeAdvisor, advisorWait } from "../../../services/kilocode/advisor/aiAnalysis"
import type { ClineProvider } from "../../webview/ClineProvider"
import { AdvisorService } from "../../../services/kilocode/advisor/AdvisorService"
import { readWorkspaceDisabled } from "../../../services/kilocode/advisor/workspaceDisabled"

const running = new WeakMap<ClineProvider, { id: string; controller: AbortController }>()

export async function handleAdvisor(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	const service = new AdvisorService()
	if (message.type === "cancelAdvisorCheck") {
		const current = running.get(provider)
		if (current && current.id === message.advisorRequestId) current.controller.abort(new Error("Advisor cancelled"))
		return
	}
	if (message.type === "startAdvisorCheck") {
		if (running.has(provider)) running.get(provider)!.controller.abort(new Error("Advisor superseded"))
		const controller = new AbortController()
		const id = message.advisorRequestId ?? "advisor"
		running.set(provider, { id, controller })
		const result: AdvisorAIResult = {
			model: "",
			recommendations: [],
			usage: { inputTokens: 0, outputTokens: 0 },
			complete: false,
			files: 0,
			inventoryCount: 0,
		}
		const timer = setTimeout(() => controller.abort(new Error("Advisor timed out after 90 seconds")), 90000)
		let state
		try {
			state = await advisorWait(service.getState(), controller.signal)
			if (!state.platformSupported || !state.canScan)
				throw new Error("Advisor requires a trusted single-folder VS Code workspace")
			const { apiConfiguration } = await advisorWait(provider.getState(), controller.signal)
			await analyzeAdvisor(
				apiConfiguration,
				vscode.workspace.workspaceFolders![0].uri,
				state.entries,
				controller.signal,
				result,
				`advisor-${id}`,
			)
			if (vscode.workspace.workspaceFolders?.[0]?.uri.toString() !== state.workspace)
				throw new Error("Workspace changed during analysis")
		} catch (cause) {
			result.error = cause instanceof Error ? cause.message : String(cause)
			result.cancelled = controller.signal.aborted
			result.recommendations = []
		} finally {
			clearTimeout(timer)
			controller.abort()
			if (running.get(provider)?.controller === controller) running.delete(provider)
		}
		await provider.postMessageToWebview({
			type: "advisorState",
			advisorRequestId: message.advisorRequestId,
			advisorState: {
				...(state ?? { workspace: "", platformSupported: false, canScan: false, entries: [] }),
				ai: result,
				checked: true,
			},
		})
		return
	}
	provider.log(`Advisor request: ${message.type}`)
	let error: string | undefined
	try {
		if (message.type === "openAdvisorExtension") {
			const state = await service.getState()
			const id = message.advisorExtensionId
			if (
				!state.platformSupported ||
				!id ||
				!/^[a-z0-9-]+\.[a-z0-9._-]+$/i.test(id) ||
				(!state.entries.some((entry) => entry.id === id) &&
					!(await readWorkspaceDisabled(provider.contextProxy.rawContext)).entries.some(
						(entry) => entry.id === id,
					))
			)
				throw new Error("Unknown extension or unsupported platform")
			await vscode.commands.executeCommand("workbench.extensions.search", `@id:${id}`)
		}
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause)
		provider.log(`Advisor: ${error}`)
	}
	try {
		const state = await service.getState()
		provider.log(`Advisor result: checked=${state.checked}, entries=${state.entries.length}`)
		await provider.postMessageToWebview({
			type: "advisorState",
			advisorRequestId: message.advisorRequestId,
			advisorState: {
				...state,
				workspaceDisabled: await readWorkspaceDisabled(provider.contextProxy.rawContext),
				error,
			},
		})
	} catch (cause) {
		provider.log(`Advisor inspection failed: ${String(cause)}`)
		await provider.postMessageToWebview({
			type: "advisorState",
			advisorRequestId: message.advisorRequestId,
			advisorState: {
				workspace: "",
				platformSupported: false,
				canScan: false,
				entries: [],
				error: String(cause),
			},
		})
	}
}
