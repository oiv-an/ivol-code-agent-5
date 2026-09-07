// kilocode_change - new file
import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "openai"
import {
	isOpenAiAbortError,
	isOpenAiTransportError,
	normalizeOpenAiTransportError,
	OpenAiTransportError,
} from "../openai-transport-error"

describe("OpenAI transport errors", () => {
	it.each(["UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "ECONNRESET", "ETIMEDOUT"])(
		"preserves only the whitelisted %s cause code",
		(code) => {
			const raw = Object.assign(new TypeError("terminated"), {
				cause: Object.assign(new Error("private-fixture-response-and-url"), {
					code,
					headers: { authorization: "Bearer fixture-secret" },
					socket: { remoteAddress: "private-fixture-host" },
				}),
			})
			const normalized = normalizeOpenAiTransportError(raw)!
			expect(normalized).toBeInstanceOf(OpenAiTransportError)
			expect(normalized.code).toBe(code)
			expect(normalized.cause).toEqual({ code })
			expect(normalized.provider).toBe("openai")
			expect(isOpenAiTransportError(normalized)).toBe(true)
			expect(`${normalized.stack} ${JSON.stringify(normalized)}`).not.toMatch(/private-fixture|fixture-secret/)
		},
	)

	it("recognizes the SDK's first-response connection error before its wrapper loses cause", () => {
		const raw = new APIConnectionError({
			cause: Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
			}),
		})
		expect(normalizeOpenAiTransportError(raw)?.code).toBe("ECONNRESET")
		expect(normalizeOpenAiTransportError(new APIConnectionTimeoutError())?.code).toBe("OPENAI_REQUEST_TIMEOUT")
		expect(normalizeOpenAiTransportError(new APIConnectionError({}))?.code).toBe("OPENAI_CONNECTION_ERROR")
	})

	it("classifies a bare fetch termination without guessing arbitrary API messages", () => {
		expect(normalizeOpenAiTransportError(new TypeError("terminated"))?.code).toBe("OPENAI_STREAM_TERMINATED")
		expect(isOpenAiTransportError(new Error("Provider says terminated request was invalid"))).toBe(false)
	})

	it.each([
		new DOMException("The operation was aborted", "AbortError"),
		new APIUserAbortError(),
		Object.assign(new Error("cancelled"), { code: "ABORT_ERR" }),
		Object.assign(new TypeError("terminated"), { cause: new DOMException("aborted", "AbortError") }),
	])("never retries user cancellation: %#", (error) => {
		expect(isOpenAiAbortError(error)).toBe(true)
		expect(isOpenAiTransportError(error)).toBe(false)
		expect(normalizeOpenAiTransportError(error)).toBeUndefined()
	})

	it("does not misclassify HTTP error bodies containing a transport-like code", () => {
		const http = Object.assign(new Error("provider error"), { status: 400, code: "ECONNRESET" })
		expect(isOpenAiTransportError(http)).toBe(false)
		expect(normalizeOpenAiTransportError(http)).toBeUndefined()
	})

	it("bounds cause traversal and tolerates cyclic or non-error input", () => {
		const cyclic = Object.assign(new Error("cycle"), { cause: undefined as unknown })
		cyclic.cause = cyclic
		expect(isOpenAiTransportError(cyclic)).toBe(false)
		for (const value of [undefined, null, false, "terminated", 1]) {
			expect(isOpenAiTransportError(value)).toBe(false)
		}
	})

	it("never reflects unknown code text into a normalized diagnostic", () => {
		expect(new OpenAiTransportError("private-fixture-code").code).toBe("OPENAI_CONNECTION_ERROR")
		expect(new OpenAiTransportError("private-fixture-code").message).not.toContain("private-fixture")
	})

	it("recognizes SDK errors when production minification renames their constructors", () => {
		const classes = [APIConnectionError, APIConnectionTimeoutError, APIUserAbortError]
		const names = classes.map((type) => Object.getOwnPropertyDescriptor(type, "name")!)
		try {
			classes.forEach((type, index) => Object.defineProperty(type, "name", { value: `minified${index}` }))
			expect(normalizeOpenAiTransportError(new APIConnectionTimeoutError())?.code).toBe("OPENAI_REQUEST_TIMEOUT")
			expect(normalizeOpenAiTransportError(new APIConnectionError({}))?.code).toBe("OPENAI_CONNECTION_ERROR")
			expect(isOpenAiAbortError(new APIUserAbortError())).toBe(true)
			expect(isOpenAiTransportError(new APIUserAbortError())).toBe(false)
		} finally {
			classes.forEach((type, index) => Object.defineProperty(type, "name", names[index]))
		}
	})
})
