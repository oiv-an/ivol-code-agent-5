// kilocode_change - verified, visible project-root continuation file
import crypto from "crypto"
import * as fs from "fs/promises"
import * as path from "path"
import * as lockfile from "proper-lockfile"

import type { Anthropic } from "@anthropic-ai/sdk"

import type { ApiMessage } from "../task-persistence/apiMessages"

export const CONTEXT_HANDOFF_RELATIVE_PATH = "CONTEXT_RESTART.md"
const LEGACY_CONTEXT_HANDOFF_RELATIVE_PATH = ".ivol-code/CONTEXT_RESTART.md"

const CONTEXT_HANDOFF_MAGIC = "IVOL_CODE_CONTEXT_RESTART_V1"
const CONTEXT_HANDOFF_IGNORE_RULES = ["/CONTEXT_RESTART.md", "/CONTEXT_RESTART.md.*.tmp", "/CONTEXT_RESTART.md.lock"]
const REDACTED_SECRET = "[REDACTED_SECRET]"
const writeQueues = new Map<string, Promise<unknown>>()

export type ContextHandoffTrigger = "automatic" | "manual" | "tool" | "extended-thinking" | "forced"

export type ContextHandoffRecord = {
	handoffId: string
	relativePath: string
	absolutePath: string
	/** Sanitized summary retained in API history after the one-shot handoff is consumed. */
	body: string
	/** Complete, sanitized document written to the workspace and injected once. */
	content: string
	sha256: string
	createdAt: number
}

export type ContextHandoffWriteOptions = {
	workspacePath: string
	taskId: string
	condenseId: string
	modelId: string
	summary: string
	trigger: ContextHandoffTrigger
	/** Exact secret values known to the caller. They are removed before heuristic redaction. */
	knownSecrets?: readonly string[]
	handoffId?: string
	createdAt?: number
}

type ContextHandoffPaths = {
	workspacePath: string
	absolutePath: string
	directoryPath: string
	canonicalPath: string
}

function singleLine(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim()
}

function hashContent(content: string): string {
	return crypto.createHash("sha256").update(content, "utf8").digest("hex")
}

function getHandoffIdFromContent(content: string): string | undefined {
	const match = content.match(/^<!-- IVOL_CODE_CONTEXT_RESTART_V1 handoff_id=([a-f0-9-]+) -->/)
	return match?.[1]
}

function isVerifiedHandoffContent(content: string, handoffId: string, sha256: string): boolean {
	return getHandoffIdFromContent(content) === handoffId && hashContent(content) === sha256
}

export function redactPotentialSecrets(content: string, knownSecrets: readonly string[] = []): string {
	let redacted = content

	// Exact values are the strongest signal. Replace longer values first so a
	// short value cannot leave a suffix of a longer credential behind.
	const exactSecrets = [...new Set(knownSecrets.filter((secret) => secret.length >= 4))].sort(
		(a, b) => b.length - a.length,
	)
	for (const secret of exactSecrets) {
		redacted = redacted.split(secret).join(REDACTED_SECRET)
	}

	return (
		redacted
			.replace(/-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gi, REDACTED_SECRET)
			.replace(/(\b(?:cookie|set-cookie)\s*:\s*)[^\r\n]*/gi, `$1${REDACTED_SECRET}`)
			// Authorization credentials contain a space, so redact them before the
			// generic assignment matcher can consume only the auth-scheme prefix.
			.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED_SECRET}`)
			.replace(
				/((?:["'`])?(?:(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|auth(?:orization)?|password|passwd|secret(?:[_-]?access[_-]?key)?|client[_-]?secret|private[_-]?key|session[_-]?(?:id|token)|credential|cookie))(?:["'`])?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;}\]]+)/gi,
				`$1${REDACTED_SECRET}`,
			)
			.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED_SECRET)
			.replace(/\b(?:ivol-managed|sk-(?:ant-|proj-)?|rk-|pk-)[A-Za-z0-9_-]{12,}\b/gi, REDACTED_SECRET)
			.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, REDACTED_SECRET)
			.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED_SECRET)
			.replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, REDACTED_SECRET)
			.replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, REDACTED_SECRET)
			.replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, REDACTED_SECRET)
			.replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, REDACTED_SECRET)
			.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED_SECRET)
			.replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, `$1${REDACTED_SECRET}@`)
	)
}

