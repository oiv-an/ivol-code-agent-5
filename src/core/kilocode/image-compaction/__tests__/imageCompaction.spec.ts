// kilocode_change - new file
import { PNG } from "pngjs"
import jpeg from "jpeg-js"

import {
	compactImageBase64,
	compactMessageImages,
	findLastUserMessageIndex,
	historyImageOptions,
	readImageDimensions,
	requestImageOptions,
} from "../imageCompaction"

function makePng(width: number, height: number): string {
	const png = new PNG({ width, height })
	for (let i = 0; i < png.data.length; i += 4) {
		png.data[i] = (i / 4) % 256
		png.data[i + 1] = 128
		png.data[i + 2] = 64
		png.data[i + 3] = 255
	}
	return PNG.sync.write(png).toString("base64")
}

function makeJpeg(width: number, height: number): string {
	const data = Buffer.alloc(width * height * 4, 200)
	return Buffer.from(jpeg.encode({ data, width, height }, 80).data).toString("base64")
}

describe("imageCompaction", () => {
	it("reads PNG and JPEG dimensions from headers", () => {
		expect(readImageDimensions(Buffer.from(makePng(30, 20), "base64"))).toEqual({ width: 30, height: 20 })
		expect(readImageDimensions(Buffer.from(makeJpeg(40, 25), "base64"))).toEqual({ width: 40, height: 25 })
	})

	it("downscales an oversized image to the max side as JPEG", () => {
		const result = compactImageBase64(makePng(3200, 400), "image/png", requestImageOptions)
		expect(result?.mediaType).toBe("image/jpeg")
		expect(readImageDimensions(Buffer.from(result!.data, "base64"))).toEqual({ width: 2000, height: 250 })
	})

	it("leaves images that already fit unchanged", () => {
		expect(compactImageBase64(makeJpeg(800, 600), "image/jpeg", historyImageOptions)).toBeUndefined()
		expect(compactImageBase64(makePng(100, 100), "image/png", requestImageOptions)).toBeUndefined()
		expect(compactImageBase64("abc", "image/gif", requestImageOptions)).toBeUndefined()
	})

	it("compresses images nested in tool results and keeps unchanged messages identical", () => {
		const big = makeJpeg(1500, 1200)
		const untouched = { role: "user", content: "hello" }
		const messages = [
			untouched,
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: big } }],
					},
				],
			},
		]
		const { messages: next, changed } = compactMessageImages(messages, historyImageOptions)
		expect(changed).toBe(true)
		expect(next[0]).toBe(untouched)
		const image = (next[1].content as any)[0].content[0]
		expect(readImageDimensions(Buffer.from(image.source.data, "base64"))).toEqual({ width: 1024, height: 819 })
	})

	it("returns the same array when nothing changes", () => {
		const messages = [{ role: "user", content: [{ type: "text", text: "x" }] }]
		const result = compactMessageImages(messages, historyImageOptions)
		expect(result.changed).toBe(false)
		expect(result.messages).toBe(messages)
	})

	it("finds the last user message", () => {
		expect(findLastUserMessageIndex([{ role: "user" }, { role: "assistant" }, { role: "user" }])).toBe(2)
		expect(findLastUserMessageIndex([{ role: "assistant" }])).toBe(-1)
	})
})
