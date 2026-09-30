import { advisorWait, analyzeAdvisor, collectAdvisorMetadata, validateAdvisorRecommendations } from "../aiAnalysis"
import type { AdvisorAIResult } from "@roo-code/types"
const mocks = vi.hoisted(() => ({ readDirectory: vi.fn(), createMessage: vi.fn() }))
vi.mock("vscode", () => ({
	workspace: { fs: { readDirectory: mocks.readDirectory } },
	Uri: { joinPath: (_root: unknown, path: string) => path },
	FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
	extensions: { all: [] },
	env: { language: "en" },
}))
vi.mock("../../../../api", () => ({
	buildApiHandler: () => ({ createMessage: mocks.createMessage, getModel: () => ({ id: "selected-model" }) }),
}))
const entry = (id: string, dependencies: string[] = [], protectedValue = false) => ({
	id,
	name: id,
	description: "",
	active: false,
	protected: protectedValue,
	activationEvents: [],
	dependencies,
	languages: [],
	protection: [],
})
const row = (id: string) => ({ id, reason: "Optional", loss: "Completion" })
beforeEach(() => {
	vi.clearAllMocks()
	mocks.readDirectory.mockResolvedValue([])
})
it("reads bounded metadata only and skips hidden paths, output and symlinks", async () => {
	mocks.readDirectory.mockImplementation(async (path: string) =>
		path
			? [["a.ts", 1]]
			: [
					["src", 2],
					["node_modules", 2],
					[".env", 1],
					["link", 66],
					["build", 2],
				],
	)
	const result = await collectAdvisorMetadata({} as never, new AbortController().signal)
	expect(result.paths).toEqual(["src/a.ts"])
	expect(result.extensions).toEqual({ ".ts": 1 })
	expect(result.complete).toBe(false)
	expect(mocks.readDirectory).toHaveBeenCalledTimes(2)
})
it("bounds samples and reports truncated coverage", async () => {
	mocks.readDirectory.mockResolvedValue(Array.from({ length: 15000 }, (_, i) => [`file${i}.ts`, 1]))
	const result = await collectAdvisorMetadata({} as never, new AbortController().signal)
	expect(result.paths.length).toBeLessThanOrEqual(800)
	expect(result.files).toBe(12000)
	expect(result.complete).toBe(false)
})
it("cancels a stuck filesystem read", async () => {
	mocks.readDirectory.mockReturnValue(new Promise(() => {}))
	const controller = new AbortController()
	const pending = collectAdvisorMetadata({} as never, controller.signal)
	controller.abort(new Error("cancelled"))
	await expect(pending).rejects.toThrow("cancelled")
})
it("rejects unknown/protected IDs and transitively protects retained dependencies", () => {
	const inventory = [
		entry("ivol.ivol-code-agent-5", ["vendor.dep"], true),
		entry("vendor.dep", ["vendor.leaf"]),
		entry("vendor.leaf"),
		entry("vendor.optional"),
		entry("vendor.configured", [], true),
	]
	const result = validateAdvisorRecommendations(
		JSON.stringify({ recommendations: inventory.map((item) => row(item.id)).concat(row("injected.command")) }),
		inventory,
	)
	expect(result).toEqual([row("vendor.optional")])
})
it("deduplicates IDs and rejects malformed responses", () => {
	expect(
		validateAdvisorRecommendations(
			JSON.stringify({ recommendations: [row("VENDOR.OPTIONAL"), row("vendor.optional")] }),
			[entry("vendor.optional")],
		),
	).toEqual([row("vendor.optional")])
	expect(() => validateAdvisorRecommendations("not json", [])).toThrow()
	expect(() => validateAdvisorRecommendations("{}", [])).toThrow()
})
it("streams current model output and usage without executing tool calls", async () => {
	mocks.createMessage.mockImplementation(async function* () {
		yield { type: "tool_call", name: "execute_command", arguments: "evil" }
		yield { type: "usage", inputTokens: 12, outputTokens: 8, totalCost: 0.001 }
		yield { type: "text", text: '{"recommendations":[]}' }
	})
	const result: AdvisorAIResult = {
		model: "",
		recommendations: [],
		usage: { inputTokens: 0, outputTokens: 0 },
		complete: false,
		files: 0,
		inventoryCount: 0,
	}
	const controller = new AbortController()
	await analyzeAdvisor({ apiProvider: "anthropic" }, {} as never, [], controller.signal, result, "test")
	expect(result.model).toBe("selected-model")
	expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 8, totalCost: 0.001 })
	expect(mocks.createMessage.mock.calls[0][2]).toEqual({
		signal: controller.signal,
		taskId: "test",
		tools: [],
		tool_choice: "none",
		allowedFunctionNames: [],
		parallelToolCalls: false,
		forceWebSearch: false,
		store: false,
		suppressPreviousResponseId: true,
	})
})
it("propagates provider errors and retains received usage", async () => {
	mocks.createMessage.mockImplementation(async function* () {
		yield { type: "usage", inputTokens: 2, outputTokens: 1 }
		yield { type: "error", message: "Provider unavailable" }
	})
	const result: AdvisorAIResult = {
		model: "",
		recommendations: [],
		usage: { inputTokens: 0, outputTokens: 0 },
		complete: false,
		files: 0,
		inventoryCount: 0,
	}
	await expect(
		analyzeAdvisor({ apiProvider: "anthropic" }, {} as never, [], new AbortController().signal, result, "test"),
	).rejects.toThrow("Provider unavailable")
	expect(result.usage.inputTokens).toBe(2)
})
it("rejects immediately for an already cancelled signal", async () => {
	const controller = new AbortController()
	controller.abort(new Error("stopped"))
	await expect(advisorWait(Promise.resolve(1), controller.signal)).rejects.toThrow("stopped")
})