function buildContextHandoffDocument({
	handoffId,
	taskId,
	condenseId,
	modelId,
	createdAt,
	trigger,
	body,
}: {
	handoffId: string
	taskId: string
	condenseId: string
	modelId: string
	createdAt: number
	trigger: ContextHandoffTrigger
	body: string
}): string {
	return `<!-- ${CONTEXT_HANDOFF_MAGIC} handoff_id=${singleLine(handoffId)} -->
# IVOL Code — Context Restart

> If this file exists, read it before any other project file. Treat it as the authoritative continuation state and resume from its pending next step before doing anything else. After the first successful continuation, delete or clear this file; IVOL Code also removes it automatically after safely saving that response.

- Task ID: ${singleLine(taskId)}
- Condense ID: ${singleLine(condenseId)}
- Created: ${new Date(createdAt).toISOString()}
- Trigger: ${trigger}
- Model: ${singleLine(modelId)}

${body}
`
}

function isPathInside(parentPath: string, childPath: string): boolean {
	const relative = path.relative(parentPath, childPath)
	return (
		relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
	)
}

async function assertSafeHandoffDirectory(workspacePath: string, directoryPath: string): Promise<string> {
	const resolvedWorkspace = path.resolve(workspacePath)
	const resolvedDirectory = path.resolve(directoryPath)

	if (resolvedDirectory !== resolvedWorkspace && !isPathInside(resolvedWorkspace, resolvedDirectory)) {
		throw new Error("The context restart file must stay inside the current workspace")
	}

	const workspaceStats = await fs.stat(resolvedWorkspace)
	if (!workspaceStats.isDirectory()) {
		throw new Error("The context restart workspace path is not a directory")
	}

	await fs.mkdir(resolvedDirectory, { recursive: true })
	const directoryStats = await fs.lstat(resolvedDirectory)
	if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
		throw new Error("Refusing to use a symbolic link or non-directory for the context restart directory")
	}

	const [realWorkspace, realDirectory] = await Promise.all([
		fs.realpath(resolvedWorkspace),
		fs.realpath(resolvedDirectory),
	])
	if (realDirectory !== realWorkspace && !isPathInside(realWorkspace, realDirectory)) {
		throw new Error("The context restart directory resolves outside the current workspace")
	}

	return realDirectory
}

async function assertRegularFileIfPresent(filePath: string, description: string): Promise<boolean> {
	try {
		const stats = await fs.lstat(filePath)
		if (stats.isSymbolicLink() || !stats.isFile()) {
			throw new Error(`Refusing to use a symbolic link or non-regular file for ${description}`)
		}
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false
		}
		throw error
	}
}

async function readRegularFile(filePath: string, description: string): Promise<string> {
	if (!(await assertRegularFileIfPresent(filePath, description))) {
		const error = new Error(`${description} does not exist`) as NodeJS.ErrnoException
		error.code = "ENOENT"
		throw error
	}
	return fs.readFile(filePath, "utf8")
}

