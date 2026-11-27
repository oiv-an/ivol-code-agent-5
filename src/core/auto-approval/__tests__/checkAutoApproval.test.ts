import {
	checkAutoApproval,
	getOutsideWorkspaceBlock, // kilocode_change
	OUTSIDE_WORKSPACE_READ_BLOCKED, // kilocode_change
	OUTSIDE_WORKSPACE_WRITE_BLOCKED, // kilocode_change
} from "../index"
import { ExtensionState } from "@roo-code/types"

describe("checkAutoApproval", () => {
	const mockAsk = "tool"

	it("should approve deleteFile when alwaysAllowDelete is true", async () => {
		const state = {
			alwaysAllowDelete: true,
			autoApprovalEnabled: true,
		} as ExtensionState

		const text = JSON.stringify({
			tool: "deleteFile",
			path: "/path/to/file",
		})

		const result = await checkAutoApproval({ state, ask: mockAsk, text })
		expect(result).toEqual({ decision: "approve" })
	})

	it("should ask for deleteFile when alwaysAllowDelete is false", async () => {
		const state = {
			alwaysAllowDelete: false,
			autoApprovalEnabled: true,
		} as ExtensionState

		const text = JSON.stringify({
			tool: "deleteFile",
			path: "/path/to/file",
		})

		const result = await checkAutoApproval({ state, ask: mockAsk, text })
		expect(result).toEqual({ decision: "ask" })
	})

	it("should ask for deleteFile when alwaysAllowDelete is undefined", async () => {
		const state = {
			autoApprovalEnabled: true,
		} as ExtensionState

		const text = JSON.stringify({
			tool: "deleteFile",
			path: "/path/to/file",
		})

		const result = await checkAutoApproval({ state, ask: mockAsk, text })
		expect(result).toEqual({ decision: "ask" })
	})

	it("should ask when autoApprovalEnabled is false even if alwaysAllowDelete is true", async () => {
		const state = {
			alwaysAllowDelete: true,
			autoApprovalEnabled: false,
		} as ExtensionState

		const text = JSON.stringify({
			tool: "deleteFile",
			path: "/path/to/file",
		})

		const result = await checkAutoApproval({ state, ask: mockAsk, text })
		expect(result).toEqual({ decision: "ask" })
	})

	// kilocode_change start: project bans on paths outside the workspace
	describe("outside-project bans", () => {
		const outsideRead = JSON.stringify({ tool: "readFile", path: "../x", isOutsideWorkspace: true })
		const insideRead = JSON.stringify({ tool: "readFile", path: "x", isOutsideWorkspace: false })
		const outsideWrite = JSON.stringify({ tool: "editedExistingFile", path: "../x", isOutsideWorkspace: true })
		const outsideDelete = JSON.stringify({ tool: "deleteFile", path: "../x", isOutsideWorkspace: true })
		const batchRead = JSON.stringify({
			tool: "readFile",
			batchFiles: [
				{ path: "a", lineSnippet: "", key: "a", isOutsideWorkspace: false },
				{ path: "../b", lineSnippet: "", key: "b", isOutsideWorkspace: true },
			],
		})

		it("denies outside reads even with full auto-approval and returns a reason", async () => {
			const state = {
				autoApprovalEnabled: true,
				alwaysAllowReadOnly: true,
				alwaysAllowReadOnlyOutsideWorkspace: true,
				blockReadOutsideWorkspace: true,
			} as ExtensionState
			expect(await checkAutoApproval({ state, ask: mockAsk, text: outsideRead })).toEqual({
				decision: "deny",
				reason: OUTSIDE_WORKSPACE_READ_BLOCKED,
			})
			expect((await checkAutoApproval({ state, ask: mockAsk, text: batchRead })).decision).toBe("deny")
			expect((await checkAutoApproval({ state, ask: mockAsk, text: insideRead })).decision).toBe("approve")
		})

		it("denies outside reads when auto-approval is off", async () => {
			const state = { autoApprovalEnabled: false, blockReadOutsideWorkspace: true } as ExtensionState
			expect((await checkAutoApproval({ state, ask: mockAsk, text: outsideRead })).decision).toBe("deny")
		})

		it("keeps the read ban independent from writes", async () => {
			const state = { autoApprovalEnabled: false, blockReadOutsideWorkspace: true } as ExtensionState
			expect(getOutsideWorkspaceBlock(state, "tool", outsideWrite)).toBeUndefined()
		})

		it("denies outside writes and deletes when the write ban is on", async () => {
			const state = { blockWriteOutsideWorkspace: true } as ExtensionState
			expect(getOutsideWorkspaceBlock(state, "tool", outsideWrite)).toBe(OUTSIDE_WORKSPACE_WRITE_BLOCKED)
			expect(getOutsideWorkspaceBlock(state, "tool", outsideDelete)).toBe(OUTSIDE_WORKSPACE_WRITE_BLOCKED)
			expect(getOutsideWorkspaceBlock(state, "tool", outsideRead)).toBeUndefined()
		})

		it("does nothing when both bans are off", async () => {
			expect(getOutsideWorkspaceBlock({} as ExtensionState, "tool", outsideWrite)).toBeUndefined()
			expect(getOutsideWorkspaceBlock(undefined, "tool", outsideRead)).toBeUndefined()
		})
	})
	// kilocode_change end
})
