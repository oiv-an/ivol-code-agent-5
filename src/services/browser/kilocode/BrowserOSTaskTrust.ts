import { createHash } from "node:crypto"
import type { Memento } from "vscode"

export interface BrowserOSTaskIdentity {
	taskId: string
	cwd: string
}

export interface BrowserOSTaskGrant {
	version: 1
	serverName: string
	endpoint: string
	allowTaskActions: boolean
	blocked?: boolean
}

/** Local user decisions only: never serialize these records into portable task history. */
export class BrowserOSTaskTrust {
	constructor(private readonly storage: Memento) {}

	private key(task: BrowserOSTaskIdentity): string {
		const identity = createHash("sha256")
			.update(JSON.stringify([task.cwd, task.taskId]))
			.digest("hex")
		return `ivol.browserTaskTrust.v1.${identity}`
	}

	get(task: BrowserOSTaskIdentity): BrowserOSTaskGrant | undefined {
		const value = this.storage.get<BrowserOSTaskGrant>(this.key(task))
		if (
			value?.version !== 1 ||
			typeof value.serverName !== "string" ||
			typeof value.endpoint !== "string" ||
			typeof value.allowTaskActions !== "boolean"
		)
			return undefined
		return value
	}

	async grant(task: BrowserOSTaskIdentity, grant: Omit<BrowserOSTaskGrant, "version">): Promise<void> {
		await this.storage.update(this.key(task), { ...grant, version: 1 })
	}

	async block(task: BrowserOSTaskIdentity): Promise<void> {
		const grant = this.get(task)
		if (grant) await this.storage.update(this.key(task), { ...grant, blocked: true })
	}

	async revoke(task: BrowserOSTaskIdentity): Promise<void> {
		await this.storage.update(this.key(task), undefined)
	}
}
