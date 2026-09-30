import * as vscode from "vscode"

export interface UsageReason {
	kind: "self" | "task" | "debug" | "dependency"
	detail: string
}

// Read configuration only: never fetch tasks (which can activate providers) or run builds.
export function inspectAdvisorUsage(root: vscode.Uri) {
	const reasons = new Map<string, UsageReason[]>()
	const add = (id: string, reason: UsageReason) => {
		const key = id.toLowerCase()
		const list = reasons.get(key) ?? []
		if (list.length < 20 && !list.some((item) => item.kind === reason.kind && item.detail === reason.detail)) {
			list.push(reason)
			reasons.set(key, list)
		}
	}
	add("ivol.ivol-code-agent-5", { kind: "self", detail: "IVOL" })
	const objects = (value: unknown): Record<string, unknown>[] =>
		Array.isArray(value) ? value.slice(0, 500).filter((item) => item && typeof item === "object") : []
	const taskTypes = new Set(
		objects(vscode.workspace.getConfiguration("tasks", root).get("tasks")).map((item) => item.type),
	)
	const debugTypes = new Set(
		objects(vscode.workspace.getConfiguration("launch", root).get("configurations")).map((item) => item.type),
	)
	const extensions = vscode.extensions.all
	for (const extension of extensions) {
		const contributions = extension.packageJSON.contributes ?? {}
		for (const task of objects(contributions.taskDefinitions)) {
			if (typeof task.type === "string" && !["shell", "process"].includes(task.type) && taskTypes.has(task.type))
				add(extension.id, { kind: "task", detail: task.type })
		}
		for (const debug of objects(contributions.debuggers)) {
			if (typeof debug.type === "string" && debugTypes.has(debug.type))
				add(extension.id, { kind: "debug", detail: debug.type })
		}
	}
	// Propagate only actual extensionDependencies, never optional extension packs.
	const queue = [...reasons.keys()]
	const visited = new Set<string>()
	const byId = new Map(extensions.map((extension) => [extension.id.toLowerCase(), extension]))
	while (queue.length && visited.size < 1000) {
		const id = queue.shift()!
		if (visited.has(id)) continue
		visited.add(id)
		const dependencies = byId.get(id)?.packageJSON.extensionDependencies
		if (!Array.isArray(dependencies)) continue
		for (const dependency of dependencies.slice(0, 100)) {
			if (typeof dependency !== "string") continue
			add(dependency, { kind: "dependency", detail: id })
			queue.push(dependency.toLowerCase())
		}
	}
	return reasons
}
