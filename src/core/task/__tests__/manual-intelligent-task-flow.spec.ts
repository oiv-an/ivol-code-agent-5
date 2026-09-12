// kilocode_change - new file
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import type { ProviderSettings } from "@roo-code/types"
import { buildApiHandler, type ApiHandler } from "../../../api"
import type { ApiStreamChunk } from "../../../api/transform/stream"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { ClineProvider } from "../../webview/ClineProvider"
import { getEffectiveApiHistory } from "../../condense"
import { resolveTaskDocumentSettings } from "../../task-document/settings"
import { ORDINARY_TASK_INSTRUCTIONS } from "../kilocode/OrdinaryContextPreparation"
import { readOrdinaryPreparation } from "../kilocode/ordinaryPreparationStorage"
import { Task } from "../Task"

// Actual Task constructor, ordinary request loop, presentation, native parser,
// file tools, write observation, summarizer and task-local persistence.
// Only model transport and IDE-facing services are isolated.
vi.mock("vscode", async (original) => ({
	...(await original<typeof import("vscode")>()),
	RelativePattern: class {
		constructor(
			public base: string,
			public pattern: string,
		) {}
	},
	EventEmitter: class {
		event = vi.fn(() => ({ dispose() {} }))
		fire = vi.fn()
		dispose = vi.fn()
	},
	TabInputText: class {},
	TabInputTextDiff: class {},
}))
vi.mock("../../../api", () => ({ buildApiHandler: vi.fn() }))
vi.mock("../../prompts/system", () => ({ SYSTEM_PROMPT: vi.fn().mockResolvedValue("Project instructions") }))
vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn(async () => "<environment_details>Test IDE</environment_details>"),
}))
vi.mock("../../../services/browser/UrlContentFetcher", () => ({
	UrlContentFetcher: vi.fn(() => ({ closeBrowser: vi.fn() })),
}))
vi.mock("../../../services/browser/BrowserSession", () => ({
	BrowserSession: vi.fn(() => ({ closeBrowser: vi.fn() })),
}))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { hasInstance: () => false, instance: new Proxy({}, { get: () => vi.fn() }) },
}))

const generatedBody =
	"# Task\nImplement both requested branches.\n\n# Current progress\nBranch A was edited, but not verified.\n\n# Resume here\nVerify branch A, then implement branch B."
const summaryBody = "Ordinary conversation summary: branch A needs verification; branch B remains outstanding."
const tool = (id: string, name: string, input: object): ApiStreamChunk => ({
	type: "tool_call",
	id,
	name,
	arguments: JSON.stringify(input),
})
const read = (id = "read-current") => tool(id, "read_file", { files: [{ path: "CURRENT_TASK.md" }] })
const edit = (body = generatedBody, old = "", id = "write-current") =>
	tool(id, "edit_file", { file_path: "CURRENT_TASK.md", old_string: old, new_string: body })
const complete = () => tool("complete", "attempt_completion", { result: "Work preserved." })

function assertPairs(messages: ApiMessage[], ids: string[]) {
	const blocks = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
	for (const id of ids) {
		const uses = blocks.filter((b) => b.type === "tool_use" && b.id === id)
		const results = blocks.filter((b) => b.type === "tool_result" && b.tool_use_id === id)
		expect(uses, `native call ${id}`).toHaveLength(1)
		expect(results, `durable result ${id}`).toHaveLength(1)
		expect(blocks.indexOf(uses[0])).toBeLessThan(blocks.indexOf(results[0]))
	}
}

