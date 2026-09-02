import { checkKilocodeBalance } from "./kilocode-utils"

describe("checkKilocodeBalance", () => {
	it("fails closed without contacting Kilo for legacy saved credentials", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch")

		await expect(checkKilocodeBalance("legacy-token", "legacy-organization")).resolves.toBe(false)
		expect(fetchSpy).not.toHaveBeenCalled()

		fetchSpy.mockRestore()
	})
})
