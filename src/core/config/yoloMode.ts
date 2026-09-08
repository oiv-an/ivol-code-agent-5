// kilocode_change - new file

import { randomUUID } from "node:crypto"
import { isValidYoloModeTimerMinutes, type GlobalSettings } from "@roo-code/types"
import type { ContextProxy } from "./ContextProxy"

export const YOLO_MODE_STATE_KEYS = [
	"yoloMode",
	"yoloModeExpiresAt",
	"yoloModeTimerMinutes",
	"yoloModeRevocationId",
	"yoloModeGrant",
] as const

type YoloModeChange =
	| { type: "toggle"; enabled: boolean }
	| { type: "timer"; minutes: unknown }
	| { type: "import"; settings: GlobalSettings }

// Multiple webviews can share the same settings proxy. A queued stop must win over an earlier start.
const pendingChanges = new WeakMap<ContextProxy, Promise<void>>()
const latestLocalIntent = new WeakMap<ContextProxy, string>()

/** Only explicit user actions enable YOLO. Import preserves metadata but never grants new approvals. */
export function updateYoloMode(context: ContextProxy, change: YoloModeChange): Promise<void> {
	// Capture BEFORE the first await, including before our local queue. A later stop in another host
	// must invalidate this intent even if this start's final boolean write completes after that stop.
	const previousRevocationId = context.getValue("yoloModeRevocationId")
	const intentId = randomUUID()
	latestLocalIntent.set(context, intentId)
	const isActivation = change.type === "timer" || (change.type === "toggle" && change.enabled)
	const ownsIntent = () =>
		context.getValue("yoloModeRevocationId") === intentId && latestLocalIntent.get(context) === intentId
	const writeOwned = async <K extends keyof GlobalSettings>(key: K, value: GlobalSettings[K]) => {
		if (!ownsIntent()) return false
		await context.setValue(key, value)
		return ownsIntent()
	}
	const previous = pendingChanges.get(context) ?? Promise.resolve()
	const operation = previous.then(async () => {
		try {
			if (
				isActivation &&
				(latestLocalIntent.get(context) !== intentId ||
					context.getValue("yoloModeRevocationId") !== previousRevocationId)
			) {
				return
			}
			// Every explicit start/restart also supersedes earlier starts, not merely earlier stops.
			// Imports publish a local identity; foreign settings must not restore an old permission grant.
			await context.setValue("yoloModeRevocationId", intentId)
			if (!(await writeOwned("yoloMode", false))) return
			if (change.type === "toggle") {
				if (change.enabled) {
					// Removing an old deadline is allowed only for an explicit unlimited-mode toggle.
					if (!(await writeOwned("yoloModeExpiresAt", undefined))) return
					if (!(await writeOwned("yoloModeGrant", { revocationId: intentId }))) return
					await writeOwned("yoloMode", true)
				}
				return
			}
			if (change.type === "import") {
				// Do not infer a fresh deadline from a stored duration, including legacy settings files.
				if (!(await writeOwned("yoloModeExpiresAt", change.settings.yoloModeExpiresAt))) return
				if (change.settings.yoloModeTimerMinutes !== undefined) {
					await writeOwned("yoloModeTimerMinutes", change.settings.yoloModeTimerMinutes)
				}
				return
			}
			if (!isValidYoloModeTimerMinutes(change.minutes)) {
				throw new Error("YOLO timer duration must be a whole number from 1 to 1440 minutes")
			}
			const deadline = Date.now() + change.minutes * 60_000
			if (!Number.isSafeInteger(deadline)) throw new Error("Cannot start YOLO timer: invalid system time")
			if (!(await writeOwned("yoloModeExpiresAt", deadline))) return
			if (!(await writeOwned("yoloModeTimerMinutes", change.minutes))) return
			// Persist deadline and captured revocation together; a stale deadline write cannot extend a new grant.
			if (!(await writeOwned("yoloModeGrant", { revocationId: intentId, expiresAt: deadline }))) return
			await writeOwned("yoloMode", true)
		} catch (error) {
			const currentId = context.getValue("yoloModeRevocationId")
			// A replaced operation must not revoke the user's newer successful activation in its cleanup.
			if (
				latestLocalIntent.get(context) !== intentId ||
				(currentId !== intentId && currentId !== previousRevocationId)
			) {
				return
			}
			const failures = [error]
			try {
				// A late boolean from another host cannot revive a partially saved failed grant.
				await context.setValue("yoloModeRevocationId", randomUUID())
			} catch (revokeError) {
				failures.push(revokeError)
			}
			try {
				await context.setValue("yoloMode", false)
			} catch (disableError) {
				failures.push(disableError)
			}
			if (failures.length > 1) {
				throw new AggregateError(failures, "Cannot save YOLO settings; YOLO is disabled in this session")
			}
			throw error
		}
	})
	// The caller owns errors; keep the serialization tail fulfilled so a later explicit action can recover.
	const tail = operation.then(
		() => undefined,
		() => undefined,
	)
	pendingChanges.set(context, tail)
	void tail.then(() => {
		if (pendingChanges.get(context) === tail) pendingChanges.delete(context)
		if (latestLocalIntent.get(context) === intentId) latestLocalIntent.delete(context)
	})
	return operation
}
