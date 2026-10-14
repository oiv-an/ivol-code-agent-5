// kilocode_change - new file
export class BrowserOSUnavailableError extends Error {}

export type BrowserOSConnectStage = "connecting" | "launching" | "permission"

/** One explicit UI action, bound to the task and mode that initiated it. */
export async function connectBrowserOSForTask<T>(options: {
	isCurrent: () => boolean
	connect: () => Promise<T>
	// Only an explicit UI action may offer to launch an application.
	launch?: () => Promise<boolean>
	grant: (connection: T) => Promise<void>
	progress: (stage: BrowserOSConnectStage) => Promise<void>
}): Promise<T | undefined> {
	const assertCurrent = () => {
		if (!options.isCurrent()) throw new Error("Browser connection request expired")
	}
	// A running browser may still be starting its local server. Retry readiness only,
	// never a permission decision or a page action, before offering an application picker.
	const connectWhenReady = async (): Promise<T> => {
		const deadline = Date.now() + 15000
		while (true) {
			assertCurrent()
			try {
				return await options.connect()
			} catch (error) {
				assertCurrent()
				if (!(error instanceof BrowserOSUnavailableError) || Date.now() >= deadline) throw error
				await new Promise((resolve) => setTimeout(resolve, 500))
			}
		}
	}
	assertCurrent()
	await options.progress("connecting")
	let connection: T
	try {
		connection = await connectWhenReady()
	} catch (error) {
		assertCurrent()
		if (!(error instanceof BrowserOSUnavailableError)) throw error
		if (!options.launch)
			throw new BrowserOSUnavailableError(
				"BrowserOS local server is unavailable after waiting for startup. This is not a permission refusal. " +
					"Start BrowserOS neo or use the browser settings connection button, then retry. No browser action was sent.",
			)
		await options.progress("launching")
		assertCurrent()
		if (!(await options.launch())) return undefined
		assertCurrent()
		await options.progress("connecting")
		connection = await connectWhenReady()
	}
	assertCurrent()
	await options.progress("permission")
	assertCurrent()
	await options.grant(connection)
	assertCurrent()
	return connection
}