type Turn = ApiStreamChunk[] | (() => AsyncGenerator<ApiStreamChunk>)
async function fixture({
	messageCount = 2,
	savedMode = "task",
	body = generatedBody,
	turns,
	decision = "Retry update",
	reject = false,
	onGenerate,
	expectWrite = true,
	expectedIds = ["read-current", "write-current"],
}: {
	messageCount?: number
	savedMode?: "task" | "standard"
	body?: string
	turns?: Turn[]
	decision?: string | (() => Promise<string>)
	reject?: boolean
	onGenerate?: () => Promise<void>
	expectWrite?: boolean
	expectedIds?: string[]
} = {}) {
	const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ivol-ordinary-flow-")))
	const storage = path.join(workspace, "storage")
	Object.assign(vscode.workspace, {
		workspaceFolders: [{ uri: vscode.Uri.file(workspace), name: "integration", index: 0 }],
		openTextDocument: async () => ({ isDirty: false }),
	})
	Object.assign(vscode.window, {
		showTextDocument: vi.fn(async () => ({})),
		visibleTextEditors: [],
		tabGroups: { all: [], onDidChangeTabs: () => ({ dispose() {} }) },
	})
	Object.assign(vscode.languages, { getDiagnostics: () => [] })
	const events: string[] = []
	const currentPath = path.join(workspace, "CURRENT_TASK.md")
	const saved: ProviderSettings = {
		apiProvider: "openai",
		openAiModelId: "saved-profile-model",
		intelligentTaskEnabled: savedMode === "task",
	}
	const stale: ProviderSettings = {
		apiProvider: "openai",
		openAiModelId: "running-task-model",
		intelligentTaskEnabled: false,
	}
	let task: Task
	let turn = 0
	const script = turns ?? [[read()], [edit(body)], [complete()]]
	const historyPath = () => path.join(storage, "tasks", task.taskId, "api_conversation_history.json")
	const durableHistory = async (): Promise<ApiMessage[]> => JSON.parse(await fs.readFile(historyPath(), "utf8"))
	const createMessage = vi.fn(async function* (system: string): AsyncGenerator<ApiStreamChunk> {
		if (system.startsWith("Your task is to create a detailed summary")) {
			events.push("summarize")
			// Assert inside the transport boundary: all actual tool outcomes must already be durable.
			const persisted = await durableHistory()
			assertPairs(persisted, expectedIds)
			expect(persisted.some((m) => m.isSummary)).toBe(false)
			if (expectWrite) expect(await fs.readFile(currentPath, "utf8")).toBe(body)
			yield { type: "text", text: summaryBody }
			return
		}
		events.push("ordinary")
		await onGenerate?.()
		const next = script[turn++]
		if (!next) throw new Error("Unexpected extra ordinary request")
		if (typeof next === "function") yield* next()
		else for (const chunk of next) yield chunk
	})
	const api = {
		createMessage,
		countTokens: vi.fn(async () => 100),
		getModel: () => ({
			id: "running-task-model",
			info: { contextWindow: 370_000, supportsImages: false, supportsNativeTools: true },
		}),
	} as unknown as ApiHandler
	vi.mocked(buildApiHandler).mockReturnValue(api)
	const memento = () => ({
		get: (_key: string, fallback?: unknown) => fallback,
		update: vi.fn(async () => {}),
		keys: () => [],
	})
	const context = {
		globalStorageUri: vscode.Uri.file(storage),
		globalState: memento(),
		workspaceState: memento(),
		extensionUri: vscode.Uri.file(workspace),
		extensionPath: workspace,
		subscriptions: [],
		secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
	} as unknown as vscode.ExtensionContext
	const provider = Object.create(ClineProvider.prototype) as ClineProvider
	Object.assign(provider, {
		context,
		on: undefined,
		contextProxy: {
			globalStorageUri: context.globalStorageUri,
			getProviderSettings: () => saved,
			getValue: () => undefined,
		},
		getState: vi.fn(async () => ({
			mcpEnabled: false,
			mode: "code",
			apiConfiguration: saved,
			experiments: { preventFocusDisruption: true },
			diagnosticsEnabled: false,
			writeDelayMs: 0,
			autoCondenseContext: false,
			browserToolEnabled: false,
			enableCheckpoints: false,
		})),
		getSkillsManager: vi.fn(),
		getMcpHub: vi.fn(),
		getKiloConfig: vi.fn(),
		postStateToWebview: vi.fn(),
		updateTaskHistory: vi.fn(),
		log: vi.fn(),
		getTaskDocumentSettings: (profile: ProviderSettings) =>
			resolveTaskDocumentSettings(profile, {
				appName: "Visual Studio Code",
				workspacePath: workspace,
				spawnedAgent: false,
				wrapper: {
					kiloCodeWrapped: false,
					kiloCodeWrapper: null,
					kiloCodeWrapperTitle: null,
					kiloCodeWrapperCode: null,
					kiloCodeWrapperVersion: null,
					kiloCodeWrapperJetbrains: false,
				},
			}),
		postMessageToWebview: vi.fn(async ({ type }: { type: string }) => {
			events.push(`post:${type}`)
		}),
	})
	task = new Task({
		context,
		provider,
		apiConfiguration: stale,
		workspacePath: workspace,
		startTask: false,
		enableCheckpoints: false,
	})
	const originalHistory: ApiMessage[] = Array.from({ length: messageCount }, (_, i) => ({
		role: i % 2 === 0 ? "user" : "assistant",
		content: i === 0 ? "Implement branches A and B" : `Evidence ${i}`,
		ts: i + 1,
	}))
	Object.assign(task, {
		apiConversationHistory: originalHistory,
		_taskToolProtocol: "native",
		getTokenUsage: () => ({ contextTokens: 1000, totalCost: 0 }),
	})
	// Keep real UI persistence; auto-answer only IDE asks, never file-tool execution.
	const ask = vi.spyOn(task, "ask").mockImplementation(async (kind, text, partial) => {
		events.push(`ask:${kind}`)
		if (kind === "api_req_failed") {
			task.abort = true
			return { response: "noButtonClicked" }
		}
		if (kind === "followup") {
			if (events.filter((e) => e === "ask:followup").length > 3) {
				task.abort = true
				throw new Error(`Unexpected repeated decision: ${text}`)
			}
			expect(events).not.toContain("summarize")
			expect((await durableHistory()).some((m) => m.isSummary)).toBe(false)
			return { response: "messageResponse", text: typeof decision === "function" ? await decision() : decision }
		}
		if (kind === "tool" && !partial && reject) return { response: "noButtonClicked" }
		return { response: "yesButtonClicked" }
	})
	const overwriteOriginal = task.overwriteApiConversationHistory.bind(task)
	const overwrite = vi.spyOn(task, "overwriteApiConversationHistory").mockImplementation(async (messages) => {
		if (messages.some((m) => m.isSummary)) {
			expect(events).toContain("summarize")
			assertPairs(await durableHistory(), expectedIds)
			if (expectWrite) expect(await fs.readFile(currentPath, "utf8")).toBe(body)
			events.push("commit")
		}
		await overwriteOriginal(messages)
	})
	Object.assign(provider, { clineStack: [task] })
	return {
		workspace,
		storage,
		provider,
		task,
		currentPath,
		createMessage,
		originalHistory,
		overwrite,
		ask,
		events,
		durableHistory,
		saved,
		historyPath,
	}
}

