export interface TelegramOutboxItem {
	key: string
	text: string
	partial: boolean
	image?: boolean
	markdown?: boolean
	generation: number
}

/** Coalesce only unsent versions of the same message, preserving order across messages. */
export class TelegramOutbox {
	private readonly pending = new Map<string, TelegramOutboxItem>()
	private bytes = 0
	private running?: Promise<void>
	private generation = 0

	constructor(
		private readonly deliver: (item: TelegramOutboxItem) => Promise<void>,
		private readonly onFailure: (error: unknown) => void,
		private readonly maximumBytes = 32 * 1024 * 1024,
	) {}

	enqueue(key: string, text: string, partial: boolean, image = false, markdown = false): void {
		const old = this.pending.get(key)
		if (old && !old.partial && partial) return
		const bytes = this.bytes - Buffer.byteLength(old?.text ?? "") + Buffer.byteLength(text)
		if (bytes > this.maximumBytes || (!old && this.pending.size >= 1000)) {
			throw new Error("Telegram delivery queue is full")
		}
		this.bytes = bytes
		this.pending.set(key, { key, text, partial, image, markdown, generation: this.generation })
		this.start()
	}

	private start(): void {
		if (this.running) return
		this.running = Promise.resolve()
			.then(async () => {
				while (this.pending.size) {
					const item = this.pending.values().next().value as TelegramOutboxItem
					this.pending.delete(item.key)
					this.bytes -= Buffer.byteLength(item.text)
					await this.deliver(item)
				}
			})
			.catch((error: unknown) => {
				this.clear()
				this.onFailure(error)
			})
			.finally(() => {
				this.running = undefined
				if (this.pending.size) this.start()
			})
	}

	clear(): void {
		this.generation++
		this.pending.clear()
		this.bytes = 0
	}

	get currentGeneration(): number {
		return this.generation
	}

	async flush(): Promise<void> {
		while (this.running) await this.running
	}
}
