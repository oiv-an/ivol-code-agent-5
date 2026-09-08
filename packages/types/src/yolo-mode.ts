// kilocode_change - new file

export const DEFAULT_YOLO_MODE_TIMER_MINUTES = 60
export const MAX_YOLO_MODE_TIMER_MINUTES = 1440

type YoloModeState = {
	yoloMode?: unknown
	yoloModeExpiresAt?: unknown
	yoloModeRevocationId?: unknown
	yoloModeGrant?: unknown
}

/** Accept untrusted persisted state too: malformed deadlines must never grant approval. */
export function isYoloModeActive(state: YoloModeState | null | undefined, now = Date.now()): boolean {
	if (state?.yoloMode !== true || !Number.isFinite(now)) return false
	const revocation = state.yoloModeRevocationId
	const grant = state.yoloModeGrant
	if (grant !== undefined) {
		if (!isGrantObject(grant)) return false
		if (revocation !== undefined || grant.revocationId !== undefined) {
			if (!isYoloModeRevocationId(revocation) || grant.revocationId !== revocation) return false
		}
	} else if (revocation !== undefined) {
		// The old legacy grant has no identity: the first explicit stop revokes it permanently.
		return false
	}
	const deadline = getYoloModeExpiresAt(state)
	return deadline === undefined || (typeof deadline === "number" && Number.isFinite(deadline) && deadline > now)
}

function isGrantObject(value: unknown): value is { revocationId?: unknown; expiresAt?: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A grant binds deadline and revocation in one atomic storage value; the top-level expiry is legacy only. */
export function getYoloModeExpiresAt(state: YoloModeState): number | null | undefined {
	const grant = state.yoloModeGrant
	if (grant !== undefined && !isGrantObject(grant)) return null
	const deadline = grant === undefined ? state.yoloModeExpiresAt : grant.expiresAt
	return deadline === undefined || (typeof deadline === "number" && Number.isFinite(deadline)) ? deadline : null
}

export function isYoloModeRevocationId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
	)
}

export function isValidYoloModeTimerMinutes(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_YOLO_MODE_TIMER_MINUTES
}
