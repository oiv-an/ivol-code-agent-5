// kilocode_change - new file
import { OpenAiHandler } from "../../openai"
import { isOpenAiTransportError, OpenAiTransportError } from "../openai-transport-error"

const mocks = vi.hoisted(() => ({ create: vi.fn(), constructor: vi.fn() }))
vi.mock("openai", () => {
	const constructor = vi.fn().mockImplementation((options) => {
		mocks.constructor(options)
		return { chat: { completions: { create: mocks.create } } }
	})
	return { default: constructor, AzureOpenAI: constructor }
})

const messages = [{ role: "user" as const, content: "test request" }]
const chunk = { choices: [{ delta: { content: "test response" } }] }
const completed = { choices: [{ message: { content: "test response" } }] }

async function collect(stream: AsyncIterable<unknown>) {
	const values = []
	for await (const value of stream) values.push(value)
	return values
}

describe("OpenAI task transport lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.create.mockImplementation(async (options) =>
			options.stream
				? (async function* () {
						yield chunk
					})()
				: completed,
		)
	})

	it.each([
		{ model: "custom-gpt", streaming: true, azure: false },
		{ model: "custom-gpt", streaming: false, azure: false },
		{ model: "o3-mini", streaming: true, azure: false },
		{ model: "o3-mini", streaming: false, azure: false },
		{ model: "custom-gpt", streaming: true, azure: true },
		{ model: "o3-mini", streaming: false, azure: true },
	])("passes task cancellation and one-attempt policy: $model/$streaming/$azure", async (config) => {
		const controller = new AbortController()
		const handler = new OpenAiHandler({
			openAiBaseUrl: config.azure ? "https://example.services.ai.azure.com" : "https://example.invalid/v1",
			openAiApiKey: "fixture-only",
			openAiModelId: config.model,
			openAiStreamingEnabled: config.streaming,
		})
		await collect(
			handler.createMessage("test system", messages, { taskId: "test-task", signal: controller.signal }),
		)
		expect(mocks.create).toHaveBeenCalledTimes(1)
		expect(mocks.create.mock.calls[0][1]).toEqual({
			signal: controller.signal,
			maxRetries: 0,
			...(config.azure ? { path: "/models/chat/completions" } : {}),
		})
		expect(mocks.constructor.mock.calls[0][0].fetch).toBeTypeOf("function")
	})

	it("preserves the task signal across a server-rejected cache dialect fallback", async () => {
		const controller = new AbortController()
		const handler = new OpenAiHandler({
			openAiBaseUrl: "https://example.invalid/v1",
			openAiApiKey: "fixture-only",
			openAiModelId: "custom-gpt",
		})
		mocks.create.mockRejectedValueOnce({ status: 400, message: "cache_control is not allowed" })
		await collect(
			handler.createMessage("test system", messages, { taskId: "test-task", signal: controller.signal }),
		)
		expect(mocks.create).toHaveBeenCalledTimes(2)
		for (const [, request] of mocks.create.mock.calls) {
			expect(request).toEqual({ signal: controller.signal, maxRetries: 0 })
		}
	})

	it.each(["before headers", "during stream"])("normalizes %s failures without logging raw cause", async (phase) => {
		const raw = Object.assign(new TypeError("terminated"), {
			cause: Object.assign(new Error("private-fixture-response"), { code: "UND_ERR_SOCKET" }),
		})
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			mocks.create.mockImplementation(async () => {
				if (phase === "before headers") throw raw
				return (async function* () {
					yield chunk
					throw raw
				})()
			})
			const handler = new OpenAiHandler({ openAiModelId: "custom-gpt" })
			const error = await collect(handler.createMessage("test system", messages)).catch((failure) => failure)
			expect(error).toBeInstanceOf(OpenAiTransportError)
			expect(error.cause).toEqual({ code: "UND_ERR_SOCKET" })
			expect(isOpenAiTransportError(error)).toBe(true)
			expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain("private-fixture")
			expect(log).not.toHaveBeenCalled()
		} finally {
			log.mockRestore()
		}
	})

	it("does not turn the SDK's silent aborted stream into success or a retryable error", async () => {
		const controller = new AbortController()
		mocks.create.mockResolvedValueOnce(
			(async function* () {
				yield* [] // The SDK closes silently instead of yielding an error on abort.
				controller.abort()
			})(),
		)
		const handler = new OpenAiHandler({ openAiModelId: "custom-gpt" })
		const error = await collect(
			handler.createMessage("test system", messages, { taskId: "test-task", signal: controller.signal }),
		).catch((failure) => failure)
		expect(error.name).toBe("AbortError")
		expect(isOpenAiTransportError(error)).toBe(false)
		expect(mocks.create).toHaveBeenCalledTimes(1)
	})
})
