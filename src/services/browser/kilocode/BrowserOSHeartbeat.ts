// kilocode_change - new file

/** Keep an existing MCP transport alive, without calling browser tools or renewing consent. */
export class BrowserOSHeartbeat {
	private timer?: ReturnType<typeof setTimeout>
	private stopped = false

	constructor(
		private readonly isCurrent: () => boolean,
		private readonly ping: () => Promise<unknown>,
		private readonly onFailure: (error: unknown) => void,
	) {
		this.schedule()
	}

	stop(): void {
		this.stopped = true
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
	}

	private schedule(): void {
		if (this.stopped) return
		// rmcp expires idle sessions after 300 seconds. Leave room for slow requests.
		this.timer = setTimeout(() => void this.tick(), 60_000)
		this.timer.unref?.()
	}

	private async tick(): Promise<void> {
		if (this.stopped || !this.isCurrent()) {
			this.stop()
			return
		}
		try {
			await this.ping()
		} catch (error) {
			if (!this.stopped && this.isCurrent()) this.onFailure(error)
			this.stop()
			return
		}
		this.schedule()
	}
}