async function ensureContextHandoffGitIgnore(directoryPath: string): Promise<void> {
	const ignorePath = path.join(directoryPath, ".gitignore")
	const ignoreExists = await assertRegularFileIfPresent(ignorePath, "the IVOL context restart .gitignore")
	const existingContent = ignoreExists ? await fs.readFile(ignorePath, "utf8") : ""
	const existingRules = new Set(existingContent.split(/\r?\n/).map((line) => line.trim()))
	const missingRules = CONTEXT_HANDOFF_IGNORE_RULES.filter(
		(rule) => !existingRules.has(rule) && !existingRules.has(rule.slice(1)),
	)
	if (missingRules.length === 0) {
		return
	}

	const separator = existingContent.length === 0 || existingContent.endsWith("\n") ? "" : "\n"
	const nextContent = `${existingContent}${separator}# IVOL Code generated context handoff files\n${missingRules.join("\n")}\n`
	const ignoreMode = ignoreExists ? (await fs.stat(ignorePath)).mode & 0o777 : 0o644
	const temporaryPath = `${ignorePath}.${process.pid}.${crypto.randomUUID()}.tmp`
	let handle: Awaited<ReturnType<typeof fs.open>> | undefined
	try {
		handle = await fs.open(temporaryPath, "wx", ignoreMode)
		await handle.chmod(ignoreMode) // Preserve existing permissions even under a restrictive umask.
		await handle.writeFile(nextContent, { encoding: "utf8" })
		await handle.sync()
		await handle.close()
		handle = undefined

		// Refuse to replace a path that became a symlink or non-regular file
		// while the new ignore file was being prepared.
		const currentExists = await assertRegularFileIfPresent(ignorePath, "the IVOL context restart .gitignore")
		if (currentExists !== ignoreExists) {
			throw new Error("The IVOL context restart .gitignore changed while it was being updated")
		}
		if (currentExists && (await fs.readFile(ignorePath, "utf8")) !== existingContent) {
			throw new Error("The IVOL context restart .gitignore changed while it was being updated")
		}
		await fs.rename(temporaryPath, ignorePath)
		await syncDirectoryBestEffort(directoryPath)
	} finally {
		await handle?.close().catch(() => undefined)
		await fs.unlink(temporaryPath).catch(() => undefined)
	}
}

async function assertExistingFileCanBeReplaced(filePath: string, handoffId: string): Promise<void> {
	try {
		const existing = await readRegularFile(filePath, "the context restart file")
		const existingHandoffId = getHandoffIdFromContent(existing)
		if (!existingHandoffId) {
			throw new Error(
				`${CONTEXT_HANDOFF_RELATIVE_PATH} already exists but was not created by IVOL Code; it was left unchanged`,
			)
		}
		if (existingHandoffId !== handoffId) {
			throw new Error(
				`${CONTEXT_HANDOFF_RELATIVE_PATH} already contains another pending IVOL Code handoff; it was left unchanged`,
			)
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error
		}
	}
}

async function syncDirectoryBestEffort(directoryPath: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof fs.open>> | undefined
	try {
		handle = await fs.open(directoryPath, "r")
		await handle.sync()
	} catch {
		// Directory fsync is unavailable on some supported platforms/filesystems.
	} finally {
		await handle?.close().catch(() => undefined)
	}
}

async function prepareContextHandoffPaths(workspacePath: string): Promise<ContextHandoffPaths> {
	const absolutePath = path.resolve(workspacePath, CONTEXT_HANDOFF_RELATIVE_PATH)
	const directoryPath = path.dirname(absolutePath)
	const realDirectory = await assertSafeHandoffDirectory(workspacePath, directoryPath)

	return {
		workspacePath,
		absolutePath,
		directoryPath,
		canonicalPath: path.join(realDirectory, path.basename(absolutePath)),
	}
}

async function withInterprocessLock<T>(absolutePath: string, operation: () => Promise<T>): Promise<T> {
	const release = await lockfile.lock(absolutePath, {
		realpath: false,
		stale: 31_000,
		update: 10_000,
		retries: {
			retries: 8,
			factor: 2,
			minTimeout: 50,
			maxTimeout: 1_000,
		},
	})

	let result!: T
	let operationError: unknown
	let operationFailed = false
	try {
		result = await operation()
	} catch (error) {
		operationFailed = true
		operationError = error
	}

	try {
		await release()
	} catch (releaseError) {
		if (!operationFailed) {
			throw releaseError
		}
	}

	if (operationFailed) {
		throw operationError
	}
	return result
}

