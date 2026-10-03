import type { ClineMessage } from "@roo-code/types"

export interface ChatSearchHit {
	ts: number
	kind: string
	snippet: string
}
export interface ChatSearchResult {
	hits: ChatSearchHit[]
	nextBefore?: number
}

// Search original text, not transport previews. Literal matching avoids regex execution.
// Results are bounded and newest-first; no persistent index or duplicate transcript is built.
export function searchChatHistory(messages: readonly ClineMessage[], query: string, before?: number): ChatSearchResult {
	const needle = query.trim().toLowerCase()
	if (!needle || needle.length > 200) return { hits: [] }
	const hits: ChatSearchHit[] = []
	for (let i = messages.length - 1; i >= 0; i--) {
		const row = messages[i]
		if (before !== undefined && row.ts >= before) continue
		const text = row.text ?? ""
		const index = text.toLowerCase().indexOf(needle)
		if (index < 0) continue
		if (hits.length === 20) return { hits, nextBefore: hits.at(-1)!.ts }
		const start = Math.max(0, index - 100)
		hits.push({
			ts: row.ts,
			kind: row.ask ?? row.say ?? row.type,
			snippet: (start ? "…" : "") + text.slice(start, start + 500) + (start + 500 < text.length ? "…" : ""),
		})
	}
	return { hits }
}

export function chatHistoryContext(messages: readonly ClineMessage[], ts: number, query = ""): ClineMessage[] {
	const index = messages.findIndex((row) => row.ts === ts)
	if (index < 0) return []
	return messages.slice(Math.max(0, index - 3), index + 4).map((row) => {
		const text = row.text ?? ""
		const match = row.ts === ts && query ? text.toLowerCase().indexOf(query.toLowerCase()) : 0
		const start = Math.max(0, match - 1000)
		return {
			ts: row.ts,
			type: row.type,
			ask: row.ask,
			say: row.say,
			pinned: row.pinned,
			uiImageCount: row.images?.length,
			uiTruncated: true,
			text: (start ? "…" : "") + text.slice(start, start + 3000) + (start + 3000 < text.length ? "…" : ""),
		}
	})
}
