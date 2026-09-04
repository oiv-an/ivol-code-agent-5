import { normalizeResponsesInput } from "../responses-input"

describe("normalizeResponsesInput", () => {
	it("wraps a legacy string prompt in a Responses message item", () => {
		expect(normalizeResponsesInput("Текст запроса")).toEqual([
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Текст запроса" }],
			},
		])
	})

	it("preserves a prepared history array without altering its items", () => {
		const input = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Run it" }] },
			{ type: "function_call", call_id: "call_1", name: "run", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_1", output: "done" },
		]

		expect(normalizeResponsesInput(input)).toBe(input)
	})

	it.each([undefined, null, 42, { role: "user" }])("rejects unsupported input %o", (input) => {
		expect(() => normalizeResponsesInput(input)).toThrow(
			"Responses API input must be a string or an array of input items.",
		)
	})
})
