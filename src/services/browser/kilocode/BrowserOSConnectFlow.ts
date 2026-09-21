// kilocode_change - new file
export class BrowserOSUnavailableError extends Error {}

export type BrowserOSConnectStage = "connecting" | "launching" | "permission"

/** One explicit UI action, bound to the task and mode that initiated it. */
export async function connectBrowserOSForTask<T>(options: {
	isCurrent: () => boolean
	connect: () => Promise<T>
	launch: () => Promise<boolean>
	grant: (connection: T) => Promise<void>
	progress: (stage: BrowserOSConnectStage) => Promise<void>
}): Promise<T | undefined> {
	const assertCurrent = () => {
		if (!options.isCurrent()) throw new Error("Browser connection request expired")
	}
	assertCurrent()
	await options.progress("connecting")
	let connection: T
	try {
		assertCurrent()
		connection = await options.connect()
	} catch (error) {
		assertCurrent()
		// Configuration errors and permission refusals must never trigger an application launch.
		if (!(error instanceof BrowserOSUnavailableError)) throw error
		await options.progress("launching")
		assertCurrent()
		if (!(await options.launch())) return undefined
		assertCurrent()
		await options.progress("connecting")
		// Only transport readiness is retried, never browser page actions or a launch.
		const deadline = Date.now() + 15000
		while (true) {
			assertCurrent()
			try {
				connection = await options.connect()
				break
			} catch (retryError) {
				if (!(retryError instanceof BrowserOSUnavailableError) || Date.now() >= deadline) throw retryError
				await new Promise((resolve) => setTimeout(resolve, 500))
			}
		}
	}
	assertCurrent()
	await options.progress("permission")
	assertCurrent()
	await options.grant(connection)
	assertCurrent()
	return connection
}
