// kilocode_change - new file
import * as vscode from "vscode"
import { t } from "../../i18n"
import type { ShadowCheckpointService } from "../../services/checkpoints/ShadowCheckpointService"
import type { CheckpointDiff } from "../../services/checkpoints/types"

// Serialize per service and cancel superseded previews to bound concurrent allocations.
const previews = new WeakMap<ShadowCheckpointService, { abort: AbortController; done: Promise<unknown> }>()

export async function previewCheckpointDiff(
	service: ShadowCheckpointService,
	range: { from?: string; to?: string },
): Promise<CheckpointDiff[] | undefined> {
	const previous = previews.get(service)
	previous?.abort.abort()
	const abort = new AbortController()
	const done = vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: t("common:errors.checkpoint_preview_progress"),
			cancellable: true,
		},
		async (_progress, token) => {
			const subscription = token.onCancellationRequested(() => abort.abort())
			if (token.isCancellationRequested) abort.abort()
			const timeout = setTimeout(() => abort.abort(new Error("Checkpoint preview timed out")), 30_000)
			try {
				await previous?.done.catch(() => undefined)
				abort.signal.throwIfAborted()
				const changes = await service.getDiff({ ...range, signal: abort.signal })
				abort.signal.throwIfAborted()
				if (changes.some((change) => change.omitted)) {
					void vscode.window.showWarningMessage(t("common:errors.checkpoint_preview_omitted"))
				}
				return changes
			} catch (error) {
				if (abort.signal.aborted && abort.signal.reason?.name === "AbortError") return undefined
				console.warn("Checkpoint preview failed", error)
				void vscode.window.showWarningMessage(t("common:errors.checkpoint_preview_error"))
				return undefined
			} finally {
				clearTimeout(timeout)
				subscription.dispose()
			}
		},
	)
	const entry = { abort, done: Promise.resolve(done) }
	previews.set(service, entry)
	try {
		return await done
	} finally {
		if (previews.get(service) === entry) previews.delete(service)
	}
}
