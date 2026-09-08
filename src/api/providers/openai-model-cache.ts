import { createHash } from "node:crypto"

// kilocode_change start: durable last-known-good OpenAI-compatible model catalogs
export const OPENAI_MODEL_CATALOG_CACHE_STORAGE_PREFIX = "ivol.openAiModelCatalogCache.v2"
export const LEGACY_OPENAI_MODEL_CATALOG_CACHE_STORAGE_KEY = "ivol.openAiModelCatalogCache.v1"
export const DEFAULT_OPENAI_MODEL_CATALOG_MAX_MODELS = 1_000

export interface OpenAiModelCatalogIdentity {
	profileId: string
	baseUrl?: string
	allowInsecureTls?: boolean // kilocode_change: isolate unverified catalogs from verified profiles
}

export interface OpenAiModelCatalogCacheStorage {
	get<T>(key: string): T | undefined
	update(key: string, value: unknown): PromiseLike<void>
}

export interface OpenAiModelCatalogCacheOptions {
	maxModels?: number
	now?: () => number
	log?: (message: string) => void
}

interface OpenAiModelCatalogCacheEntry {
	version: 2
	endpointFingerprint: string
	models: string[]
	updatedAt: number
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

const normalizeBaseUrl = (baseUrl?: string) => {
	const value = baseUrl?.trim() ?? ""

	try {
		const url = new URL(value)
		url.hash = ""
		url.pathname = url.pathname.replace(/\/+$/, "")
		return url.toString().replace(/\/$/, "")
	} catch {
		return value.replace(/\/+$/, "")
	}
}

export const getOpenAiModelCatalogStorageKey = ({ profileId, allowInsecureTls }: OpenAiModelCatalogIdentity) =>
	`${OPENAI_MODEL_CATALOG_CACHE_STORAGE_PREFIX}.${sha256(profileId.trim())}${allowInsecureTls === true ? ".insecure-tls" : ""}`

export const getOpenAiModelCatalogEndpointFingerprint = ({ baseUrl }: OpenAiModelCatalogIdentity) =>
	sha256(normalizeBaseUrl(baseUrl))

const sanitizeModels = (models: unknown, maxModels: number): string[] => {
	if (!Array.isArray(models)) {
		return []
	}

	const uniqueModels = new Set<string>()

	for (const model of models) {
		if (typeof model !== "string") {
			continue
		}

		const modelId = model.trim()

		if (!modelId || uniqueModels.has(modelId)) {
			continue
		}

		uniqueModels.add(modelId)

		if (uniqueModels.size >= maxModels) {
			break
		}
	}

	return [...uniqueModels]
}

const isCacheEntry = (value: unknown): value is OpenAiModelCatalogCacheEntry => {
	if (!value || typeof value !== "object") {
		return false
	}

	const entry = value as Partial<OpenAiModelCatalogCacheEntry>
	return (
		entry.version === 2 &&
		typeof entry.endpointFingerprint === "string" &&
		/^[a-f0-9]{64}$/.test(entry.endpointFingerprint) &&
		Array.isArray(entry.models) &&
		typeof entry.updatedAt === "number" &&
		Number.isFinite(entry.updatedAt)
	)
}

export class OpenAiModelCatalogCache {
	private readonly maxModels: number
	private readonly now: () => number
	private readonly log: (message: string) => void

	constructor(
		private readonly storage: OpenAiModelCatalogCacheStorage,
		options: OpenAiModelCatalogCacheOptions = {},
	) {
		this.maxModels = Math.max(1, Math.floor(options.maxModels ?? DEFAULT_OPENAI_MODEL_CATALOG_MAX_MODELS))
		this.now = options.now ?? Date.now
		this.log = options.log ?? (() => undefined)
	}

	get(identity: OpenAiModelCatalogIdentity): string[] {
		try {
			if (!identity.profileId.trim()) {
				return []
			}

			const entry = this.storage.get<unknown>(getOpenAiModelCatalogStorageKey(identity))

			if (!isCacheEntry(entry)) {
				return []
			}

			if (entry.endpointFingerprint !== getOpenAiModelCatalogEndpointFingerprint(identity)) {
				return []
			}

			return sanitizeModels(entry.models, this.maxModels)
		} catch {
			return []
		}
	}

	async purgeLegacyCache(): Promise<void> {
		try {
			await this.storage.update(LEGACY_OPENAI_MODEL_CATALOG_CACHE_STORAGE_KEY, undefined)
		} catch {
			// The legacy entry is best-effort cleanup only; never delay or break model discovery.
		}
	}

	async put(identity: OpenAiModelCatalogIdentity, models: unknown): Promise<string[]> {
		const sanitizedModels = sanitizeModels(models, this.maxModels)

		// Empty refreshes must never erase a previously working catalog.
		if (sanitizedModels.length === 0) {
			return this.get(identity)
		}

		const entry: OpenAiModelCatalogCacheEntry = {
			version: 2,
			endpointFingerprint: getOpenAiModelCatalogEndpointFingerprint(identity),
			models: sanitizedModels,
			updatedAt: this.now(),
		}

		try {
			// Each profile owns a separate key, so parallel profile refreshes cannot overwrite one another.
			await this.storage.update(getOpenAiModelCatalogStorageKey(identity), entry)
			await this.purgeLegacyCache()
		} catch {
			this.log("[Models] Unable to persist the OpenAI-compatible model catalog cache")
		}

		return sanitizedModels
	}

	async refresh(identity: OpenAiModelCatalogIdentity, loadModels: () => Promise<unknown>): Promise<string[]> {
		try {
			const liveModels = sanitizeModels(await loadModels(), this.maxModels)

			if (liveModels.length > 0) {
				return this.put(identity, liveModels)
			}

			const cachedModels = this.get(identity)

			if (cachedModels.length > 0) {
				this.log("[Models] Live OpenAI-compatible model catalog was empty; keeping the saved catalog")
			}

			return cachedModels
		} catch {
			const cachedModels = this.get(identity)

			if (cachedModels.length > 0) {
				this.log("[Models] OpenAI-compatible model catalog request failed; keeping the saved catalog")
			} else {
				this.log("[Models] OpenAI-compatible model catalog request failed and no saved catalog is available")
			}

			return cachedModels
		}
	}
}
// kilocode_change end: durable last-known-good OpenAI-compatible model catalogs
