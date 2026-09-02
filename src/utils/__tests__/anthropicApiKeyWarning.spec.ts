// kilocode_change - new file
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as vscode from "vscode"

import { checkAnthropicApiKeyConflict } from "../anthropicApiKeyWarning"

// Mock VS Code API
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(),
	},
	window: {
		showWarningMessage: vi.fn(),
	},
	env: {
		openExternal: vi.fn(),
	},
	Uri: {
		parse: vi.fn(),
	},
}))

describe("anthropicApiKeyWarning", () => {
	const mockGetConfiguration = vi.mocked(vscode.workspace.getConfiguration)
	const mockShowWarningMessage = vi.mocked(vscode.window.showWarningMessage)

	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		// Clean up environment variable
		delete process.env.ANTHROPIC_API_KEY
	})

	describe("checkAnthropicApiKeyConflict", () => {
		it("should not show warning when ANTHROPIC_API_KEY is not set", () => {
			// Ensure environment variable is not set
			delete process.env.ANTHROPIC_API_KEY

			checkAnthropicApiKeyConflict()

			expect(mockGetConfiguration).not.toHaveBeenCalled()
			expect(mockShowWarningMessage).not.toHaveBeenCalled()
		})

		it("should not show warning when ANTHROPIC_API_KEY is set but provider is not claude-code", () => {
			// Set environment variable
			process.env.ANTHROPIC_API_KEY = "test-key"

			// Mock configuration to return different provider
			const mockConfig = {
				get: vi.fn().mockReturnValue("anthropic"),
			}
			mockGetConfiguration.mockReturnValue(mockConfig as any)

			checkAnthropicApiKeyConflict()

			expect(mockGetConfiguration).toHaveBeenCalledWith("ivol-code-agent-5")
			expect(mockConfig.get).toHaveBeenCalledWith("apiProvider")
			expect(mockShowWarningMessage).not.toHaveBeenCalled()
		})

		it("should show warning when ANTHROPIC_API_KEY is set and provider is claude-code", () => {
			process.env.ANTHROPIC_API_KEY = "test-key"

			const mockConfig = {
				get: vi.fn().mockReturnValue("claude-code"),
			}
			mockGetConfiguration.mockReturnValue(mockConfig as any)
			mockShowWarningMessage.mockResolvedValue(undefined)

			checkAnthropicApiKeyConflict()

			expect(mockGetConfiguration).toHaveBeenCalledWith("ivol-code-agent-5")
			expect(mockConfig.get).toHaveBeenCalledWith("apiProvider")
			expect(mockShowWarningMessage).toHaveBeenCalledWith(
				"An ANTHROPIC_API_KEY environment variable was detected. This may conflict with your subscription login and cause errors. Please unset it to ensure your Claude Max/Pro plan is used.",
				"More Info",
				"Got it",
			)
		})

		it("should open the IVOL Claude Code guidance when More Info is selected", async () => {
			process.env.ANTHROPIC_API_KEY = "test-key"

			mockGetConfiguration.mockReturnValue({ get: vi.fn().mockReturnValue("claude-code") } as any)
			mockShowWarningMessage.mockResolvedValue("More Info" as any)

			const guidanceUrl = "https://github.com/oiv-an/ivol-code-agent-5#claude-code-account-access"
			const guidanceUri = { toString: () => guidanceUrl } as vscode.Uri
			vi.mocked(vscode.Uri.parse).mockReturnValue(guidanceUri)

			checkAnthropicApiKeyConflict()

			await vi.waitFor(() => {
				expect(vscode.Uri.parse).toHaveBeenCalledWith(guidanceUrl)
				expect(vscode.env.openExternal).toHaveBeenCalledWith(guidanceUri)
			})
		})

		it("should handle undefined apiProvider gracefully", () => {
			// Set environment variable
			process.env.ANTHROPIC_API_KEY = "test-key"

			// Mock configuration to return undefined provider
			const mockConfig = {
				get: vi.fn().mockReturnValue(undefined),
			}
			mockGetConfiguration.mockReturnValue(mockConfig as any)

			checkAnthropicApiKeyConflict()

			expect(mockGetConfiguration).toHaveBeenCalledWith("ivol-code-agent-5")
			expect(mockConfig.get).toHaveBeenCalledWith("apiProvider")
			expect(mockShowWarningMessage).not.toHaveBeenCalled()
		})
	})
})
