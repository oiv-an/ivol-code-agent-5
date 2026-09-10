// kilocode_change - new file
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type * as vscode from "vscode"
import type { ProviderSettings } from "@roo-code/types"
import { buildApiHandler, type ApiHandler } from "../../../api"
import type { ApiStreamChunk } from "../../../api/transform/stream"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { ClineProvider } from "../../webview/ClineProvider"
import { getEffectiveApiHistory } from "../../condense"
import { resolveTaskDocumentSettings } from "../../task-document/settings"
import { readTaskDocument } from "../../task-document/document"
import { INTELLIGENT_TASK_PREPARATION_PROMPT } from "../../task-document/prompts"
import { MAX_TASK_DOCUMENT_BLOCK_BYTES } from "../../task-document/limits"
import { Task } from "../Task"

// Keep the actual provider dispatch, Task constructor/compaction, summarizer,
// session, and durable document storage. Isolate only IDE services, tokenization,
// model transport, and the final history/UI persistence sinks.
vi.mock("../../../api", () => ({ buildApiHandler: vi.fn() }))
vi.mock("../../prompts/system", () => ({ SYSTEM_PROMPT: vi.fn().mockResolvedValue("Project instructions") }))
vi.mock("../../ignore/RooIgnoreController", () => ({
	RooIgnoreController: vi.fn(() => ({ initialize: vi.fn().mockResolvedValue(undefined), getInstructions: vi.fn() })),
}))
vi.mock("../../protect/RooProtectedController", () => ({ RooProtectedController: vi.fn() }))
vi.mock("../../../services/browser/UrlContentFetcher", () => ({ UrlContentFetcher: vi.fn() }))
vi.mock("../../../services/browser/BrowserSession", () => ({ BrowserSession: vi.fn() }))
vi.mock("../../../integrations/editor/DiffViewProvider", () => ({ DiffViewProvider: vi.fn() }))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureTaskCreated: vi.fn(), captureContextCondensed: vi.fn() } },
}))

const generatedBody =
	"# Task\nImplement both requested branches.\n\n# Current progress\nBranch A was edited, but not verified.\n\n# Resume here\nVerify branch A, then implement branch B."

async function fixture({
	messageCount = 2,
	savedMode = "task",
	onGenerate,
	generationBodies = [generatedBody],
}: {
	messageCount?: number
	savedMode?: "task" | "handoff"
	onGenerate?: (workspace: string) => Promise<void>
	generationBodies?: string[]
} = {}) {
	// realpath avoids macOS /var -> /private/var, which production storage correctly rejects as a root symlink.
	const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ivol-manual-task-flow-")))
	const events: string[] = []
	const currentPath = path.join(workspace, "CURRENT_TASK.md")
	const saved: ProviderSettings = {
		apiProvider: "openai",
		openAiModelId: "saved-profile-model",
		intelligentTaskEnabled: savedMode === "task",
		intelligentContextResetEnabled: savedMode === "handoff",
	}
	// Reproduce a task created before the saved profile switched to intelligent task mode.
	const stale: ProviderSettings = {
		apiProvider: "openai",
		openAiModelId: "running-task-model",
		intelligentTaskEnabled: false,
		intelligentContextResetEnabled: true,
	}
	let generationIndex = 0
	const expectedBody = generationBodies.at(-1)!
	const createMessage = vi.fn(async function* (
		..._request: Parameters<ApiHandler["createMessage"]>
	): AsyncGenerator<ApiStreamChunk> {
		events.push("generate")
		await onGenerate?.(workspace)
		yield { type: "text", text: generationBodies[generationIndex++] ?? expectedBody }
	})
	const api = {
		createMessage,
		countTokens: vi.fn().mockResolvedValue(300),
		getModel: () => ({ id: "running-task-model", info: { contextWindow: 370_000, supportsImages: false } }),
	} as unknown as ApiHandler
	vi.mocked(buildApiHandler).mockReturnValue(api)
	const context = { globalStorageUri: { fsPath: path.join(workspace, "storage") } } as vscode.ExtensionContext
	const provider = Object.create(ClineProvider.prototype) as ClineProvider
	const postMessage = vi.fn(async ({ type }: { type: string }) => {
		events.push(`post:${type}`)
	})
	Object.assign(provider, {
		context,
		on: undefined,
		contextProxy: { getProviderSettings: () => saved },
		getState: vi.fn(async () => ({ mcpEnabled: false, mode: "code", apiConfiguration: saved })),
		getSkillsManager: vi.fn(),
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
		postMessageToWebview: postMessage,
	})
	const task = new Task({
		context,
		provider,
		apiConfiguration: stale,
		workspacePath: workspace,
		startTask: false,
		enableCheckpoints: false,
	})
	const originalHistory: ApiMessage[] = Array.from({ length: messageCount }, (_, index) => ({
		role: index % 2 === 0 ? "user" : "assistant",
		content: index === 0 ? "Implement branches A and B" : `Current task evidence ${index}`,
		ts: index + 1,
	}))
	const say = vi.fn(async (kind: string, text?: string) => {
		const phase = kind === "context_handoff" && text ? JSON.parse(text).phase : undefined
		events.push(phase ? `say:${phase}` : `say:${kind}`)
	})
	const overwrite = vi.fn(async (messages: ApiMessage[]) => {
		// This assertion is deliberately inside the persistence boundary, not after the whole operation.
		const verified = await readTaskDocument({ workspacePath: workspace, taskId: task.taskId })
		expect(verified.body).toBe(expectedBody)
		expect(await fs.readFile(currentPath, "utf8")).toContain(expectedBody)
		events.push("history")
		task.apiConversationHistory = messages
	})
	Object.assign(task, {
		apiConversationHistory: originalHistory,
		getTokenUsage: vi.fn(() => ({ contextTokens: 100 })),
		say,
		flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(undefined),
		processQueuedMessages: vi.fn(),
		overwriteApiConversationHistory: overwrite,
	})
	Object.assign(provider, { clineStack: [task] })
	return {
		workspace,
		provider,
		task,
		currentPath,
		createMessage,
		originalHistory,
		overwrite,
		say,
		events,
		postMessage,
	}
}

