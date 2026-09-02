import type { Mock } from "vitest"
import { beforeEach, describe, expect, it, vi } from "vitest"
import axios from "axios"

vi.mock("vscode", () => ({
	window: {
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
		getConfiguration: vi.fn().mockReturnValue({ get: vi.fn(), update: vi.fn() }),
	},
	Uri: {
		file: vi.fn((path) => ({ fsPath: path })),
		parse: vi.fn((path) => ({ fsPath: path })),
	},
	env: { uriScheme: "vscode", openExternal: vi.fn() },
	commands: { executeCommand: vi.fn() },
}))

vi.mock("axios")

vi.mock("../../task-persistence", () => ({ saveTaskMessages: vi.fn() }))

vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn(),
	flushModels: vi.fn(),
}))

vi.mock("../../../integrations/notifications", () => ({ showSystemNotification: vi.fn() }))

vi.mock("../kiloWebviewMessgeHandlerHelpers", () => ({
	refreshOrganizationModes: vi.fn(),
	fetchAndRefreshOrganizationModesOnStartup: vi.fn(),
}))

import { getModels, flushModels } from "../../../api/providers/fetchers/modelCache"
import { refreshOrganizationModes } from "../kiloWebviewMessgeHandlerHelpers"
import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"

describe("webviewMessageHandler - disabled Kilo profile", () => {
	let postMessageToWebview: Mock
	let upsertProviderProfile: Mock
	let getState: Mock
	let provider: ClineProvider

	beforeEach(() => {
		vi.clearAllMocks()
		postMessageToWebview = vi.fn()
		upsertProviderProfile = vi.fn()
		getState = vi.fn()

		provider = {
			postMessageToWebview,
			upsertProviderProfile,
			getState,
		} as unknown as ClineProvider
	})

	it("returns a disabled response without profile, organization, or model side effects", async () => {
		await webviewMessageHandler(provider, { type: "fetchProfileDataRequest" })

		expect(postMessageToWebview).toHaveBeenCalledOnce()
		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "profileDataResponse",
			payload: {
				success: false,
				error: expect.stringContaining("disabled"),
			},
		})
		expect(getState).not.toHaveBeenCalled()
		expect(axios.get).not.toHaveBeenCalled()
		expect(upsertProviderProfile).not.toHaveBeenCalled()
		expect(refreshOrganizationModes).not.toHaveBeenCalled()
		expect(flushModels).not.toHaveBeenCalled()
		expect(getModels).not.toHaveBeenCalled()
	})
})
