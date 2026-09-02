import type { MarketplaceItem, MarketplaceItemType } from "@roo-code/types"

export class RemoteConfigLoader {
	async loadAllItems(_hideMarketplaceMcps = false): Promise<MarketplaceItem[]> {
		// The inherited Kilo Marketplace is intentionally unavailable. Returning an
		// empty catalog here guarantees that stale commands cannot trigger a request.
		return []
	}

	async getItem(_id: string, _type: MarketplaceItemType): Promise<MarketplaceItem | null> {
		return null
	}

	clearCache(): void {}
}
