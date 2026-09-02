import {
	LEGACY_OPENAI_MODEL_CATALOG_CACHE_STORAGE_KEY,
	OpenAiModelCatalogCache,
	getOpenAiModelCatalogEndpointFingerprint,
	getOpenAiModelCatalogStorageKey,
	type OpenAiModelCatalogCacheStorage,
} from "../openai-model-cache"

class MemoryStorage implements OpenAiModelCatalogCacheStorage {
	readonly values = new Map<string, unknown>()

	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined
	}

	async update(key: string, value: unknown): Promise<void> {
		if (typeof value === "undefined") {
			this.values.delete(key)
		} else {
			this.values.set(key, value)
		}
	}
}

const identity = {
	profileId: "profile-id",
	baseUrl: "https://provider.example/v1",
}

describe("OpenAiModelCatalogCache", () => {
	it("uses a profile-specific key and a normalized endpoint fingerprint", () => {
		const storageKey = getOpenAiModelCatalogStorageKey(identity)
		const normalizedEndpoint = getOpenAiModelCatalogEndpointFingerprint({
			...identity,
			baseUrl: " https://PROVIDER.example/v1/ ",
		})

		expect(storageKey).toMatch(/^ivol\.openAiModelCatalogCache\.v2\.[a-f0-9]{64}$/)
		expect(storageKey).not.toContain(identity.profileId)
		expect(getOpenAiModelCatalogStorageKey({ ...identity, baseUrl: "https://another.example/v1" })).toBe(
			storageKey,
		)
		expect(getOpenAiModelCatalogStorageKey({ ...identity, profileId: "another-profile" })).not.toBe(storageKey)
		expect(normalizedEndpoint).toBe(getOpenAiModelCatalogEndpointFingerprint(identity))
	})

	it("returns the last nonempty catalog in a later extension session", async () => {
		const storage = new MemoryStorage()
		const firstInstance = new OpenAiModelCatalogCache(storage)

		await expect(firstInstance.refresh(identity, async () => ["model-one", "model-two"])).resolves.toEqual([
			"model-one",
			"model-two",
		])

		const laterInstance = new OpenAiModelCatalogCache(storage)
		expect(laterInstance.get(identity)).toEqual(["model-one", "model-two"])
		await expect(laterInstance.refresh(identity, async () => [])).resolves.toEqual(["model-one", "model-two"])
	})

	it("does not reuse a profile catalog after its endpoint changes", async () => {
		const storage = new MemoryStorage()
		const cache = new OpenAiModelCatalogCache(storage)

		await cache.put(identity, ["model-one"])

		expect(cache.get({ ...identity, baseUrl: "https://another.example/v1" })).toEqual([])
	})

	it("falls back after a loader throws and logs no error details", async () => {
		const storage = new MemoryStorage()
		const messages: string[] = []
		const cache = new OpenAiModelCatalogCache(storage, { log: (message) => messages.push(message) })

		await cache.put(identity, ["model-one"])
		await expect(
			cache.refresh(identity, async () => {
				throw new Error("failure containing a sensitive value")
			}),
		).resolves.toEqual(["model-one"])

		expect(messages).toEqual(["[Models] OpenAI-compatible model catalog request failed; keeping the saved catalog"])
		expect(messages.join(" ")).not.toContain("sensitive value")
	})

	it("does not turn an empty catalog into a cache entry", async () => {
		const storage = new MemoryStorage()
		const cache = new OpenAiModelCatalogCache(storage)

		await expect(cache.refresh(identity, async () => [])).resolves.toEqual([])
		expect(storage.values.has(getOpenAiModelCatalogStorageKey(identity))).toBe(false)
	})

	it("deduplicates, trims, and caps the number of saved models", async () => {
		const storage = new MemoryStorage()
		const cache = new OpenAiModelCatalogCache(storage, { maxModels: 2 })

		await expect(cache.put(identity, [" model-one ", "model-one", "", "model-two", "model-three"])).resolves.toEqual([
			"model-one",
			"model-two",
		])
		expect(cache.get(identity)).toEqual(["model-one", "model-two"])
	})

	it("stores different profiles independently", async () => {
		const storage = new MemoryStorage()
		const cache = new OpenAiModelCatalogCache(storage)
		const secondIdentity = { ...identity, profileId: "second-profile" }

		await cache.put(identity, ["first-model"])
		await cache.put(secondIdentity, ["second-model"])

		expect(cache.get(identity)).toEqual(["first-model"])
		expect(cache.get(secondIdentity)).toEqual(["second-model"])
		expect(storage.values.size).toBe(2)
	})

	it("returns live models even when durable storage cannot be updated", async () => {
		const messages: string[] = []
		const storage: OpenAiModelCatalogCacheStorage = {
			get: () => undefined,
			update: async () => {
				throw new Error("sensitive storage failure")
			},
		}
		const cache = new OpenAiModelCatalogCache(storage, { log: (message) => messages.push(message) })

		await expect(cache.refresh(identity, async () => ["live-model"])).resolves.toEqual(["live-model"])
		expect(messages).toEqual(["[Models] Unable to persist the OpenAI-compatible model catalog cache"])
		expect(messages.join(" ")).not.toContain("sensitive storage failure")
	})

	it("ignores malformed persisted state", () => {
		const storage = new MemoryStorage()
		storage.values.set(getOpenAiModelCatalogStorageKey(identity), {
			version: 2,
			endpointFingerprint: "bad",
			models: ["bad"],
			updatedAt: Date.now(),
		})
		const cache = new OpenAiModelCatalogCache(storage)

		expect(cache.get(identity)).toEqual([])
	})

	it("removes the legacy shared cache after a successful save", async () => {
		const storage = new MemoryStorage()
		storage.values.set(LEGACY_OPENAI_MODEL_CATALOG_CACHE_STORAGE_KEY, { version: 1, entries: {} })
		const cache = new OpenAiModelCatalogCache(storage)

		await cache.put(identity, ["model-one"])

		expect(storage.values.has(LEGACY_OPENAI_MODEL_CATALOG_CACHE_STORAGE_KEY)).toBe(false)
	})
})
