// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { test } from "node:test"

import { ExtensionMemento } from "../deps/vscode/vs/workbench/api/common/extHostMemento.js"
import type { IExtensionMementoValueChange } from "../deps/vscode/vs/workbench/api/common/extHost.protocol.js"

interface StorageChangeEvent {
	shared: boolean
	key: string
	value: Record<string, unknown>
}

interface PendingWrite {
	value: Record<string, unknown>
	changes: readonly IExtensionMementoValueChange[] | undefined
	resolve: () => void
}

class ControlledStorage {
	readonly writes: PendingWrite[] = []
	private readonly listeners = new Set<(event: StorageChangeEvent) => void>()

	constructor(private readonly initialValue: Record<string, unknown>) {}

	readonly onDidChangeStorage = (listener: (event: StorageChangeEvent) => void) => {
		this.listeners.add(listener)
		return { dispose: () => this.listeners.delete(listener) }
	}

	async initializeExtensionStorage(): Promise<Record<string, unknown>> {
		return structuredClone(this.initialValue)
	}

	setValue(
		_shared: boolean,
		_key: string,
		value: Record<string, unknown>,
		changes?: readonly IExtensionMementoValueChange[],
	): Promise<void> {
		return new Promise((resolve) => {
			this.writes.push({ value: structuredClone(value), changes: structuredClone(changes), resolve })
		})
	}

	emit(value: Record<string, unknown>): void {
		for (const listener of this.listeners) {
			listener({ shared: true, key: EXTENSION_ID, value: structuredClone(value) })
		}
	}
}

test("batches the original value metadata and preserves a pending local update across broadcasts", async () => {
	const originalTask = { id: "original", task: "Original" }
	const localTask = { id: "local", task: "Local final" }
	const remoteTask = { id: "remote", task: "Remote" }
	const storage = new ControlledStorage({ taskHistory: [originalTask] })
	const memento = new ExtensionMemento(EXTENSION_ID, true, storage as never)
	await memento.whenReady

	const firstUpdate = memento.update("taskHistory", [{ id: "local", task: "Local draft" }])
	const finalUpdate = memento.update("taskHistory", [localTask])
	storage.emit({ taskHistory: [remoteTask], remoteSetting: true })

	assert.deepEqual(memento.get("taskHistory"), [localTask])
	assert.equal(memento.get("remoteSetting"), true)

	await waitFor(() => storage.writes.length === 1)
	const write = storage.writes[0]!
	assert.deepEqual(write.changes, [
		{
			key: "taskHistory",
			previousValueExists: true,
			previousValue: [originalTask],
		},
	])
	assert.deepEqual(write.value.taskHistory, [localTask])

	storage.emit({ taskHistory: [remoteTask, localTask], remoteSetting: true })
	assert.deepEqual(memento.get("taskHistory"), [localTask])
	write.resolve()
	await Promise.all([firstUpdate, finalUpdate])

	assert.deepEqual(memento.get("taskHistory"), [remoteTask, localTask])
	assert.equal(memento.get("remoteSetting"), true)
	memento.dispose()
})

test("reports deletion against the original value and accepts the canonical deletion", async () => {
	const storage = new ControlledStorage({ enabled: true, untouched: "kept" })
	const memento = new ExtensionMemento(EXTENSION_ID, true, storage as never)
	await memento.whenReady

	const update = memento.update("enabled", undefined)
	await waitFor(() => storage.writes.length === 1)
	const write = storage.writes[0]!
	assert.deepEqual(write.changes, [
		{
			key: "enabled",
			previousValueExists: true,
			previousValue: true,
		},
	])
	assert.equal(Object.hasOwn(write.value, "enabled"), false)
	assert.equal(write.value.enabled, undefined)

	storage.emit({ untouched: "kept" })
	write.resolve()
	await update
	assert.equal(memento.get("enabled"), undefined)
	assert.equal(memento.get("untouched"), "kept")
	memento.dispose()
})

test("serializes consecutive writes so the older request cannot overwrite the newer one", async () => {
	const storage = new ControlledStorage({ sequence: 0 })
	const memento = new ExtensionMemento(EXTENSION_ID, true, storage as never)
	await memento.whenReady

	const firstUpdate = memento.update("sequence", 1)
	await waitFor(() => storage.writes.length === 1)
	const secondUpdate = memento.update("sequence", 2)
	await new Promise((resolve) => setTimeout(resolve, 10))
	assert.equal(storage.writes.length, 1)

	storage.emit({ sequence: 1 })
	storage.writes[0]!.resolve()
	await firstUpdate
	await waitFor(() => storage.writes.length === 2)
	assert.equal(storage.writes[1]!.value.sequence, 2)

	storage.emit({ sequence: 2 })
	storage.writes[1]!.resolve()
	await secondUpdate
	assert.equal(memento.get("sequence"), 2)
	memento.dispose()
})

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (predicate()) {
			return
		}
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
	throw new Error("Timed out waiting for the memento write")
}

const EXTENSION_ID = "Kilo Code.kilo-code"
