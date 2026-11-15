// kilocode_change - new file
/**
 * Automatic model pricing from the public OpenRouter catalog.
 *
 * OpenAI-compatible endpoints (proxies, gateways) usually expose models under
 * custom aliases such as `3-claude-opus` and do not report prices. When the
 * user has not entered prices for such a profile, we look the model up in the
 * public OpenRouter catalog (https://openrouter.ai/api/v1/models) and use its
 * prices for cost accounting. The catalog is cached for 24 hours in memory and
 * on disk. Manually entered prices always take precedence.
 */
import * as fs from "fs/promises"
import * as path from "path"

import type { ModelInfo } from "@roo-code/types"

import { ContextProxy } from "../../../core/config/ContextProxy"
import { getCacheDirectoryPath } from "../../../utils/storage"
import { parseApiPrice } from "../../../shared/cost"

export const OPENROUTER_PRICING_URL = "https://openrouter.ai/api/v1/models"
export const OPENROUTER_PRICING_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
const FAILURE_BACKOFF_MS = 10 * 60 * 1000
const CACHE_FILENAME = "openrouter_pricing.json"

export interface OpenRouterPriceEntry {
	id: string
	created: number
	inputPrice: number
	outputPrice: number
	cacheReadsPrice?: number
	cacheWritesPrice?: number
}

export interface OpenRouterPriceCatalog {
	fetchedAt: number
	entries: OpenRouterPriceEntry[]
}

export interface OpenRouterPricingMatch extends OpenRouterPriceEntry {
	/** Model ID that was looked up (the profile's model ID). */
	requestedId: string
}

let memoryCatalog: OpenRouterPriceCatalog | undefined
let inFlight: Promise<OpenRouterPriceCatalog | undefined> | undefined
let lastFailureAt = 0

const isFresh = (catalog: OpenRouterPriceCatalog | undefined, now: number) =>
	!!catalog && now - catalog.fetchedAt < OPENROUTER_PRICING_TTL_MS

/** Parses the raw `/models` response into price entries (USD per 1M tokens). */
export function parseOpenRouterPriceCatalog(json: unknown): OpenRouterPriceEntry[] {
	const data = (json as { data?: unknown })?.data
	if (!Array.isArray(data)) {
		return []
	}

	const entries: OpenRouterPriceEntry[] = []
	for (const raw of data) {
		const id = typeof raw?.id === "string" ? raw.id : undefined
		// Skip routing aliases (`~anthropic/...-latest`, `openrouter/auto`) and
		// variants such as `:batch`, `:free`, `:thinking` — they are not the base price.
		if (!id || id.startsWith("~") || id.includes(":") || id.startsWith("openrouter/")) {
			continue
		}
		const pricing = raw?.pricing ?? {}
		const inputPrice = parseApiPrice(pricing.prompt)
		const outputPrice = parseApiPrice(pricing.completion)
		if (!inputPrice || !outputPrice || inputPrice < 0 || outputPrice < 0) {
			continue
		}
		const cacheReadsPrice = parseApiPrice(pricing.input_cache_read)
		const cacheWritesPrice = parseApiPrice(pricing.input_cache_write)
		entries.push({
			id,
			created: typeof raw?.created === "number" ? raw.created : 0,
			inputPrice,
			outputPrice,
			...(cacheReadsPrice && cacheReadsPrice > 0 ? { cacheReadsPrice } : {}),
			...(cacheWritesPrice && cacheWritesPrice > 0 ? { cacheWritesPrice } : {}),
		})
	}
	return entries
}

/**
 * Normalizes a model ID for comparison:
 * `anthropic/claude-opus-4.5` → `claude-opus-4-5`, `3-claude-opus` → `claude-opus`,
 * `claude-sonnet-4-20250514` → `claude-sonnet-4`.
 */
export function normalizeModelId(id: string): string {
	let value = id.trim().toLowerCase()
	value = value.slice(value.lastIndexOf("/") + 1)
	value = value.split(":")[0]
	value = value.replace(/[\s_.]+/g, "-")
	// Local alias prefixes such as `1-gpt-sol` or `3-claude-opus`.
	value = value.replace(/^\d+-(?=[a-z])/, "")
	// Date stamps and floating aliases.
	value = value.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "")
	value = value.replace(/-latest$/, "")
	return value.replace(/-+/g, "-").replace(/^-|-$/g, "")
}

