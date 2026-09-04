export type ResponsesInputItem = Record<string, unknown>

/**
 * The public Responses API accepts a plain string, but the Codex OAuth
 * backend requires the structured item-list form. Normalize at the transport
 * boundary so compatible gateways can safely route the same request to Codex.
 */
export function normalizeResponsesInput(input: unknown): ResponsesInputItem[] {
	if (Array.isArray(input)) {
		return input as ResponsesInputItem[]
	}

	if (typeof input === "string") {
		return [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: input }],
			},
		]
	}

	throw new TypeError("Responses API input must be a string or an array of input items.")
}
