import axios from "axios"

import { RemoteConfigLoader } from "../RemoteConfigLoader"

vi.mock("axios")

describe("RemoteConfigLoader - disabled Marketplace", () => {
	it("returns an empty catalog without a network request", async () => {
		const loader = new RemoteConfigLoader()

		await expect(loader.loadAllItems()).resolves.toEqual([])
		await expect(loader.loadAllItems(true)).resolves.toEqual([])
		await expect(loader.getItem("legacy-item", "mode")).resolves.toBeNull()
		expect(axios.get).not.toHaveBeenCalled()
	})
})
