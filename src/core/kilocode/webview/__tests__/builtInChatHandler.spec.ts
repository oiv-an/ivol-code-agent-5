// kilocode_change - new file
const store: Record<string, unknown> = {}
const update = vi.fn(async (key: string, value: unknown) => {
	if (value === undefined) delete store[key]
	else store[key] = value
})

vi.mock("vscode", () => ({
	ConfigurationTarget: { Global: 1 },
	workspace: {
		getConfiguration: () => ({
			update,
			inspect: (key: string) => ({ globalValue: store[key] }),
		}),
	},
}))

import { handleBuiltInChat } from "../builtInChatHandler"

describe("handleBuiltInChat", () => {
	beforeEach(() => {
		for (const key of Object.keys(store)) delete store[key]
		update.mockClear()
	})

	it("disables the built-in chat globally and reports the new state", async () => {
		const provider = { postMessageToWebview: vi.fn() }
		await handleBuiltInChat(provider as any, true)
		expect(update).toHaveBeenCalledWith("chat.disableAIFeatures", true, 1)
		expect(update).toHaveBeenCalledTimes(1)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "builtInChatDisabled",
			builtInChatDisabled: { disabled: true },
		})
	})

	it("removes the settings when re-enabled", async () => {
		store["chat.disableAIFeatures"] = true
		const provider = { postMessageToWebview: vi.fn() }
		await handleBuiltInChat(provider as any, false)
		expect(store).toEqual({})
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "builtInChatDisabled",
			builtInChatDisabled: { disabled: false },
		})
	})

	it("only reports the state when no value is given", async () => {
		const provider = { postMessageToWebview: vi.fn() }
		await handleBuiltInChat(provider as any)
		expect(update).not.toHaveBeenCalled()
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "builtInChatDisabled",
			builtInChatDisabled: { disabled: false },
		})
	})
})
