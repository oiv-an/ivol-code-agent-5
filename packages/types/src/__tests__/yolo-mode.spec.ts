// kilocode_change - new file
import { globalSettingsSchema, GLOBAL_STATE_KEYS } from "../global-settings.js"
import { isYoloModeActive, getYoloModeExpiresAt, isValidYoloModeTimerMinutes } from "../yolo-mode.js"

describe("YOLO absolute deadline", () => {
	const now = 1_800_000_000_000

	it("keeps legacy explicit unlimited mode and otherwise requires exactly true", () => {
		expect(isYoloModeActive({ yoloMode: true }, now)).toBe(true)
		for (const value of [undefined, null, false, 1, "true"]) {
			expect(isYoloModeActive({ yoloMode: value }, now)).toBe(false)
		}
		expect(isYoloModeActive(undefined, now)).toBe(false)
	})

	it("expires at the exact deadline, including after sleep or restart", () => {
		const state = { yoloMode: true, yoloModeExpiresAt: now + 60_000 }
		expect(isYoloModeActive(state, now + 59_999)).toBe(true)
		expect(isYoloModeActive(state, now + 60_000)).toBe(false)
		expect(isYoloModeActive(state, now + 3_600_000)).toBe(false)
	})

	it.each([null, NaN, Infinity, -Infinity, "1800000060000", {}, -1, 0])(
		"fails closed for malformed/expired deadline %s",
		(yoloModeExpiresAt) => expect(isYoloModeActive({ yoloMode: true, yoloModeExpiresAt }, now)).toBe(false),
	)

	it("fails closed on an invalid current time", () => {
		expect(isYoloModeActive({ yoloMode: true }, NaN)).toBe(false)
		expect(isYoloModeActive({ yoloMode: true }, Infinity)).toBe(false)
	})

	it("a revocation identity denies stale grants independent of the clock or boolean flag", () => {
		const oldId = "00000000-0000-4000-8000-000000000001"
		const newId = "00000000-0000-4000-8000-000000000002"
		expect(isYoloModeActive({ yoloMode: true, yoloModeRevocationId: newId }, now)).toBe(false)
		expect(
			isYoloModeActive(
				{ yoloMode: true, yoloModeRevocationId: newId, yoloModeGrant: { revocationId: oldId } },
				now,
			),
		).toBe(false)
		expect(
			isYoloModeActive(
				{ yoloMode: true, yoloModeRevocationId: newId, yoloModeGrant: { revocationId: newId } },
				now,
			),
		).toBe(true)
	})

	it.each([null, "", "invalid", 1, {}, Infinity])("fails closed for invalid revocation identity %s", (identity) => {
		expect(
			isYoloModeActive(
				{ yoloMode: true, yoloModeRevocationId: identity, yoloModeGrant: { revocationId: identity } },
				now,
			),
		).toBe(false)
	})

	it("binds deadline to the atomic grant, ignoring a stale top-level deadline", () => {
		const state = { yoloMode: true, yoloModeExpiresAt: now + 3_600_000, yoloModeGrant: { expiresAt: now + 60_000 } }
		expect(getYoloModeExpiresAt(state)).toBe(now + 60_000)
		expect(isYoloModeActive(state, now + 60_000)).toBe(false)
		expect(getYoloModeExpiresAt({ ...state, yoloModeGrant: {} })).toBeUndefined()
	})

	it.each([null, true, "grant", 3, [], { expiresAt: null }, { expiresAt: Infinity }])(
		"rejects malformed grant %s",
		(grant) => {
			expect(isYoloModeActive({ yoloMode: true, yoloModeGrant: grant }, now)).toBe(false)
		},
	)

	it("preserves the absolute deadline and duration in the settings schema roundtrip", () => {
		const input = { yoloMode: true, yoloModeExpiresAt: now + 60_000, yoloModeTimerMinutes: 1 }
		const result = globalSettingsSchema.parse(JSON.parse(JSON.stringify(input)))
		expect(result).toEqual(input)
		expect(isYoloModeActive(result, now + 60_000)).toBe(false)
		expect(GLOBAL_STATE_KEYS).toEqual(expect.arrayContaining(Object.keys(input)))
		expect(globalSettingsSchema.parse({ yoloMode: true, yoloModeExpiresAt: null }).yoloModeExpiresAt).toBeNull()
	})

	it.each([1, 60, 1440])("accepts %i whole minutes", (minutes) => {
		expect(isValidYoloModeTimerMinutes(minutes)).toBe(true)
	})

	it.each([undefined, null, 0, -1, 1.5, 1441, Infinity, NaN, "60"])("rejects invalid minutes %s", (minutes) => {
		expect(isValidYoloModeTimerMinutes(minutes)).toBe(false)
	})
})
