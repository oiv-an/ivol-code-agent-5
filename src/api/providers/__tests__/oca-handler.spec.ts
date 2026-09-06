// kilocode_change - new file
import type { ModelInfo } from "@roo-code/types"

import { OcaHandler } from "../oca-handler"

const modelInfo: ModelInfo = {
	contextWindow: 128_000,
	supportsPromptCache: false,
	supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
}

describe("OcaHandler reasoning effort", () => {
	it("falls back from Maximum to the strongest declared level", () => {
		const handler = new OcaHandler({ reasoningEffort: "max", enableReasoningEffort: true })

		expect((handler as any).getReasoningEffort("oca-model", modelInfo)).toBe("xhigh")
	})

	it("omits reasoning when effort is disabled", () => {
		const handler = new OcaHandler({ reasoningEffort: "max", enableReasoningEffort: false })

		expect((handler as any).getReasoningEffort("oca-model", modelInfo)).toBeUndefined()
	})
})
