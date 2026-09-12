// kilocode_change - new file
import path from "node:path"
import type { WorkspaceFolder } from "vscode"
import type { KiloCodeWrapperProperties } from "../../../shared/kilocode/wrapper"
import {
	getTaskDocumentWorkspacePath,
	isTaskDocumentSupported,
	resolveContextMemoryMode,
	resolveTaskDocumentSettings,
	type TaskDocumentSettingsEnvironment,
} from "../settings"

const unwrapped: KiloCodeWrapperProperties = {
	kiloCodeWrapped: false,
	kiloCodeWrapper: null,
	kiloCodeWrapperTitle: null,
	kiloCodeWrapperCode: null,
	kiloCodeWrapperVersion: null,
	kiloCodeWrapperJetbrains: false,
}

const root = path.resolve("test-project")
const environment: TaskDocumentSettingsEnvironment = {
	appName: "Visual Studio Code",
	wrapper: unwrapped,
	workspacePath: root,
	spawnedAgent: false,
}

function wrapper(code: string, name = "jetbrains"): KiloCodeWrapperProperties {
	return {
		...unwrapped,
		kiloCodeWrapped: true,
		kiloCodeWrapper: name,
		kiloCodeWrapperCode: code,
		kiloCodeWrapperVersion: "2026.2",
		kiloCodeWrapperJetbrains: name === "jetbrains",
	}
}

function folder(fsPath: string, scheme = "file"): WorkspaceFolder {
	return { uri: { fsPath, scheme }, index: 0, name: "project" } as WorkspaceFolder
}

describe("experimental task document profile settings", () => {
	it("starts enabled and always uses the fixed CURRENT_TASK.md name", () => {
		expect(resolveTaskDocumentSettings({}, environment)).toEqual({
			enabled: true,
			fileName: "CURRENT_TASK.md",
			supported: true,
		})
	})

	it("keeps the preference isolated to the supplied profile without changing it", () => {
		const personal = Object.freeze({ intelligentTaskEnabled: true })
		const other = Object.freeze({ intelligentTaskEnabled: false })
		expect(resolveTaskDocumentSettings(personal, environment).enabled).toBe(true)
		expect(resolveTaskDocumentSettings(other, environment).enabled).toBe(false)
		expect(resolveTaskDocumentSettings({}, environment).enabled).toBe(true)
		expect(resolveTaskDocumentSettings(personal, environment).enabled).toBe(true)
	})

	it.each(["true", 1, null])("does not treat an invalid imported flag %s as opt-in", (value) => {
		expect(resolveTaskDocumentSettings({ intelligentTaskEnabled: value } as never, environment).enabled).toBe(false)
	})

	it.each(["Visual Studio Code", "Visual Studio Code - Insiders"])("supports official %s", (appName) => {
		expect(isTaskDocumentSupported({ ...environment, appName })).toBe(true)
	})

	it.each(["VSCodeAPIHook", "Cursor", "VSCodium", "", "wrapper"])("denies unknown host %s", (appName) => {
		expect(isTaskDocumentSupported({ ...environment, appName })).toBe(false)
	})

	it.each([
		["PS", "2026.2.2"],
		["IU", "2026.2.2"],
		["IU", "2025.3.6.1"],
		["PY", "2025.1.1.1"],
	])("supports the maintained %s %s wrapper with the default enabled", (code, version) => {
		const target = {
			...environment,
			appName: `wrapper|jetbrains|${code}|${version}`,
			wrapper: { ...wrapper(code), kiloCodeWrapperVersion: version },
		}
		expect(resolveTaskDocumentSettings({}, target)).toEqual({
			enabled: true,
			supported: true,
			fileName: "CURRENT_TASK.md",
		})
		expect(resolveTaskDocumentSettings({ intelligentTaskEnabled: true }, target).enabled).toBe(true)
		expect(resolveTaskDocumentSettings({ intelligentTaskEnabled: false }, target).enabled).toBe(false)
		expect(isTaskDocumentSupported({ ...target, spawnedAgent: true })).toBe(false)
		expect(isTaskDocumentSupported({ ...target, workspacePath: undefined })).toBe(false)
	})

	it.each(["IC", "PC", "WS", "cli", "unknown"])("rejects opted-in profiles on unsupported wrapper %s", (code) => {
		expect(
			resolveTaskDocumentSettings({ intelligentTaskEnabled: true }, { ...environment, wrapper: wrapper(code) }),
		).toEqual({ enabled: false, supported: false, fileName: "CURRENT_TASK.md" })
	})

	it.each([
		{ wrapper: wrapper("PS", "unknown") },
		{ wrapper: { ...wrapper("PS"), kiloCodeWrapperJetbrains: false } },
		{ wrapper: undefined },
		{ spawnedAgent: true },
		{ workspacePath: undefined },
		{ workspacePath: "" },
	])("fails closed for incomplete or unsupported runtime metadata %j", (override) => {
		expect(isTaskDocumentSupported({ ...environment, ...override })).toBe(false)
	})
})

describe("task document workspace selection", () => {
	it("accepts the exact selected root and normalizes its spelling", () => {
		expect(getTaskDocumentWorkspacePath(`${root}${path.sep}.`, [folder(root)])).toBe(root)
	})

	it("uses the matching root in a multi-root workspace", () => {
		const other = path.resolve("another-project")
		expect(getTaskDocumentWorkspacePath(other, [folder(root), folder(other)])).toBe(other)
	})

	it.each([
		[undefined, [folder(root)]],
		["relative-project", [folder(root)]],
		[root, undefined],
		[root, []],
		[root, [folder(root, "untitled")]],
		[root, [folder(path.resolve("another-project"))]],
		[path.join(root, "subfolder"), [folder(root)]],
	] as const)("never authorizes a fallback or non-root path %s", (cwd, folders) => {
		expect(getTaskDocumentWorkspacePath(cwd, folders)).toBeUndefined()
	})
})

describe("effective context memory mode", () => {
	it("uses the working file only where the opted-in profile is supported", () => {
		expect(resolveContextMemoryMode({ intelligentTaskEnabled: true }, true)).toBe("task")
	})

	it.each([true, false])("resolves the default and explicit opt-out when supported=%s", (supported) => {
		expect(resolveContextMemoryMode({}, supported)).toBe(supported ? "task" : "standard")
		expect(resolveContextMemoryMode({ intelligentTaskEnabled: false }, supported)).toBe("standard")
	})

	it("ignores an opted-in profile imported into an unsupported IDE", () => {
		expect(resolveContextMemoryMode({ intelligentTaskEnabled: true }, false)).toBe("standard")
	})
})