async function persistContextHandoffDocument({
	paths,
	content,
	handoffId,
}: {
	paths: ContextHandoffPaths
	content: string
	handoffId: string
}): Promise<{ absolutePath: string; sha256: string; content: string }> {
	if (getHandoffIdFromContent(content) !== handoffId) {
		throw new Error("The embedded context restart file has invalid ownership metadata")
	}

	const sha256 = hashContent(content)
	const temporaryPath = `${paths.absolutePath}.${process.pid}.${crypto.randomUUID()}.tmp`
	let temporaryHandle: Awaited<ReturnType<typeof fs.open>> | undefined

	await assertExistingFileCanBeReplaced(paths.absolutePath, handoffId)

	try {
		temporaryHandle = await fs.open(temporaryPath, "wx", 0o600)
		await temporaryHandle.writeFile(content, { encoding: "utf8" })
		await temporaryHandle.sync()
		await temporaryHandle.close()
		temporaryHandle = undefined

		// Re-check containment and ownership immediately before the atomic replace.
		await assertSafeHandoffDirectory(paths.workspacePath, paths.directoryPath)
		await assertExistingFileCanBeReplaced(paths.absolutePath, handoffId)
		await fs.rename(temporaryPath, paths.absolutePath)
		await syncDirectoryBestEffort(paths.directoryPath)

		const persistedContent = await readRegularFile(paths.absolutePath, "the context restart file")
		if (persistedContent !== content || hashContent(persistedContent) !== sha256) {
			throw new Error("The context restart file failed read-back verification")
		}
	} finally {
		await temporaryHandle?.close().catch(() => undefined)
		await fs.unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") {
				console.warn("Failed to remove a temporary context restart file:", error.message)
			}
		})
	}

	return { absolutePath: paths.absolutePath, sha256, content }
}

async function enqueueContextHandoffWrite<T>(
	workspacePath: string,
	operation: (paths: ContextHandoffPaths) => Promise<T>,
): Promise<T> {
	const paths = await prepareContextHandoffPaths(workspacePath)
	const previousWrite = writeQueues.get(paths.canonicalPath)
	const queuedWrite = (previousWrite ? previousWrite.catch(() => undefined) : Promise.resolve()).then(() =>
		withInterprocessLock(paths.absolutePath, async () => {
			await assertSafeHandoffDirectory(workspacePath, paths.directoryPath)
			await ensureContextHandoffGitIgnore(paths.directoryPath)
			return operation(paths)
		}),
	)
	writeQueues.set(paths.canonicalPath, queuedWrite)

	try {
		return await queuedWrite
	} finally {
		if (writeQueues.get(paths.canonicalPath) === queuedWrite) {
			writeQueues.delete(paths.canonicalPath)
		}
	}
}

async function writeContextHandoffFileInternal(
	options: ContextHandoffWriteOptions,
	paths: ContextHandoffPaths,
): Promise<ContextHandoffRecord> {
	const summary = options.summary.trim()
	if (!summary) {
		throw new Error("Cannot create the context restart file from an empty summary")
	}
	if (!options.condenseId.trim()) {
		throw new Error("Cannot create the context restart file without a condense ID")
	}

	const handoffId = options.handoffId ?? crypto.randomUUID()
	const createdAt = options.createdAt ?? Date.now()
	const body = redactPotentialSecrets(summary, options.knownSecrets)
	const content = buildContextHandoffDocument({
		handoffId,
		taskId: options.taskId,
		condenseId: options.condenseId,
		modelId: options.modelId,
		createdAt,
		trigger: options.trigger,
		body,
	})
	const persisted = await persistContextHandoffDocument({ paths, content, handoffId })

	return {
		handoffId,
		relativePath: CONTEXT_HANDOFF_RELATIVE_PATH,
		absolutePath: persisted.absolutePath,
		body,
		content: persisted.content,
		sha256: persisted.sha256,
		createdAt,
	}
}

