// kilocode_change - new file
import {
	buildImageOutputPath,
	findLatestConversationImage,
	extractResponsesImage,
	getInputImageMimeType,
	generateOpenAiImage,
	getOpenAiImageGenerationModel,
} from "../openAiImageGeneration"

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe("openAiImageGeneration", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("returns the selected model only when enabled for the OpenAI provider", () => {
		expect(
			getOpenAiImageGenerationModel({
				apiProvider: "openai",
				openAiImageGenerationEnabled: true,
				openAiImageGenerationModelId: " gpt-image-1 ",
			}),
		).toBe("gpt-image-1")
		expect(
			getOpenAiImageGenerationModel({
				apiProvider: "openai",
				openAiImageGenerationEnabled: true,
				openAiImageGenerationModelId: " ",
			}),
		).toBeUndefined()
		expect(
			getOpenAiImageGenerationModel({
				apiProvider: "openai",
				openAiImageGenerationEnabled: false,
				openAiImageGenerationModelId: "gpt-image-1",
			}),
		).toBeUndefined()
		expect(
			getOpenAiImageGenerationModel({
				apiProvider: "anthropic",
				openAiImageGenerationEnabled: true,
				openAiImageGenerationModelId: "gpt-image-1",
			}),
		).toBeUndefined()
	})

	it("always saves inside images_ivol with a sanitized name", () => {
		expect(buildImageOutputPath("../../etc/sunset.png", "png")).toBe("images_ivol/sunset.png")
		expect(buildImageOutputPath("my cat", "jpg")).toBe("images_ivol/my-cat.jpg")
		expect(buildImageOutputPath(undefined, "png", new Date("2026-10-30T09:00:00.000Z"))).toBe(
			"images_ivol/image-2026-10-30T09-00-00-000Z.png",
		)
	})

	it("posts to /images/generations with profile credentials and decodes b64_json", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }),
		}))
		vi.stubGlobal("fetch", fetchMock)

		const result = await generateOpenAiImage(
			{
				apiProvider: "openai",
				openAiBaseUrl: "https://proxy.example/v1/",
				openAiApiKey: "test-key",
				openAiHeaders: { "X-Test": "1" },
			},
			"gpt-image-1",
			"a red apple",
		)

		expect(result.extension).toBe("png")
		expect(result.data.equals(PNG_BYTES)).toBe(true)
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe("https://proxy.example/v1/images/generations")
		expect(JSON.parse(String(init.body))).toEqual({ model: "gpt-image-1", prompt: "a red apple", n: 1 })
		const headers = init.headers as Record<string, string>
		expect(headers["Authorization"]).toBe("Bearer test-key")
		expect(headers["X-Test"]).toBe("1")
	})

	it("sends an edit request as multipart to /images/edits", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }),
		}))
		vi.stubGlobal("fetch", fetchMock)

		await generateOpenAiImage(
			{ apiProvider: "openai", openAiBaseUrl: "https://proxy.example/v1", openAiApiKey: "k" },
			"gpt-image-1",
			"remove the background",
			{ inputImages: [{ data: PNG_BYTES, mimeType: "image/png", fileName: "shot.png" }] },
		)

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe("https://proxy.example/v1/images/edits")
		const form = init.body as FormData
		expect(form.get("model")).toBe("gpt-image-1")
		expect(form.get("prompt")).toBe("remove the background")
		const file = form.get("image") as File
		expect(file.name).toBe("shot.png")
		expect(file.type).toBe("image/png")
		// fetch must set the multipart boundary itself.
		expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined()
	})

	it("falls back to the Responses API image_generation tool when /images/edits is unsupported", async () => {
		const fetchMock = vi.fn(async (url: string) =>
			url.endsWith("/images/edits")
				? { ok: false, status: 500, text: async () => JSON.stringify({ error: { message: "unsupported" } }) }
				: {
						ok: true,
						status: 200,
						text: async () =>
							JSON.stringify({
								output: [{ type: "image_generation_call", result: PNG_BYTES.toString("base64") }],
							}),
					},
		)
		vi.stubGlobal("fetch", fetchMock)

		const result = await generateOpenAiImage(
			{
				apiProvider: "openai",
				openAiBaseUrl: "https://proxy.example/v1",
				openAiApiKey: "k",
				openAiWebSearchModelId: "carrier-model",
			},
			"gpt-image-1",
			"make it blue",
			{ inputImages: [{ data: PNG_BYTES, mimeType: "image/png", fileName: "shot.png" }] },
		)

		expect(result.data.equals(PNG_BYTES)).toBe(true)
		const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
		expect(url).toBe("https://proxy.example/v1/responses")
		const body = JSON.parse(String(init.body))
		expect(body.model).toBe("carrier-model")
		expect(body.tools).toEqual([{ type: "image_generation", model: "gpt-image-1" }])
		expect(body.input[0].content[1]).toEqual({
			type: "input_image",
			image_url: `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
		})
	})

	it("extracts the image from a Responses SSE stream", () => {
		const sse = [
			`data: ${JSON.stringify({ type: "response.created" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "image_generation_call", result: "QUJD" } })}`,
		].join("\n")
		expect(extractResponsesImage(sse)).toBe("QUJD")
	})

	it("finds the latest image in the conversation, including tool results", () => {
		const older = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }
		const newer = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } }
		const found = findLatestConversationImage([
			{ role: "user", content: [older] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{
				role: "user",
				content: [
					{ type: "tool_result", content: [newer] },
					{ type: "text", text: "edit it" },
				],
			},
		])
		expect(found?.mimeType).toBe("image/jpeg")
		expect(found?.fileName).toBe("input.jpg")
		expect(found?.data.equals(Buffer.from("BBBB", "base64"))).toBe(true)
		expect(findLatestConversationImage([{ role: "user", content: "text only" }])).toBeUndefined()
	})

	it("maps supported input image extensions", () => {
		expect(getInputImageMimeType("a/b/photo.JPG")).toBe("image/jpeg")
		expect(getInputImageMimeType("x.webp")).toBe("image/webp")
		expect(getInputImageMimeType("x.gif")).toBeUndefined()
	})

	it("reports the provider error message", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				status: 404,
				text: async () => JSON.stringify({ error: { message: "model not found" } }),
			})),
		)

		await expect(
			generateOpenAiImage({ apiProvider: "openai", openAiBaseUrl: "https://proxy.example/v1" }, "x", "p"),
		).rejects.toThrow("Image generation failed (404): model not found")
	})
})
