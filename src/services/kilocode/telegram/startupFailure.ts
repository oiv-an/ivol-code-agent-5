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

export class TelegramStartupError extends Error {
	constructor(readonly reason: TelegramStartupReason) {
		super(reason)
	}
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
