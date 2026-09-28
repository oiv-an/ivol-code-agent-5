import { fromMarkdown } from "mdast-util-from-markdown"

export interface TelegramEntity {
	type: "bold" | "italic" | "code" | "pre" | "text_link"
	offset: number
	length: number
	url?: string
}
export interface TelegramTextPart {
	text: string
	entities: TelegramEntity[]
}

interface Node {
	type: string
	value?: string
	children?: Node[]
	url?: string
	identifier?: string
	alt?: string | null
	ordered?: boolean | null
	start?: number | null
}

function safeUrl(value: string | undefined): string | undefined {
	if (
		!value ||
		value.length > 2048 ||
		Array.from(value).some(
			(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || /\s/u.test(character),
		)
	)
		return undefined
	try {
		const url = new URL(value)
		return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password
			? url.href
			: undefined
	} catch {
		return undefined // Unsafe/unparseable destinations remain readable labels, never actions.
	}
}

/** Entity offsets and limits use UTF-16, exactly like Telegram. No HTML or parse_mode. */
export function splitTelegramEntities(text: string, entities: TelegramEntity[] = [], limit = 4000): TelegramTextPart[] {
	if (!Number.isInteger(limit) || limit < 2 || limit > 4096) throw new Error("Invalid Telegram chunk limit")
	const parts: TelegramTextPart[] = []
	for (let start = 0; start < text.length; ) {
		let end = Math.min(start + limit, text.length)
		if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--
		const clipped = entities.flatMap((entity) => {
			const left = Math.max(start, entity.offset)
			const right = Math.min(end, entity.offset + entity.length)
			return right > left ? [{ ...entity, offset: left - start, length: right - left }] : []
		})
		// A pathological model response must remain deliverable, not exceed Telegram's entity budget.
		parts.push({ text: text.slice(start, end), entities: clipped.length <= 100 ? clipped : [] })
		start = end
	}
	return parts
}

/** CommonMark AST, not regex substitution. Raw HTML is displayed as literal text. */
export function telegramMarkdown(source: string): TelegramTextPart[] {
	try {
		const root: Node = fromMarkdown(source)
		const definitions = new Map<string, string>()
		const collect = (node: Node): void => {
			if (node.type === "definition" && node.identifier && node.url) definitions.set(node.identifier, node.url)
			for (const child of node.children ?? []) collect(child)
		}
		collect(root)
		let text = ""
		const entities: TelegramEntity[] = []
		const append = (value: string, styles: Omit<TelegramEntity, "offset" | "length">[] = []) => {
			const offset = text.length
			text += value
			if (value.length) {
				const unique = styles.filter(
					(style, index) => styles.findIndex((other) => other.type === style.type) === index,
				)
				for (const style of unique) entities.push({ ...style, offset, length: value.length })
			}
		}
		const walk = (node: Node, styles: Omit<TelegramEntity, "offset" | "length">[] = []): void => {
			const children = () => {
				for (const child of node.children ?? []) walk(child, styles)
			}
			switch (node.type) {
				case "definition":
					return
				case "text":
				case "html":
					append(node.value ?? "", styles)
					return
				case "inlineCode":
					append(node.value ?? "", [{ type: "code" }])
					return
				case "code":
					append(node.value ?? "", [{ type: "pre" }])
					append("\n\n")
					return
				case "strong":
					styles = [...styles, { type: "bold" }]
					children()
					return
				case "emphasis":
					styles = [...styles, { type: "italic" }]
					children()
					return
				case "heading":
					styles = [...styles, { type: "bold" }]
					children()
					append("\n\n")
					return
				case "link":
				case "linkReference": {
					const url = safeUrl(node.url ?? definitions.get(node.identifier ?? ""))
					if (url) styles = [...styles, { type: "text_link", url }]
					children()
					return
				}
				case "image":
				case "imageReference":
					append(node.alt || "[image]", styles)
					return
				case "break":
					append("\n")
					return
				case "thematicBreak":
					append("—\n\n")
					return
				case "list":
					for (const [index, child] of (node.children ?? []).entries()) {
						append(node.ordered ? `${(node.start ?? 1) + index}. ` : "• ")
						walk(child, styles)
					}
					return
				case "paragraph":
					children()
					append("\n\n")
					return
				default:
					children()
			}
		}
		walk(root)
		text = text.trimEnd()
		return splitTelegramEntities(text || source || "…", entities)
	} catch {
		// Includes excessive nesting/parser failures. Never disconnect a route on malformed Markdown.
		return splitTelegramEntities(source || "…")
	}
}
