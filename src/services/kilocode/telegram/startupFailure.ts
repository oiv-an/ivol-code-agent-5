// kilocode_change - new file

/** Fixed codes only: neither API response text nor an exception stack may cross the private IPC boundary. */
export const telegramStartupReasons = [
	"topics-disabled",
	"webhook-active",
	"token-rejected",
	"polling-conflict",
	"telegram-unreachable",
	"telegram-rate-limited",
	"telegram-rejected",
	"local-runtime",
	"startup-failed",
] as const
export type TelegramStartupReason = (typeof telegramStartupReasons)[number]

const stages = [
	"configuration",
	"runtime-path",
	"bundle",
	"spawn",
	"startup",
	"authentication",
	"mcp-connect",
	"reconnect",
	"activate",
	"activateProject",
	"hasTopic",
	"renameTopic",
	"heartbeat",
	"operation",
	"route",
	"getMe",
	"getWebhookInfo",
	"getUpdates",
	"createForumTopic",
	"editForumTopic",
	"setMyCommands",
	"sendMessage",
	"pinChatMessage",
] as const
export type TelegramFailureStage = (typeof stages)[number]
const codes = [
	"ENOENT",
	"EACCES",
	"EPERM",
	"ECONNREFUSED",
	"ECONNRESET",
	"EPIPE",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EADDRINUSE",
	"ELOCKED",
	"UND_ERR_CONNECT_TIMEOUT",
	"TimeoutError",
	"AbortError",
	"invalid-response",
	"unavailable",
	"unknown",
] as const

/** Never copy arbitrary messages, paths, response bodies or unvalidated IPC fields. */
export function safeTelegramCode(error: unknown): string {
	if (!error || typeof error !== "object") return "unknown"
	const value = error as { code?: unknown; name?: unknown; cause?: unknown }
	if (
		value.name === "TelegramApiError" &&
		typeof value.code === "number" &&
		Number.isInteger(value.code) &&
		value.code >= 100 &&
		value.code <= 599
	)
		return String(value.code)
	if (value.code === -32001) return "ETIMEDOUT"
	for (const code of codes) if (value.code === code || value.name === code) return code
	if (value.cause && typeof value.cause === "object") {
		const code = (value.cause as { code?: unknown }).code
		if (codes.some((item) => item === code)) return String(code)
	}
	return "unknown"
}

export class TelegramStartupError extends Error {
	constructor(
		readonly reason: TelegramStartupReason,
		readonly stage?: TelegramFailureStage,
		readonly code?: string,
	) {
		super(reason)
	}
}

export function telegramFailure(error: unknown, stage: TelegramFailureStage): TelegramStartupError {
	if (error instanceof TelegramStartupError && error.stage) return decodeTelegramFailure(error)!
	if (error && typeof error === "object" && "stage" in error) {
		const apiStage = stages.find((item) => item === error.stage)
		if (apiStage) return new TelegramStartupError(telegramStartupReason(error), apiStage, safeTelegramCode(error))
	}
	return new TelegramStartupError(telegramStartupReason(error), stage, safeTelegramCode(error))
}

export function telegramFailureDetails(error: unknown): string {
	const failure = decodeTelegramFailure(error)
	return failure?.stage ? ` [${failure.stage}; ${failure.code ?? "unknown"}]` : ""
}

/** Validate even authenticated IPC: older coordinators may return only a generic error. */
export function decodeTelegramFailure(value: unknown): TelegramStartupError | undefined {
	if (!value || typeof value !== "object") return undefined
	const data = value as { reason?: unknown; stage?: unknown; code?: unknown }
	if (!isTelegramStartupReason(data.reason)) return undefined
	const stage = stages.find((item) => item === data.stage)
	const code =
		typeof data.code === "string" && (codes.some((item) => item === data.code) || /^[1-5]\d{2}$/.test(data.code))
			? data.code
			: undefined
	return new TelegramStartupError(data.reason, stage, code)
}

export function telegramStartupReason(error: unknown): TelegramStartupReason {
	if (error instanceof TelegramStartupError) return error.reason
	if (
		error instanceof Error &&
		error.name === "TelegramApiError" &&
		"code" in error &&
		typeof error.code === "number"
	) {
		if (error.code === 401 || error.code === 404) return "token-rejected"
		if (error.code === 409) return "polling-conflict"
		if (error.code === 429) return "telegram-rate-limited"
		if (error.code === 503 || error.code === 499) return "telegram-unreachable"
		return "telegram-rejected"
	}
	return "local-runtime"
}

export function isTelegramStartupReason(value: unknown): value is TelegramStartupReason {
	return typeof value === "string" && telegramStartupReasons.some((reason) => reason === value)
}
