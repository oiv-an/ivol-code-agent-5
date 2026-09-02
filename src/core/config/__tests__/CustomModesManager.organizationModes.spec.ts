// kilocode_change - new file
// npx vitest core/config/__tests__/CustomModesManager.organizationModes.spec.ts

import axios from "axios"
import type * as vscode from "vscode"

import { CustomModesManager } from "../CustomModesManager"

vi.mock("axios", () => ({
	default: {
		get: vi.fn(),
	},
}))

describe("CustomModesManager - Organization Modes", () => {
	let manager: CustomModesManager

	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(globalThis, "fetch")
		manager = new CustomModesManager({} as vscode.ExtensionContext, vi.fn())
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it.each([
		["an omitted organization", undefined],
		["an empty organization", ""],
		["a selected organization", "org-123"],
	])("returns no modes and makes no network requests for %s", async (_description, organizationId) => {
		await expect(manager.fetchOrganizationModes("test-token", organizationId)).resolves.toEqual([])
		expect(axios.get).not.toHaveBeenCalled()
		expect(globalThis.fetch).not.toHaveBeenCalled()
	})
})
