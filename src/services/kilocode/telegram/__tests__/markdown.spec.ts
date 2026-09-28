import { telegramMarkdown, splitTelegramEntities, type TelegramEntity } from "../markdown"
import { TelegramMessageRenderer } from "../TelegramMessageRenderer"
import { TelegramApi } from "../TelegramApi"
import { telegramPresentation } from "../presentation"

const metadata = '{"suggest":[{"answer":"Start code review","mode":"review"}]}'

it("renders the reported bold answer with actual entities, lists, emphasis, code and links", () => {
	const [part] = telegramMarkdown(
		"**Готово** и *курсив* `a < b`\n\n- один\n- два\n\n[сайт](https://example.org/?a=1&b=2)",
	)
	expect(part.text).toBe("Готово и курсив a < b\n\n• один\n\n• два\n\nсайт")
	expect(
		part.entities.map((entity) => [entity.type, part.text.slice(entity.offset, entity.offset + entity.length)]),
	).toEqual([
		["bold", "Готово"],
		["italic", "курсив"],
		["code", "a < b"],
		["text_link", "сайт"],
	])
	expect(part.entities.at(-1)?.url).toBe("https://example.org/?a=1&b=2")
})

it("keeps malicious HTML literal, blocks unsafe links and never fetches images", () => {
	const source =
		"<script>alert(1)</script>\n\n<b>literal &</b> [bad](javascript:alert) [data](data:text/html,evil) [file](file:///etc/passwd) [auth](https://user:pass@example.org) ![image](https://example.org/private)"
	const [part] = telegramMarkdown(source)
	expect(part.text).toContain("<script>alert(1)</script>")
	expect(part.text).toContain("<b>literal &</b>")
	expect(part.text).toContain("bad data file auth image")
	expect(part.entities).toEqual([])
	expect(telegramMarkdown("[escaped](java&#x73;cript:alert)")[0].entities).toEqual([])
	expect(telegramMarkdown("[ok][ref]\n\n[ref]: https://example.org")[0].entities[0]?.type).toBe("text_link")
})

it("splits long formatted links and fences into valid independent UTF16 entities without losing Unicode", () => {
	for (const wrap of [
		(text: string) => `**${text}**`,
		(text: string) => `[${text}](https://example.org)`,
		(text: string) => `\`\`\`ts\n${text}\n\`\`\``,
		(text: string) => `\`\`\`ts\n${text}`, // Streaming/unclosed fence.
	]) {
		const text = "😀<&>abc".repeat(1800)
		const parts = telegramMarkdown(wrap(text))
		expect(parts.length).toBeGreaterThan(2)
		expect(parts.map((part) => part.text).join("")).toBe(text)
		for (const part of parts) {
			expect(part.text.length).toBeLessThanOrEqual(4000)
			expect(Buffer.from(part.text).toString()).toBe(part.text)
			expect(part.entities.length).toBeGreaterThan(0)
			for (const entity of part.entities) {
				expect(entity.offset).toBeGreaterThanOrEqual(0)
				expect(entity.length).toBeGreaterThan(0)
				expect(entity.offset + entity.length).toBeLessThanOrEqual(part.text.length)
			}
		}
	}
})

it("handles nested inline code without forbidden overlapping pre/code entities and bounds entity count", () => {
	const [part] = telegramMarkdown("**bold `code` *italic***")
	const code = part.entities.find((entity) => entity.type === "code")!
	expect(
		part.entities
			.filter((entity) => entity !== code)
			.every(
				(entity) => entity.offset + entity.length <= code.offset || entity.offset >= code.offset + code.length,
			),
	).toBe(true)
	expect(telegramMarkdown("*x* ".repeat(200))[0].entities).toEqual([])
	expect(telegramMarkdown("**unfinished [link](\n`")).toHaveLength(1)
	expect(() => splitTelegramEntities("abc", [], 4097)).toThrow()
})

it("suppresses only completion ask metadata, including every partial prefix, never result or code JSON", () => {
	for (let end = 1; end <= metadata.length; end++) {
		expect(
			telegramPresentation({
				ts: 1,
				type: "ask",
				ask: "completion_result",
				text: metadata.slice(0, end),
				partial: true,
			}).kind,
		).toBe("ignore")
	}
	expect(telegramPresentation({ ts: 1, type: "ask", ask: "completion_result", text: metadata }).kind).toBe("ignore")
	for (const text of [
		"Done",
		'{"answer":42}',
		"```json\n" + metadata + "\n```",
		'{"suggest":"user data"}',
		'{"suggest":[],"result":"done"}',
	]) {
		expect(telegramPresentation({ ts: 1, type: "ask", ask: "completion_result", text }).text).toBe(text)
	}
	for (const say of ["text", "completion_result"] as const) {
		expect(telegramPresentation({ ts: 1, type: "say", say, text: metadata }).text).toBe(metadata)
	}
})

it("edits formatting-only changes, clears obsolete tails/entities/keyboards, and preserves plain approvals", async () => {
	let id = 0
	const api = {
		sendText: vi.fn(async (..._args: unknown[]) => [++id]),
		editText: vi.fn(async (..._args: unknown[]) => {}),
	}
	const signal = new AbortController().signal
	const renderer = new TelegramMessageRenderer(api as unknown as TelegramApi, 1, 2, signal)
	const keyboard = [[{ text: "yes", callback_data: "fixture" }]]
	await renderer.render("a", "**same**", undefined, true)
	await renderer.render("a", "*same*", undefined, true)
	expect(api.editText.mock.calls[0]?.[2]).toBe("same")
	expect(api.editText.mock.calls[0]?.[5]).toEqual([{ type: "italic", offset: 0, length: 4 }])
	await renderer.render("a", "*same*", undefined, true)
	expect(api.editText).toHaveBeenCalledTimes(1)
	await renderer.render("a", "**" + "😀".repeat(4500) + "**", () => keyboard, true)
	expect(api.sendText.mock.calls.at(-1)?.[4]).toEqual(keyboard)
	await renderer.render("a", "short", () => keyboard, true)
	expect(api.editText.mock.calls.slice(-3).map((call) => call[2])).toEqual(["short", "—", "—"])
	expect(
		api.editText.mock.calls.slice(-2).every((call) => call[4] === undefined && JSON.stringify(call[5]) === "[]"),
	).toBe(true)
	await renderer.render("approval", "**Review in IDE**", keyboard)
	expect(api.sendText.mock.calls.at(-1)?.[2]).toBe("**Review in IDE**")
	expect(api.sendText.mock.calls.at(-1)?.[5]).toEqual([])
})

it("sends and edits explicit entities through the API with no parse_mode or raw Markdown", async () => {
	vi.useFakeTimers()
	const bodies: Record<string, unknown>[] = []
	const api = new TelegramApi("123:fixture", async (_url, options) => {
		bodies.push(JSON.parse(String(options?.body)))
		return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }))
	})
	try {
		const text = "😀".repeat(2500)
		const entities: TelegramEntity[] = [{ type: "bold", offset: 0, length: text.length }]
		const sending = api.sendText(1, 2, text, undefined, undefined, entities)
		await vi.runAllTimersAsync()
		await sending
		expect(bodies).toHaveLength(2)
		expect(bodies[1].entities).toEqual([{ type: "bold", offset: 0, length: 1000 }])
		const editing = api.editText(1, 42, "<b>literal</b>", undefined, undefined, [])
		await vi.runAllTimersAsync()
		await editing
		expect(bodies.at(-1)?.entities).toEqual([])
		expect(bodies.every((body) => !("parse_mode" in body))).toBe(true)
	} finally {
		vi.useRealTimers()
	}
})
