/**
 * Marks an API failure that must not be submitted again automatically.
 *
 * This is used when the provider has already completed billable work but its
 * response cannot be consumed safely. The user may still choose to retry.
 */
export class NonRetryableApiError extends Error {
	readonly retryable = false

	constructor(message: string) {
		super(message)
		this.name = "NonRetryableApiError"
	}
}

export function isNonRetryableApiError(error: unknown): boolean {
	return (
		error instanceof NonRetryableApiError ||
		(typeof error === "object" && error !== null && (error as { retryable?: unknown }).retryable === false)
	)
}