/**
 * Atomically writes and verifies the fixed workspace handoff file. Writes to
 * the same project are serialized across tasks, windows, and extension hosts.
 */
export async function writeContextHandoffFile(options: ContextHandoffWriteOptions): Promise<ContextHandoffRecord> {
	return enqueueContextHandoffWrite(options.workspacePath, (paths) => writeContextHandoffFileInternal(options, paths))
}

/** Retire a pre-5.16.226 copy only after its identical root copy was consumed. */
async function deleteMatchingLegacyContextHandoff(workspacePath: string, expectedContent: string): Promise<void> {
	const legacyPath = path.resolve(workspacePath, LEGACY_CONTEXT_HANDOFF_RELATIVE_PATH)
	const legacyDirectory = path.dirname(legacyPath)
	try {
		// Do not create the old directory, and never follow a legacy symlink.
		await fs.lstat(legacyDirectory)
		await assertSafeHandoffDirectory(workspacePath, legacyDirectory)
		await withInterprocessLock(legacyPath, async () => {
			const content = await readRegularFile(legacyPath, "the legacy context restart file")
			if (content === expectedContent) {
				await fs.unlink(legacyPath)
				await syncDirectoryBestEffort(legacyDirectory)
			}
		})
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn("Legacy context restart file was left unchanged:", error)
		}
	}
}

/** Removes only the pending file created for this exact handoff. */
export async function deleteContextHandoffFileIfOwned({
	workspacePath,
	handoffId,
}: {
	workspacePath: string
	handoffId: string
}): Promise<boolean> {
	return enqueueContextHandoffWrite(workspacePath, async (paths) => {
		try {
			const content = await readRegularFile(paths.absolutePath, "the context restart file")
			if (getHandoffIdFromContent(content) !== handoffId) {
				return false
			}
			await fs.unlink(paths.absolutePath)
			await syncDirectoryBestEffort(paths.directoryPath)
			await deleteMatchingLegacyContextHandoff(workspacePath, content)
			return true
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return false
			}
			throw error
		}
	})
}

function replaceSummaryText(message: ApiMessage, text: string): ApiMessage {
	if (typeof message.content === "string") {
		return { ...message, content: text }
	}

	let replaced = false
	const content = message.content.map((block) => {
		if (!replaced && block.type === "text") {
			replaced = true
			return { ...block, text } satisfies Anthropic.Messages.TextBlockParam
		}
		return block
	})

	if (!replaced) {
		throw new Error("The condensed summary has no text block for the context restart file")
	}

	return { ...message, content }
}

export function attachContextHandoffToSummary(
	messages: ApiMessage[],
	condenseId: string,
	record: ContextHandoffRecord,
): ApiMessage[] {
	let attached = false
	const updatedMessages = messages.map((message) => {
		if (!message.isSummary || message.condenseId !== condenseId) {
			return message
		}

		attached = true
		return {
			// `body` is intentionally retained in history. The complete document is
			// injected only into the first request by hydratePendingContextHandoff.
			...replaceSummaryText(message, record.body ?? record.content),
			contextHandoffId: record.handoffId,
			contextHandoffPath: record.relativePath,
			contextHandoffSha256: record.sha256,
			contextHandoffContent: record.content,
			contextHandoffCreatedAt: record.createdAt,
			contextHandoffConsumedAt: undefined,
		}
	})

	if (!attached) {
		throw new Error(`Could not find condensed summary ${condenseId} for the context restart file`)
	}

	return updatedMessages
}

export function findPendingContextHandoff(messages: ApiMessage[]): ApiMessage | undefined {
	return [...messages]
		.reverse()
		.find(
			(message) =>
				message.isSummary &&
				Boolean(message.contextHandoffId) &&
				Boolean(message.contextHandoffPath) &&
				Boolean(message.contextHandoffSha256) &&
				Boolean(message.contextHandoffContent) &&
				!message.contextHandoffConsumedAt,
		)
}

/**
 * Hydrates a request-local copy of the pending summary with the complete
 * handoff document. The persisted summary itself remains body-only.
 */