const splitTokens = (normalized: string) => {
	const tokens = normalized.split("-").filter(Boolean)
	return {
		words: tokens.filter((token) => !/^\d+$/.test(token)),
		numbers: tokens.filter((token) => /^\d+$/.test(token)).map(Number),
	}
}

const sameWords = (a: string[], b: string[]) => {
	if (a.length !== b.length) {
		return false
	}
	const sortedA = [...a].sort()
	const sortedB = [...b].sort()
	return sortedA.every((word, index) => word === sortedB[index])
}

const compareVersions = (a: number[], b: number[]) => {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? -1) - (b[i] ?? -1)
		if (diff !== 0) {
			return diff
		}
	}
	return 0
}

/** Newest first: by OpenRouter `created`, then by version numbers. */
const pickNewest = (candidates: OpenRouterPriceEntry[]) =>
	[...candidates].sort(
		(a, b) =>
			b.created - a.created ||
			compareVersions(splitTokens(normalizeModelId(b.id)).numbers, splitTokens(normalizeModelId(a.id)).numbers),
	)[0]

/**
 * Finds the OpenRouter model for a profile model ID.
 * 1. Exact match of the normalized ID (`claude-opus-5-5` ↔ `anthropic/claude-opus-5.5`).
 * 2. Same name words and the requested version as prefix (`claude-opus-5` → newest `claude-opus-5.x`).
 * 3. No version requested (`3-claude-opus`) → the newest model of that family.
 */
export function matchOpenRouterModel(
	modelId: string,
	entries: OpenRouterPriceEntry[],
): OpenRouterPriceEntry | undefined {
	if (!modelId || entries.length === 0) {
		return undefined
	}

	const lowered = modelId.trim().toLowerCase()
	const direct = entries.find((entry) => entry.id.toLowerCase() === lowered)
	if (direct) {
		return direct
	}

	const normalized = normalizeModelId(modelId)
	if (!normalized) {
		return undefined
	}

	const exact = entries.filter((entry) => normalizeModelId(entry.id) === normalized)
	if (exact.length > 0) {
		return pickNewest(exact)
	}

	const query = splitTokens(normalized)
	if (query.words.length === 0) {
		return undefined
	}

	const family = entries.filter((entry) => {
		const candidate = splitTokens(normalizeModelId(entry.id))
		if (!sameWords(candidate.words, query.words)) {
			return false
		}
		return query.numbers.every((value, index) => candidate.numbers[index] === value)
	})

	return family.length > 0 ? pickNewest(family) : undefined
}

async function getCacheFilePath(): Promise<string | undefined> {
	try {
		const globalStoragePath = ContextProxy.instance?.globalStorageUri?.fsPath
		if (!globalStoragePath) {
			return undefined
		}
		const cacheDir = await getCacheDirectoryPath(globalStoragePath)
		return path.join(cacheDir, CACHE_FILENAME)
	} catch (error) {
		console.warn("[openrouter-pricing] cache directory unavailable:", error)
		return undefined
	}
}

async function readDiskCatalog(): Promise<OpenRouterPriceCatalog | undefined> {
	const filePath = await getCacheFilePath()
	if (!filePath) {
		return undefined
	}
	try {
		const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as OpenRouterPriceCatalog
		if (typeof parsed?.fetchedAt === "number" && Array.isArray(parsed.entries)) {
			return parsed
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			console.warn("[openrouter-pricing] failed to read cache:", error)
		}
	}
	return undefined
}

async function writeDiskCatalog(catalog: OpenRouterPriceCatalog): Promise<void> {
	const filePath = await getCacheFilePath()
	if (!filePath) {
		return
	}
	try {
		await fs.writeFile(filePath, JSON.stringify(catalog), "utf8")
	} catch (error) {
		console.warn("[openrouter-pricing] failed to write cache:", error)
	}
}

