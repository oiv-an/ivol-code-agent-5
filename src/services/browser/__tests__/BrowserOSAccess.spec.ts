// kilocode_change - new file: a rejected new tab must explain the rule, not leak a parser error.
import { browserOSOperation } from "../kilocode/BrowserOSAccess"

const RULE = "BrowserOS new tabs require HTTP(S) or about:blank without credentials"

describe("browserOSOperation: tabs new", () => {
	it.each([undefined, null, "", "   ", "about:blank"])("opens a blank tab for %p", (url) => {
		expect(browserOSOperation("tabs", { action: "new", url })).toEqual({ kind: "create" })
	})

	it.each(["https://example.com", "http://example.com/path?q=1"])("accepts the web address %s", (url) => {
		expect(browserOSOperation("tabs", { action: "new", url })).toEqual({ kind: "create" })
	})

	it.each([
		["a malformed address", "not a url"],
		["a bare host without a scheme", "example.com"],
		["a file path", "file:///etc/passwd"],
		["a script url", "javascript:alert(1)"],
		["a data url", "data:text/html,<h1>x</h1>"],
		["an embedded credential", "https://user:secret@example.com"],
	])("reports the rule for %s", (_label, url) => {
		// A raw TypeError from the URL parser used to reach the user instead of this rule.
		expect(() => browserOSOperation("tabs", { action: "new", url })).toThrow(RULE)
	})

	it.each([42, {}, []])("reports the rule for the non-string value %p", (url) => {
		expect(() => browserOSOperation("tabs", { action: "new", url })).toThrow(RULE)
	})

	it("never reports a bare parser failure", () => {
		try {
			browserOSOperation("tabs", { action: "new", url: "not a url" })
			throw new Error("Expected a rejection")
		} catch (error) {
			expect(error).toBeInstanceOf(Error)
			expect((error as Error).message).toBe(RULE)
			expect((error as Error).message).not.toMatch(/invalid url/i)
		}
	})
})