export async function hydratePendingContextHandoff({
	messages,
	workspacePath,
}: {
	messages: ApiMessage[]
	workspacePath: string
}): Promise<{ messages: ApiMessage[]; handoffId?: string; fileReady?: boolean }> {
	const pending = findPendingContextHandoff(messages)
	if (
		!pending?.contextHandoffId ||
		!pending.contextHandoffSha256 ||
		!pending.contextHandoffContent ||
		!pending.condenseId
	) {
		return { messages }
	}

	const handoffId = pending.contextHandoffId
	const sha256 = pending.contextHandoffSha256
	const embeddedContent = pending.contextHandoffContent
	const embeddedIsVerified = isVerifiedHandoffContent(embeddedContent, handoffId, sha256)
	let content: string | undefined
	let fileReady = false

	try {
		const hydration = await enqueueContextHandoffWrite(workspacePath, async (paths) => {
			try {
				const diskContent = await readRegularFile(paths.absolutePath, "the context restart file")
				if (isVerifiedHandoffContent(diskContent, handoffId, sha256)) {
					return { content: diskContent, fileReady: true }
				}

				if (!embeddedIsVerified) {
					throw new Error("The embedded context restart snapshot failed integrity verification")
				}

				// Another task owns the single fixed workspace file. Do not replace
				// it; use only this task's verified embedded snapshot for the request.
				return { content: embeddedContent, fileReady: false }
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					if (!embeddedIsVerified) {
						throw error
					}
					console.warn(
						"Failed to read the context restart file; using the verified embedded snapshot:",
						error,
					)
					return { content: embeddedContent, fileReady: false }
				}
			}

			if (!embeddedIsVerified) {
				throw new Error("The embedded context restart snapshot failed integrity verification")
			}

			try {
				const restored = await persistContextHandoffDocument({ paths, content: embeddedContent, handoffId })
				return { content: restored.content, fileReady: true }
			} catch (error) {
				// A racing writer or filesystem error must not block the task. Never
				// replace its file; inject this verified task-local snapshot only.
				console.warn("Failed to restore the context restart file; using the verified embedded snapshot:", error)
				return { content: embeddedContent, fileReady: false }
			}
		})
		content = hydration.content
		fileReady = hydration.fileReady
	} catch (error) {
		if (!embeddedIsVerified) {
			console.warn("Ignoring an invalid context restart snapshot:", error)
			return { messages }
		}
		console.warn("Failed to lock the context restart file; using the verified embedded snapshot:", error)
		content = embeddedContent
		fileReady = false
	}

	const hydratedMessages = messages.map((message) =>
		message === pending ? replaceSummaryText(message, content!) : message,
	)
	return { messages: hydratedMessages, handoffId, fileReady }
}

export function buildContextHandoffPrompt(basePrompt: string): string {
	return `${basePrompt.trim()}

Mandatory IVOL context-restart handoff requirements:
- Your output will be saved as the continuation body of ${CONTEXT_HANDOFF_RELATIVE_PATH} before any earlier context is hidden.
- Treat this as a full working-memory snapshot, not a brief chat summary. Completeness and exact continuation value are more important than brevity.
- Record the exact active objective, the user's latest explicit constraints, verified completed work, current status, important decisions and rationale, modified and relevant files/symbols, commands/tests and their results, failures and blockers, uncommitted state, and the exact next action.
- Preserve concrete names, paths, values, and code snippets needed to continue without guessing. Clearly distinguish verified facts from hypotheses.
- Never include API keys, access tokens, passwords, cookies, private keys, or other raw secrets. State only that the required secret is configured and where it is referenced.
- Write a self-contained Markdown continuation state, not commentary about summarizing. Do not omit unfinished work.
- End with an explicit note that, after this file has been read and the work has successfully continued, ${CONTEXT_HANDOFF_RELATIVE_PATH} should be deleted or cleared so it is not treated as pending again.
`
}
