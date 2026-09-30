import { AdvisorService } from "../AdvisorService"

const mocks = vi.hoisted(() => ({
	wrapped: false,
	trusted: true,
	folders: [{ uri: { toString: (): string => "file:///project" } }],
	values: {} as Record<string, unknown>,
	extensions: [] as { id: string; isActive: boolean; packageJSON: Record<string, unknown> }[],
	getConfiguration: vi.fn(),
	update: vi.fn(),
	readDirectory: vi.fn(),
	activate: vi.fn(),
}))
vi.mock("../../../../core/kilocode/wrapper", () => ({
	getKiloCodeWrapperProperties: () => ({ kiloCodeWrapped: mocks.wrapped }),
}))
vi.mock("vscode", () => ({
	workspace: {
		get isTrusted() {
			return mocks.trusted
		},
		get workspaceFolders() {
			return mocks.folders
		},
		getConfiguration: mocks.getConfiguration,
		fs: { readDirectory: mocks.readDirectory },
	},
	extensions: {
		get all() {
			return mocks.extensions
		},
	},
}))
function extension(id: string, manifest: Record<string, unknown> = {}) {
	return { id, isActive: false, activate: mocks.activate, packageJSON: { version: "1", ...manifest } }
}
beforeEach(() => {
	vi.clearAllMocks()
	mocks.wrapped = false
	mocks.trusted = true
	mocks.folders = [{ uri: { toString: (): string => "file:///project" } }]
	mocks.values = {}
	mocks.extensions = [extension("ivol.ivol-code-agent-5"), extension("redhat.java", { displayName: "Java" })]
	mocks.getConfiguration.mockImplementation(() => ({ get: (key: string) => mocks.values[key], update: mocks.update }))
})
it("returns read-only public inventory without scanning, activation or settings writes", async () => {
	const state = await new AdvisorService().getState()
	expect(state).toMatchObject({ workspace: "file:///project", canScan: true, checked: false })
	expect(state.entries).toEqual([
		{
			id: "ivol.ivol-code-agent-5",
			name: "ivol.ivol-code-agent-5",
			version: "1",
			active: false,
			protected: true,
			usageReasons: [{ kind: "self", detail: "IVOL" }],
		},
		{ id: "redhat.java", name: "Java", version: "1", active: false, protected: false, usageReasons: [] },
	])
	expect(mocks.readDirectory).not.toHaveBeenCalled()
	expect(mocks.activate).not.toHaveBeenCalled()
	expect(mocks.update).not.toHaveBeenCalled()
	expect(mocks.getConfiguration.mock.calls.map(([section]) => section)).toEqual(["tasks", "launch"])
})
it("protects configured debuggers and transitive dependencies, not optional extension packs", async () => {
	mocks.extensions.push(
		extension("vendor.debug", {
			contributes: { debuggers: [{ type: "java-debug" }] },
			extensionDependencies: ["redhat.java"],
			extensionPack: ["vendor.optional"],
		}),
	)
	mocks.extensions[1].packageJSON.extensionDependencies = ["vendor.leaf"]
	mocks.extensions.push(
		extension("vendor.leaf", { extensionDependencies: ["vendor.debug"] }),
		extension("vendor.optional"),
	)
	mocks.values.configurations = [{ type: "java-debug" }]
	const state = await new AdvisorService().getState()
	for (const id of ["vendor.debug", "redhat.java", "vendor.leaf"])
		expect(state.entries.find((entry) => entry.id === id)?.protected).toBe(true)
	expect(state.entries.find((entry) => entry.id === "vendor.optional")?.protected).toBe(false)
	expect(mocks.update).not.toHaveBeenCalled()
})
it("recognizes configured task providers, not shell or process commands", async () => {
	mocks.extensions[1].packageJSON.contributes = {
		taskDefinitions: [{ type: "java-build" }, { type: "shell" }, { type: "process" }],
	}
	mocks.values.tasks = [
		{ type: "shell", command: "gradlew build" },
		{ type: "process", command: "java" },
	]
	expect((await new AdvisorService().getState()).entries[1].protected).toBe(false)
	mocks.values.tasks = [{ type: "java-build" }]
	expect((await new AdvisorService().getState()).entries[1].usageReasons).toEqual([
		{ kind: "task", detail: "java-build" },
	])
})
it("propagates IVOL protection to its dependencies", async () => {
	mocks.extensions[0].packageJSON.extensionDependencies = ["REDHAT.JAVA"]
	expect((await new AdvisorService().getState()).entries[1].protected).toBe(true)
})
it("does not inspect fake inventories in wrapped IDEs", async () => {
	mocks.wrapped = true
	expect(await new AdvisorService().getState()).toMatchObject({
		platformSupported: false,
		canScan: false,
		entries: [],
	})
	expect(mocks.getConfiguration).not.toHaveBeenCalled()
})
it("requires a trusted single-folder workspace for AI scanning", async () => {
	mocks.trusted = false
	expect((await new AdvisorService().getState()).canScan).toBe(false)
	mocks.trusted = true
	mocks.folders.push({ uri: { toString: () => "file:///other" } })
	expect((await new AdvisorService().getState()).canScan).toBe(false)
	mocks.folders = []
	expect(await new AdvisorService().getState()).toMatchObject({ canScan: false, entries: [], workspace: "" })
})
