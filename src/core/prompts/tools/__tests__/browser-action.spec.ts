// kilocode_change - new file
import nativeBrowserAction from "../native-tools/browser_action"
import { getBrowserActionDescription } from "../browser-action"

describe("browser_action tool descriptions", () => {
	const xmlDescription = getBrowserActionDescription({
		cwd: "/workspace",
		supportsComputerUse: true,
	} as Parameters<typeof getBrowserActionDescription>[0])

	const nativeDescription = nativeBrowserAction.function.description ?? ""

	const descriptions: Array<[string, string]> = [
		["native", nativeDescription],
		["xml", xmlDescription ?? ""],
	]

	it.each(descriptions)("tells the %s protocol to search the web before opening a browser", (_name, description) => {
		expect(description).toContain("Do NOT open a browser for those")
		expect(description).toContain("web_search")
		// A connected browser must not become the default research path.
		expect(description).toContain("A connected browser is not a reason to skip search")
	})

	it.each(descriptions)("no longer invites the %s protocol to browse for news or weather", (_name, description) => {
		expect(description).not.toContain("you might use this tool to complete the task if it makes sense")
		expect(description).not.toContain("you should prefer to use it over browser_action")
	})

	it.each(descriptions)("keeps the %s protocol allowed for genuine browser work", (_name, description) => {
		expect(description).toContain("pages behind the user's login")
		expect(description).toContain("checking a site you are building or debugging")
	})

	it("returns nothing for the xml protocol when computer use is unsupported", () => {
		expect(
			getBrowserActionDescription({
				cwd: "/workspace",
				supportsComputerUse: false,
			} as Parameters<typeof getBrowserActionDescription>[0]),
		).toBeUndefined()
	})
})
