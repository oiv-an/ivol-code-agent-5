// kilocode_change - new file
import type { ProviderSettings } from "@roo-code/types"

/**
 * Turning freezing on by using it.
 *
 * The freeze control sits on every written answer, whether or not the profile asked for freezing.
 * Reaching for it is the clearest statement of intent there is, so the click switches the feature
 * on instead of refusing and sending the user off to the settings page.
 *
 * The handler pulls in the whole extension, so the rule is exercised on its own here. It mirrors
 * the `togglePinnedMessage` case in `webviewMessageHandler`.
 */
const settingsAfterClick = (current: ProviderSettings): ProviderSettings | undefined => {
	if (current.freezeMessagesEnabled === true) {
		return undefined
	}

	return {
		...current,
		freezeMessagesEnabled: true,
		intelligentContextResetEnabled: false,
		intelligentTaskEnabled: false,
	}
}

describe("freezing turns itself on when the control is used", () => {
	it("switches freezing on for a profile that never asked for it", () => {
		const saved = settingsAfterClick({ apiProvider: "anthropic" })

		expect(saved?.freezeMessagesEnabled).toBe(true)
	})

	it("turns off the two other ways of holding on to context", () => {
		const saved = settingsAfterClick({
			apiProvider: "anthropic",
			intelligentContextResetEnabled: true,
			intelligentTaskEnabled: true,
		})

		expect(saved?.intelligentContextResetEnabled).toBe(false)
		expect(saved?.intelligentTaskEnabled).toBe(false)
	})

	it("saves nothing when freezing is already on", () => {
		expect(settingsAfterClick({ apiProvider: "anthropic", freezeMessagesEnabled: true })).toBeUndefined()
	})

	it("keeps the rest of the profile untouched", () => {
		const saved = settingsAfterClick({ apiProvider: "anthropic", apiModelId: "claude-opus-4" })

		expect(saved?.apiProvider).toBe("anthropic")
		expect(saved?.apiModelId).toBe("claude-opus-4")
	})
})
