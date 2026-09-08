// kilocode_change - new file
import * as vscode from "vscode"
import { registerProviderTlsDispatcher } from "../../api/providers/utils/provider-tls"

const fixtures = vi.hoisted(() => ({
	proxyAgents: [] as { options: Record<string, unknown> }[],
	setGlobalDispatcher: vi.fn(),
	bootstrap: vi.fn(),
}))

vi.mock("../../api/providers/utils/provider-tls", () => ({ registerProviderTlsDispatcher: vi.fn() }))
vi.mock("global-agent", () => ({ bootstrap: fixtures.bootstrap }))
vi.mock("undici", () => ({
	ProxyAgent: class {
		constructor(public options: Record<string, unknown>) {
			fixtures.proxyAgents.push(this)
		}
	},
	setGlobalDispatcher: fixtures.setGlobalDispatcher,
	fetch: vi.fn(),
}))
vi.mock("vscode", () => ({
	workspace: { getConfiguration: vi.fn(), onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })) },
	ExtensionMode: { Development: 2, Production: 1, Test: 3 },
}))

describe("debug proxy provider TLS registration", () => {
	it("registers the same proxy route with endpoint opt-out but strict proxy TLS", async () => {
		const originalFetch = globalThis.fetch
		const keys = ["GLOBAL_AGENT_HTTP_PROXY", "GLOBAL_AGENT_HTTPS_PROXY", "GLOBAL_AGENT_NO_PROXY"] as const
		const savedEnvironment = new Map(keys.map((key) => [key, process.env[key]]))
		const originalTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: (key: string) =>
				({
					"debugProxy.enabled": true,
					"debugProxy.serverUrl": "https://local-fixture.invalid:8443",
					"debugProxy.tlsInsecure": false,
				})[key],
		} as vscode.WorkspaceConfiguration)
		const subscriptions: { dispose: () => void }[] = []
		try {
			const { initializeNetworkProxy } = await import("../networkProxy")
			await initializeNetworkProxy({
				extensionMode: vscode.ExtensionMode.Development,
				subscriptions,
			} as vscode.ExtensionContext)
			expect(fixtures.proxyAgents).toHaveLength(1)
			const configured = fixtures.proxyAgents[0]
			expect(fixtures.setGlobalDispatcher).toHaveBeenCalledExactlyOnceWith(configured)
			expect(registerProviderTlsDispatcher).toHaveBeenCalledOnce()
			const [delegate, factory] = vi.mocked(registerProviderTlsDispatcher).mock.calls[0]
			expect(delegate).toBe(configured)
			const scoped = factory() as unknown as { options: Record<string, unknown> }
			expect(scoped.options).toEqual({
				uri: "https://local-fixture.invalid:8443",
				requestTls: { rejectUnauthorized: false },
				proxyTls: undefined,
			})
			expect(configured.options.requestTls).toBeUndefined()
			expect(configured.options.proxyTls).toBeUndefined()
			expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(originalTls)
		} finally {
			for (const subscription of subscriptions) subscription.dispose()
			globalThis.fetch = originalFetch
			for (const [key, value] of savedEnvironment) {
				if (value === undefined) delete process.env[key]
				else process.env[key] = value
			}
		}
	})
})
