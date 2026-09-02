import { getMemoryPercentage } from "../helpers"

describe("getMemoryPercentage", () => {
	it("uses the live heap usage instead of the total allocated heap", () => {
		expect(
			getMemoryPercentage({
				usedJSHeapSize: 200,
				jsHeapSizeLimit: 1_000,
			}),
		).toBe(20)
	})

	it("handles unavailable or invalid heap limits", () => {
		expect(getMemoryPercentage({ usedJSHeapSize: 100, jsHeapSizeLimit: 0 })).toBe(0)
	})

	it("caps inconsistent browser readings at one hundred percent", () => {
		expect(getMemoryPercentage({ usedJSHeapSize: 1_500, jsHeapSizeLimit: 1_000 })).toBe(100)
	})
})