describe("manual intelligent task full preparation flow", () => {
	const workspaces: string[] = []
	beforeEach(() => vi.clearAllMocks())
	afterEach(async () => {
		await Promise.all(workspaces.splice(0).map((workspace) => fs.rm(workspace, { recursive: true, force: true })))
	})

	it.each([2, 3])(
		"manually resets a %i-message task using the saved mode and a verified real CURRENT_TASK file",
		async (messageCount) => {
			const f = await fixture({ messageCount })
			workspaces.push(f.workspace)
			await f.provider.condenseTaskContext(f.task.taskId, "task")
			expect(f.createMessage).toHaveBeenCalledOnce()
			expect(f.createMessage.mock.calls[0][0]).toContain(INTELLIGENT_TASK_PREPARATION_PROMPT)
			expect(f.createMessage.mock.calls[0][0]).not.toContain("CONTEXT_RESTART.md")
			expect(f.task.apiConfiguration.openAiModelId).toBe("running-task-model")
			expect(f.overwrite).toHaveBeenCalledOnce()
			expect(f.events.indexOf("say:preparing")).toBeLessThan(f.events.indexOf("generate"))
			expect(f.events.indexOf("say:saved")).toBeLessThan(f.events.indexOf("history"))
			expect(f.events.indexOf("history")).toBeLessThan(f.events.indexOf("say:condense_context"))
			const progress = f.say.mock.calls
				.filter(([kind]) => kind === "context_handoff")
				.map(([, text]) => JSON.parse(text!))
			expect(progress.map(({ phase, path: file }) => ({ phase, path: file }))).toEqual([
				{ phase: "preparing", path: "CURRENT_TASK.md" },
				{ phase: "saved", path: "CURRENT_TASK.md" },
			])
			expect(f.say.mock.calls.some(([kind]) => kind === "condense_context_error")).toBe(false)
			expect(await f.task.getSystemPrompt()).toContain("Verify branch A, then implement branch B")
			expect(getEffectiveApiHistory(f.task.apiConversationHistory).some((message) => message.isSummary)).toBe(
				true,
			)
			expect(await fs.readdir(f.workspace)).toEqual(["CURRENT_TASK.md"])
		},
	)

	it("creates a missing file with a Russian task state larger than the former 24 KiB limit before resetting", async () => {
		const body = `${generatedBody}\n\n${"Сохранить требования и незавершённую ветку.\n".repeat(800)}Конечное обязательство.`
		expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(24 * 1024)
		const f = await fixture({ generationBodies: [body] })
		workspaces.push(f.workspace)
		await f.provider.condenseTaskContext(f.task.taskId, "task")
		expect(f.createMessage).toHaveBeenCalledOnce()
		expect(f.overwrite).toHaveBeenCalledOnce()
		expect(await readTaskDocument({ workspacePath: f.workspace, taskId: f.task.taskId })).toMatchObject({ body })
		expect(f.events.indexOf("say:saved")).toBeLessThan(f.events.indexOf("history"))
		expect(f.events).not.toContain("say:condense_context_error")
		expect(await f.task.getSystemPrompt()).toContain("Конечное обязательство.")
		expect(await fs.readdir(f.workspace)).toEqual(["CURRENT_TASK.md"])
	})

	it("retries oversized preparation once and saves only the complete accepted answer before history changes", async () => {
		const oversized = "Я".repeat(MAX_TASK_DOCUMENT_BLOCK_BYTES)
		const f = await fixture({ generationBodies: [oversized, generatedBody] })
		workspaces.push(f.workspace)
		await f.provider.condenseTaskContext(f.task.taskId, "task")
		expect(f.createMessage).toHaveBeenCalledTimes(2)
		expect(f.overwrite).toHaveBeenCalledOnce()
		expect(f.events.filter((event) => event === "say:preparing")).toHaveLength(1)
		expect(f.events.filter((event) => event === "say:saved")).toHaveLength(1)
		expect(f.events.indexOf("say:saved")).toBeLessThan(f.events.indexOf("history"))
		expect(f.events).not.toContain("say:condense_context_error")
		expect(await fs.readFile(f.currentPath, "utf8")).not.toContain(oversized)
	})

	it("can retry manual compression in the same task after both size-limited attempts failed without losing history", async () => {
		const oversized = "Я".repeat(MAX_TASK_DOCUMENT_BLOCK_BYTES)
		const f = await fixture({ generationBodies: [oversized, oversized, generatedBody] })
		workspaces.push(f.workspace)
		const originalTaskId = f.task.taskId
		await f.provider.condenseTaskContext(f.task.taskId, "task")
		expect(f.createMessage).toHaveBeenCalledTimes(2)
		expect(f.overwrite).not.toHaveBeenCalled()
		expect(f.task.apiConversationHistory).toBe(f.originalHistory)
		expect(await fs.readdir(f.workspace)).toEqual([])
		expect(f.events).toContain("say:condense_context_error")
		expect(f.events).not.toContain("say:saved")
		expect(f.events).not.toContain("say:condense_context")
		expect(f.task.isContextCondensationInProgress).toBe(false)

		await f.provider.condenseTaskContext(originalTaskId, "task")
		expect(f.task.taskId).toBe(originalTaskId)
		expect(f.createMessage).toHaveBeenCalledTimes(3)
		expect(f.overwrite).toHaveBeenCalledOnce()
		expect(f.task.apiConfiguration.openAiModelId).toBe("running-task-model")
		expect(await readTaskDocument({ workspacePath: f.workspace, taskId: originalTaskId })).toMatchObject({
			body: generatedBody,
		})
		expect(getEffectiveApiHistory(f.task.apiConversationHistory).some((message) => message.isSummary)).toBe(true)
	})

	it("a real concurrent file edit rejects the save and preserves the original history", async () => {
		const f = await fixture({
			onGenerate: (workspace) =>
				fs.writeFile(path.join(workspace, "CURRENT_TASK.md"), "User's concurrent plan\n"),
		})
		workspaces.push(f.workspace)
		await f.provider.condenseTaskContext(f.task.taskId, "task")
		expect(f.createMessage).toHaveBeenCalledOnce()
		expect(f.overwrite).not.toHaveBeenCalled()
		expect(f.task.apiConversationHistory).toBe(f.originalHistory)
		expect(await fs.readFile(f.currentPath, "utf8")).toBe("User's concurrent plan\n")
		expect(f.say.mock.calls).toEqual(
			expect.arrayContaining([
				expect.arrayContaining([
					"condense_context_error",
					expect.stringContaining("changed after it was read"),
				]),
			]),
		)
		expect(f.events).not.toContain("say:saved")
		expect(f.events).not.toContain("say:condense_context")
	})

	it("a repeated click cannot revoke or duplicate the running file preparation", async () => {
		let start!: () => void
		let release!: () => void
		const started = new Promise<void>((resolve) => {
			start = resolve
		})
		const paused = new Promise<void>((resolve) => {
			release = resolve
		})
		const f = await fixture({
			onGenerate: async () => {
				start()
				await paused
			},
		})
		workspaces.push(f.workspace)
		const running = f.provider.condenseTaskContext(f.task.taskId, "task")
		await started
		const captured = f.task.apiConfiguration
		try {
			await f.provider.condenseTaskContext(f.task.taskId, "task")
			expect(f.task.apiConfiguration).toBe(captured)
			expect(f.createMessage).toHaveBeenCalledOnce()
			expect(f.overwrite).not.toHaveBeenCalled()
			expect(f.events).not.toContain("post:condenseTaskContextResponse")
		} finally {
			release()
			await running
		}
		expect(f.overwrite).toHaveBeenCalledOnce()
		expect(f.events.filter((event) => event === "post:condenseTaskContextResponse")).toHaveLength(1)
		expect(f.events).not.toContain("say:condense_context_error")
	})

	it("never silently falls back to the old route if the button's expected mode no longer matches", async () => {
		const f = await fixture({ savedMode: "handoff" })
		workspaces.push(f.workspace)
		await f.provider.condenseTaskContext(f.task.taskId, "task")
		expect(f.createMessage).not.toHaveBeenCalled()
		expect(f.overwrite).not.toHaveBeenCalled()
		expect(f.task.apiConversationHistory).toBe(f.originalHistory)
		expect(await fs.readdir(f.workspace)).toEqual([])
		expect(f.events).toContain("say:condense_context_error")
		expect(f.events).toContain("post:condenseTaskContextResponse")
	})

	it("keeps the legacy small-history guard for an unchanged old-mode caller", async () => {
		const f = await fixture({ savedMode: "handoff" })
		workspaces.push(f.workspace)
		await f.provider.condenseTaskContext(f.task.taskId)
		expect(f.createMessage).not.toHaveBeenCalled()
		expect(f.overwrite).not.toHaveBeenCalled()
		expect(f.task.apiConversationHistory).toBe(f.originalHistory)
		expect(await fs.readdir(f.workspace)).toEqual([])
		expect(f.events).toContain("say:condense_context_error")
	})
})