describe("manual intelligent task actual ordinary-loop integration", () => {
	const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
	async function create(options: Parameters<typeof fixture>[0] = {}) {
		const f = await fixture(options)
		fixtures.push(f)
		return f
	}
	beforeEach(() => vi.clearAllMocks())
	afterEach(async () => {
		for (const f of fixtures.splice(0)) {
			f.task.abort = true
			f.task.fileContextTracker.dispose()
			await fs.rm(f.workspace, { recursive: true, force: true })
		}
		vi.restoreAllMocks()
	})

	it.each([2, 3])(
		"idle manual startup compacts %i messages only after actual read/edit results are durable",
		async (messageCount) => {
			const f = await create({ messageCount })
			await f.provider.condenseTaskContext(f.task.taskId, "task")
			expect(
				f.events.filter((e) => e === "ordinary"),
				JSON.stringify(f.task.clineMessages),
			).toHaveLength(3)
			expect(f.events.filter((e) => e === "summarize")).toHaveLength(1)
			expect(f.events.indexOf("summarize")).toBeLessThan(f.events.indexOf("commit"))
			expect(f.task.apiConfiguration.openAiModelId).toBe("running-task-model")
			expect(await fs.readFile(f.currentPath, "utf8")).toBe(generatedBody)
			const effective = getEffectiveApiHistory(await f.durableHistory())
			expect(JSON.stringify(effective.find((m) => m.isSummary)?.content)).toContain(summaryBody)
			const prompt = await f.task.getSystemPrompt()
			expect(prompt).toContain(ORDINARY_TASK_INSTRUCTIONS)
			expect(prompt).not.toContain(generatedBody)
			expect(await fs.readdir(f.workspace)).toEqual(["CURRENT_TASK.md", "storage"])
			expect(await readOrdinaryPreparation(f.storage, f.task.taskId)).toBeUndefined()
		},
	)

	it("creates a complete Russian file above both former managed size limits without a managed retry", async () => {
		const body = `${generatedBody}\n${"Сохранить требования и незавершённую ветку.\n".repeat(4000)}Конечное обязательство.`
		expect(Buffer.byteLength(body)).toBeGreaterThan(128 * 1024)
		const f = await create({ body })
		await f.provider.condenseTaskContext(f.task.taskId, "task")
		expect(await fs.readFile(f.currentPath, "utf8")).toBe(body)
		expect(
			f.events.filter((e) => e === "ordinary"),
			JSON.stringify(f.task.clineMessages),
		).toHaveLength(3)
		expect(f.events.filter((e) => e === "commit")).toHaveLength(1)
	})

	it("a rejected actual edit preserves the file and history until explicit continue", async () => {
		const f = await create({
			turns: [[edit()], [complete()]],
			reject: true,
			decision: "Continue without updating",
			expectWrite: false,
			expectedIds: ["write-current"],
		})
		await f.provider.condenseTaskContext(f.task.taskId, "task")
		expect(f.ask).toHaveBeenCalledWith("followup", expect.stringContaining("Retry update"), false)
		await expect(fs.readFile(f.currentPath)).rejects.toMatchObject({ code: "ENOENT" })
		expect(f.events.indexOf("ask:followup")).toBeLessThan(f.events.indexOf("summarize"))
		expect(f.events.filter((e) => e === "commit")).toHaveLength(1)
	})

	it("text claiming a save is not a write and cannot bypass the explicit decision", async () => {
		const f = await create({
			turns: [[{ type: "text", text: "I saved CURRENT_TASK.md." }], [complete()]],
			decision: "Continue without updating",
			expectWrite: false,
			expectedIds: [],
		})
		await f.provider.condenseTaskContext(f.task.taskId, "task")
		expect(f.ask).toHaveBeenCalledWith("followup", expect.stringContaining("not updated"), false)
		await expect(fs.readFile(f.currentPath)).rejects.toMatchObject({ code: "ENOENT" })
		expect(f.events.indexOf("ask:followup")).toBeLessThan(f.events.indexOf("commit"))
	})

	it("retries a failed actual edit in the same task without losing outcomes or reusing failed evidence", async () => {
		const f = await create({
			turns: [[edit(generatedBody, "missing text", "failed-edit")], [edit()], [complete()]],
			decision: "Retry update",
			expectedIds: ["failed-edit", "write-current"],
		})
		const id = f.task.taskId
		await f.provider.condenseTaskContext(id, "task")
		expect(f.task.taskId).toBe(id)
		expect(f.ask).toHaveBeenCalledWith("followup", expect.stringContaining("Retry update"), false)
		expect(await fs.readFile(f.currentPath, "utf8")).toBe(generatedBody)
		expect(f.events.filter((e) => e === "commit")).toHaveLength(1)
	})

	it("a concurrent edit causes the actual replacement to fail and preserves user content", async () => {
		const concurrent = "User's concurrent plan\n"
		let f: Awaited<ReturnType<typeof fixture>>
		f = await create({
			turns: [[read()], [edit(generatedBody, "Original plan")], [complete()]],
			decision: "Continue without updating",
			expectWrite: false,
			onGenerate: async () => {
				if (f.events.filter((e) => e === "ordinary").length === 2) await fs.writeFile(f.currentPath, concurrent)
			},
		})
		await fs.writeFile(f.currentPath, "Original plan")
		await f.provider.condenseTaskContext(f.task.taskId, "task")
		expect(await fs.readFile(f.currentPath, "utf8")).toBe(concurrent)
		expect(f.ask).toHaveBeenCalledWith("followup", expect.stringContaining("not updated"), false)
		expect(f.events.indexOf("ask:followup")).toBeLessThan(f.events.indexOf("commit"))
	})

	it("an active-loop manual click queues preparation without approving or duplicating the pending tool", async () => {
		let start!: () => void, release!: () => void
		const started = new Promise<void>((r) => {
			start = r
		})
		const gate = new Promise<void>((r) => {
			release = r
		})
		let first = true
		const f = await create({
			onGenerate: async () => {
				if (first) {
					first = false
					start()
					await gate
				}
			},
		})
		f.task.apiConfiguration.intelligentTaskEnabled = true
		const running = f.task.recursivelyMakeClineRequests([{ type: "text", text: "Continue" }])
		await started
		try {
			await f.provider.condenseTaskContext(f.task.taskId, "task")
			await f.provider.condenseTaskContext(f.task.taskId, "task")
			expect(f.createMessage).toHaveBeenCalledOnce()
			expect(f.ask).not.toHaveBeenCalled()
			expect(f.events).not.toContain("commit")
		} finally {
			release()
			await running
		}
		expect(f.events.filter((e) => e === "commit")).toHaveLength(1)
		expect(await fs.readFile(f.currentPath, "utf8")).toBe(generatedBody)
	})

	it("a successful ordinary read and edit preserve unrelated prose, native pairing and the real summary", async () => {
		const original = "User-owned notes.\nOriginal plan"
		const body = `User-owned notes.\n${generatedBody}`
		const f = await create({ body, turns: [[read()], [edit(generatedBody, "Original plan")], [complete()]] })
		await fs.writeFile(f.currentPath, original)
		await f.provider.condenseTaskContext(f.task.taskId, "task")
		expect(f.ask.mock.calls.filter(([kind]) => kind === "followup")).toHaveLength(0)
		expect(f.events.filter((event) => event === "commit")).toHaveLength(1)
		expect(await fs.readFile(f.currentPath, "utf8")).toBe(body)
		expect(
			JSON.stringify(getEffectiveApiHistory(await f.durableHistory()).find((m) => m.isSummary)?.content),
		).toContain(summaryBody)
	})

	it.each(["transport", "cancel"] as const)(
		"%s during an unfinished ordinary edit saves an unknown native outcome without replay",
		async (kind) => {
			let f: Awaited<ReturnType<typeof fixture>>
			f = await create({
				expectWrite: false,
				expectedIds: [],
				turns: [
					async function* () {
						yield { type: "text", text: "Preparing the task file." }
						yield {
							type: "tool_call_partial",
							index: 0,
							id: "partial-edit",
							name: "edit_file",
							arguments: '{"file_path":"CURRENT_TASK.md"',
						}
						yield { type: "usage", inputTokens: 100, outputTokens: 10 }
						if (kind === "cancel") f.task.cancelCurrentRequest()
						throw Object.assign(new Error("Interrupted ordinary edit"), { code: "ECONNRESET" })
					},
				],
			})
			await f.provider.condenseTaskContext(f.task.taskId, "task")
			expect(f.createMessage).toHaveBeenCalledOnce()
			expect(f.events).not.toContain("summarize")
			expect(f.events).not.toContain("commit")
			await expect(fs.readFile(f.currentPath)).rejects.toMatchObject({ code: "ENOENT" })
			const persisted = await f.durableHistory()
			expect(f.task.assistantMessageContent, JSON.stringify(persisted)).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: "partial-edit" })]),
			)
			assertPairs(persisted, ["partial-edit"])
			expect(JSON.stringify(persisted)).toContain("outcome is unknown")
			expect(await readOrdinaryPreparation(f.storage, f.task.taskId)).toBe("manual")
		},
	)

	it("manual compaction below the threshold still rejects a summary outside the actual model window", async () => {
		const f = await create({ turns: [[edit()], [complete()]], expectedIds: ["write-current"] })
		vi.mocked(f.task.api.countTokens).mockResolvedValue(400_000)
		await f.provider.condenseTaskContext(f.task.taskId, "task")
		expect(await fs.readFile(f.currentPath, "utf8")).toBe(generatedBody)
		expect(f.events).toContain("summarize")
		expect(f.events).not.toContain("commit")
		expect((await f.durableHistory()).some((m) => m.isSummary)).toBe(false)
	})

	it.each(["transport", "cancel"] as const)(
		"%s interruption in background drain must preserve completed writes and stop without compaction or replay",
		async (kind) => {
			let f: Awaited<ReturnType<typeof fixture>>
			f = await create({
				expectedIds: ["write-current"],
				turns: [
					async function* () {
						yield edit()
						yield { type: "text", text: "The file tool has been issued." }
						await vi.waitFor(() =>
							expect(
								f.task.userMessageContent.some(
									(b) => b.type === "tool_result" && b.tool_use_id === "write-current",
								),
							).toBe(true),
						)
						yield {
							type: "tool_call_partial",
							index: 1,
							id: "partial-edit",
							name: "edit_file",
							arguments: '{"file_path":"CURRENT_TASK.md"',
						}
						yield { type: "usage", inputTokens: 100, outputTokens: 10 }
						if (kind === "cancel") f.task.cancelCurrentRequest()
						throw Object.assign(new Error(kind === "cancel" ? "Cancelled stream" : "Connection reset"), {
							code: "ECONNRESET",
						})
					},
				],
			})
			await f.provider.condenseTaskContext(f.task.taskId, "task")
			expect(f.createMessage).toHaveBeenCalledOnce()
			expect(
				f.task.clineMessages.filter((m) => m.say === "error"),
				JSON.stringify(f.task.clineMessages),
			).toEqual([])
			expect(f.events).not.toContain("summarize")
			expect(f.events).not.toContain("commit")
			expect(
				await fs.readFile(f.currentPath, "utf8").catch(() => "MISSING"),
				JSON.stringify(f.task.clineMessages),
			).toBe(generatedBody)
			const persisted = await f.durableHistory()
			assertPairs(persisted, ["write-current", "partial-edit"])
			expect(JSON.stringify(persisted)).toContain("outcome is unknown")
			expect(persisted.some((m) => m.isSummary)).toBe(false)
			expect(await readOrdinaryPreparation(f.storage, f.task.taskId)).toBe("manual")
		},
	)

	it("a restarted task loads durable waiting intent before any model request and requires explicit continue", async () => {
		const f = await create({
			turns: [[{ type: "text", text: "The update could not be completed." }]],
			expectWrite: false,
			expectedIds: [],
			decision: async () => {
				f.task.abort = true
				return ""
			},
		})
		await f.provider.condenseTaskContext(f.task.taskId, "task")
		const savedHistory = await f.durableHistory()
		expect(savedHistory.some((m) => m.isSummary)).toBe(false)
		expect(await readOrdinaryPreparation(f.storage, f.task.taskId)).toBe("manual")
		const restored = new Task({
			context: f.provider.context,
			provider: f.provider,
			apiConfiguration: { ...f.task.apiConfiguration },
			workspacePath: f.workspace,
			startTask: false,
			enableCheckpoints: false,
			historyItem: {
				id: f.task.taskId,
				task: "Implement branches A and B",
				ts: 1,
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				mode: "code",
				toolProtocol: "native",
			},
		})
		Object.assign(f.provider, { clineStack: [restored] })
		let approved = false
		const restoredAsk = vi.spyOn(restored, "ask").mockImplementation(async (kind) => {
			if (kind === "completion_result") restored.abort = true
			if (kind === "followup") {
				expect(restored.apiConversationHistory.some((m) => m.isSummary)).toBe(false)
				approved = true
				return { response: "messageResponse", text: "Continue without updating" }
			}
			return { response: "yesButtonClicked" }
		})
		const resumeTransport = vi.fn(async function* (system: string): AsyncGenerator<ApiStreamChunk> {
			expect(approved).toBe(true)
			if (system.startsWith("Your task is to create a detailed summary"))
				yield { type: "text", text: summaryBody }
			else yield complete()
		})
		Object.assign(restored.api, { createMessage: resumeTransport })
		try {
			await (restored as unknown as { resumeTaskFromHistory(): Promise<void> }).resumeTaskFromHistory()
			expect(restoredAsk).toHaveBeenCalledWith(
				"followup",
				expect.stringContaining("previous preparation was interrupted"),
				false,
			)
			expect(resumeTransport).toHaveBeenCalledTimes(2)
			expect(getEffectiveApiHistory(await f.durableHistory()).some((m) => m.isSummary)).toBe(true)
			expect(await readOrdinaryPreparation(f.storage, f.task.taskId)).toBeUndefined()
		} finally {
			restored.abort = true
			restored.fileContextTracker.dispose()
		}
	})

	it("never silently falls back when the manual button's expected mode changed", async () => {
		const f = await create({ savedMode: "standard" })
		await f.provider.condenseTaskContext(f.task.taskId, "task")
		expect(f.createMessage).not.toHaveBeenCalled()
		expect(f.overwrite).not.toHaveBeenCalled()
		expect(f.task.apiConversationHistory).toBe(f.originalHistory)
		await expect(fs.readFile(f.currentPath)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("keeps the standard small-history guard", async () => {
		const f = await create({ savedMode: "standard" })
		await f.provider.condenseTaskContext(f.task.taskId)
		expect(f.createMessage).not.toHaveBeenCalled()
		expect(f.overwrite).not.toHaveBeenCalled()
		expect(f.task.apiConversationHistory).toBe(f.originalHistory)
	})
})
