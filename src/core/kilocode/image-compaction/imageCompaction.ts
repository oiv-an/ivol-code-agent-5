// kilocode_change - new file
/**
 * Image compaction for conversation history.
 *
 * Providers reject requests whose images are too large (for example Anthropic's
 * 2000 px per-side limit for requests with many images), and old screenshots
 * keep costing context on every later request. This module:
 *  - caps every image in an outgoing request to REQUEST_IMAGE_MAX_SIDE, and
 *  - shrinks images the model has already seen to HISTORY_IMAGE_MAX_SIDE JPEG.
 *
 * Only PNG and JPEG are decoded (pure JS, no native binaries). Other formats and
 * images that fail to decode are left unchanged.
 */
import { PNG } from "pngjs"
import jpeg from "jpeg-js"

export const REQUEST_IMAGE_MAX_SIDE = 2000
export const HISTORY_IMAGE_MAX_SIDE = 1024
export const HISTORY_IMAGE_JPEG_QUALITY = 70
const REQUEST_IMAGE_JPEG_QUALITY = 85
// Already-small PNGs above this base64 size are still re-encoded as JPEG in history.
const HISTORY_PNG_MAX_BASE64_CHARS = 400_000

export interface ImageCompactionOptions {
	maxSide: number
	quality: number
	/** Re-encode large PNGs as JPEG even when their dimensions already fit. */
	reencodeLargePng?: boolean
}

export const requestImageOptions: ImageCompactionOptions = {
	maxSide: REQUEST_IMAGE_MAX_SIDE,
	quality: REQUEST_IMAGE_JPEG_QUALITY,
}

export const historyImageOptions: ImageCompactionOptions = {
	maxSide: HISTORY_IMAGE_MAX_SIDE,
	quality: HISTORY_IMAGE_JPEG_QUALITY,
	reencodeLargePng: true,
}

interface Dimensions {
	width: number
	height: number
}

/** Reads width/height from a PNG or JPEG header without decoding pixels. */
export function readImageDimensions(buffer: Buffer): Dimensions | undefined {
	// PNG: 8-byte signature, IHDR chunk with width/height at offsets 16/20.
	if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.toString("ascii", 12, 16) === "IHDR") {
		return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
	}
	// JPEG: walk markers until a start-of-frame segment.
	if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
		let offset = 2
		while (offset + 9 < buffer.length) {
			if (buffer[offset] !== 0xff) {
				offset++
				continue
			}
			const marker = buffer[offset + 1]
			if (marker === 0xff) {
				offset++
				continue
			}
			if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				offset += 2
				continue
			}
			const length = buffer.readUInt16BE(offset + 2)
			const isStartOfFrame =
				marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
			if (isStartOfFrame) {
				return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
			}
			offset += 2 + length
		}
	}
	return undefined
}

function decodeRgba(buffer: Buffer, mediaType: string): { width: number; height: number; data: Uint8Array } {
	if (mediaType === "image/png") {
		const png = PNG.sync.read(buffer)
		return { width: png.width, height: png.height, data: png.data }
	}
	const decoded = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 })
	return { width: decoded.width, height: decoded.height, data: decoded.data }
}

/** Area-averaging downscale of RGBA pixels; transparent pixels are composited on white. */
function resizeRgba(src: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number): Uint8Array {
	const dst = new Uint8Array(dstW * dstH * 4)
	const scaleX = srcW / dstW
	const scaleY = srcH / dstH
	for (let y = 0; y < dstH; y++) {
		const y0 = Math.floor(y * scaleY)
		const y1 = Math.max(y0 + 1, Math.min(srcH, Math.floor((y + 1) * scaleY)))
		for (let x = 0; x < dstW; x++) {
			const x0 = Math.floor(x * scaleX)
			const x1 = Math.max(x0 + 1, Math.min(srcW, Math.floor((x + 1) * scaleX)))
			let r = 0
			let g = 0
			let b = 0
			let count = 0
			for (let sy = y0; sy < y1; sy++) {
				let i = (sy * srcW + x0) * 4
				for (let sx = x0; sx < x1; sx++, i += 4) {
					const a = src[i + 3] / 255
					r += src[i] * a + 255 * (1 - a)
					g += src[i + 1] * a + 255 * (1 - a)
					b += src[i + 2] * a + 255 * (1 - a)
					count++
				}
			}
			const o = (y * dstW + x) * 4
			dst[o] = r / count
			dst[o + 1] = g / count
			dst[o + 2] = b / count
			dst[o + 3] = 255
		}
	}
	return dst
}

