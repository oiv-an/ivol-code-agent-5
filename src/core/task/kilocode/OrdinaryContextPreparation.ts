// Task-local state for an ordinary file-tool turn before condensation.
// No filesystem polling, managed writer, model routing, or persisted authorization.
import { isDeepStrictEqual } from "node:util"

export { ORDINARY_CONTEXT_PREPARATION_PROMPT, ORDINARY_TASK_INSTRUCTIONS } from "../../task-document/prompts"

export type PreparationTrigger = "manual" | "automatic" | "forced" | "extended-thinking" | "tool"
export interface WriteObservation {
	wasWritten(): boolean
	dispose(): void
}

/** Transitions are driven only at ordinary request boundaries, after durable tool results. */
export class OrdinaryContextPreparation {
	phase: "queued" | "editing" | "waiting" | "ready" = "queued"
	turns = 0
	completedTurn = false
	failure?: string
	continuedWithoutUpdate = false
	private observation?: WriteObservation

	private readonly configuration: unknown

	constructor(
		readonly trigger: PreparationTrigger,
		configuration: unknown,
	) {
		// Provider state refreshes allocate new objects even when no settings changed.
		// Snapshot values so in-place edits still invalidate an existing authorization.
		this.configuration = structuredClone(configuration)
	}

	matchesConfiguration(configuration: unknown): boolean {
		return isDeepStrictEqual(configuration, this.configuration)
	}

	start(observation: WriteObservation): void {
		if (this.phase !== "queued") throw new Error("Context preparation is not queued")
		this.observation = observation
		this.phase = "editing"
	}

	/** Call only after the preceding assistant and tool results have been saved. */
	settle(configuration: unknown): void {
		if (!this.continuedWithoutUpdate && !this.matchesConfiguration(configuration)) {
			this.fail("Provider settings changed during context preparation")
			return
		}
		if (this.phase !== "editing") return
		if (this.observation?.wasWritten()) {
			this.phase = "ready"
			this.dispose()
		} else if (++this.turns >= 4) {
			this.fail("The model did not successfully update root CURRENT_TASK.md in four preparation turns")
		}
	}

	fail(message: string): void {
		this.failure = message
		this.phase = "waiting"
		this.dispose()
	}

	continueWithoutUpdate(): void {
		if (this.phase !== "waiting") throw new Error("No context preparation decision is pending")
		this.continuedWithoutUpdate = true
		this.phase = "ready"
	}

	dispose(): void {
		this.observation?.dispose()
		this.observation = undefined
	}
}