async function fetchCatalog(): Promise<OpenRouterPriceCatalog> {
	const response = await fetch(OPENROUTER_PRICING_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
	if (!response.ok) {
		throw new Error(`OpenRouter models request failed: HTTP ${response.status}`)
	}
	const entries = parseOpenRouterPriceCatalog(await response.json())
	if (entries.length === 0) {
		throw new Error("OpenRouter models response contains no priced models")
	}
	return { fetchedAt: Date.now(), entries }
}

/**
 * Returns a catalog not older than 24 hours, loading it from disk or OpenRouter
 * when needed. Never throws: on failure the last known (possibly stale) catalog
 * is returned and new network attempts are paused for 10 minutes.
 */
export async function ensureOpenRouterPriceCatalog(options?: {
	force?: boolean
}): Promise<OpenRouterPriceCatalog | undefined> {
	const now = Date.now()
	if (!options?.force && isFresh(memoryCatalog, now)) {
		return memoryCatalog
	}
	if (inFlight) {
		return inFlight
	}

	inFlight = (async () => {
		try {
			if (!options?.force) {
				const disk = memoryCatalog ? undefined : await readDiskCatalog()
				if (disk && (!memoryCatalog || disk.fetchedAt > memoryCatalog.fetchedAt)) {
					memoryCatalog = disk
				}
				if (isFresh(memoryCatalog, Date.now())) {
					return memoryCatalog
				}
				if (Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) {
					return memoryCatalog
				}
			}
			const catalog = await fetchCatalog()
			memoryCatalog = catalog
			lastFailureAt = 0
			await writeDiskCatalog(catalog)
			return catalog
		} catch (error) {
			lastFailureAt = Date.now()
			console.warn("[openrouter-pricing] failed to refresh OpenRouter prices:", error)
			return memoryCatalog
		} finally {
			inFlight = undefined
		}
	})()

	return inFlight
}

/** Starts loading the catalog in the background (no-op in unit tests). */
export function warmOpenRouterPriceCatalog(): void {
	if (process.env.VITEST) {
		return
	}
	void ensureOpenRouterPriceCatalog()
}

/**
 * Waits for the catalog at most `timeoutMs` so a request is not delayed by a
 * slow network; the load continues in the background after the timeout.
 */
export async function waitForOpenRouterPriceCatalog(timeoutMs = 3_000): Promise<void> {
	if (process.env.VITEST || isFresh(memoryCatalog, Date.now())) {
		return
	}
	let timer: NodeJS.Timeout | undefined
	await Promise.race([
		ensureOpenRouterPriceCatalog(),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs)
		}),
	])
	if (timer) {
		clearTimeout(timer)
	}
}

/** Synchronous lookup in the already loaded catalog. */
export function resolveOpenRouterPricing(modelId: string): OpenRouterPricingMatch | undefined {
	const entry = memoryCatalog ? matchOpenRouterModel(modelId, memoryCatalog.entries) : undefined
	return entry ? { ...entry, requestedId: modelId } : undefined
}

const hasManualPrices = (info: ModelInfo) => (info.inputPrice ?? 0) > 0 || (info.outputPrice ?? 0) > 0

/**
 * Fills missing prices from the cached OpenRouter catalog. Profiles with
 * manually entered input/output prices are returned unchanged.
 */
export function applyOpenRouterPricing(info: ModelInfo, modelId: string): ModelInfo {
	if (hasManualPrices(info)) {
		return info
	}
	const match = resolveOpenRouterPricing(modelId)
	if (!match) {
		return info
	}
	return {
		...info,
		inputPrice: match.inputPrice,
		outputPrice: match.outputPrice,
		...(match.cacheReadsPrice !== undefined ? { cacheReadsPrice: match.cacheReadsPrice } : {}),
		...(match.cacheWritesPrice !== undefined ? { cacheWritesPrice: match.cacheWritesPrice } : {}),
	}
}

/** Test helper. */
export function __setOpenRouterPriceCatalogForTests(catalog: OpenRouterPriceCatalog | undefined) {
	memoryCatalog = catalog
	inFlight = undefined
	lastFailureAt = 0
}