/**
 * Returns a compressed JPEG version of the image, or undefined when the image
 * already fits the options, is not PNG/JPEG, or cannot be decoded.
 */
export function compactImageBase64(
	data: string,
	mediaType: string,
	options: ImageCompactionOptions,
): { data: string; mediaType: "image/jpeg" } | undefined {
	const type = mediaType === "image/jpg" ? "image/jpeg" : mediaType
	if (type !== "image/png" && type !== "image/jpeg") return undefined

	try {
		const buffer = Buffer.from(data, "base64")
		const dims = readImageDimensions(buffer)
		if (!dims || dims.width <= 0 || dims.height <= 0) return undefined

		const longest = Math.max(dims.width, dims.height)
		const tooLarge = longest > options.maxSide
		const heavyPng =
			!!options.reencodeLargePng && type === "image/png" && data.length > HISTORY_PNG_MAX_BASE64_CHARS
		if (!tooLarge && !heavyPng) return undefined

		const decoded = decodeRgba(buffer, type)
		const scale = Math.min(1, options.maxSide / Math.max(decoded.width, decoded.height))
		const width = Math.max(1, Math.round(decoded.width * scale))
		const height = Math.max(1, Math.round(decoded.height * scale))
		const pixels = resizeRgba(decoded.data, decoded.width, decoded.height, width, height)
		const encoded = jpeg.encode({ data: pixels, width, height }, options.quality)
		const result = Buffer.from(encoded.data).toString("base64")
		// Never replace an image with a bigger one unless it had to be shrunk.
		if (!tooLarge && result.length >= data.length) return undefined
		return { data: result, mediaType: "image/jpeg" }
	} catch (error) {
		console.warn(`[imageCompaction] Failed to compress ${mediaType} image:`, error)
		return undefined
	}
}

type ContentBlock = { type: string; [key: string]: any }

function compactBlocks(blocks: ContentBlock[], options: ImageCompactionOptions): ContentBlock[] | undefined {
	let changed = false
	const next = blocks.map((block) => {
		if (block?.type === "image" && block.source?.type === "base64" && typeof block.source.data === "string") {
			const compacted = compactImageBase64(block.source.data, block.source.media_type, options)
			if (!compacted) return block
			changed = true
			return { ...block, source: { ...block.source, media_type: compacted.mediaType, data: compacted.data } }
		}
		if (block?.type === "tool_result" && Array.isArray(block.content)) {
			const inner = compactBlocks(block.content, options)
			if (!inner) return block
			changed = true
			return { ...block, content: inner }
		}
		return block
	})
	return changed ? next : undefined
}

/**
 * Compresses images in the given messages (top-level and inside tool_result).
 * Returns the same array instance when nothing changed.
 */
export function compactMessageImages<T extends { content: unknown }>(
	messages: T[],
	options: ImageCompactionOptions,
): { messages: T[]; changed: boolean } {
	let changed = false
	const next = messages.map((message) => {
		if (!Array.isArray(message.content)) return message
		const content = compactBlocks(message.content as ContentBlock[], options)
		if (!content) return message
		changed = true
		return { ...message, content } as T
	})
	return { messages: changed ? next : messages, changed }
}

/** Index of the last user message, i.e. the turn the model has not answered yet. */
export function findLastUserMessageIndex(messages: { role: string }[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return i
	}
	return -1
}
