// kilocode_change - new file
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { readOrdinaryPreparation, saveOrdinaryPreparation } from "../kilocode/ordinaryPreparationStorage"
import { OrdinaryContextPreparation } from "../kilocode/OrdinaryContextPreparation"

describe("durable ordinary preparation intent", () => {
	let storage: string
	beforeEach(async () => {
		storage = await fs.mkdtemp(path.join(os.tmpdir(), "ivol-preparation-"))
	})
	afterEach(async () => {
		await fs.rm(storage, { recursive: true, force: true })
	})

	it("persists a crash-safe trigger without authorization, configuration, or file contents", async () => {
		await saveOrdinaryPreparation(storage, "task-one", "forced")
		const trigger = await readOrdinaryPreparation(storage, "task-one")
		expect(trigger).toBe("forced")
		const saved = JSON.parse(
			await fs.readFile(path.join(storage, "tasks/task-one/ordinary_context_preparation.json"), "utf8"),
		)
		expect(saved).toEqual({ version: 1, trigger: "forced" })
		const restored = new OrdinaryContextPreparation(trigger!, {})
		restored.fail("Interrupted")
		expect(restored.phase).toBe("waiting")
		expect(restored.continuedWithoutUpdate).toBe(false)
		expect(restored.turns).toBe(0)
	})

	it("isolates task identities and clears only a finished operation", async () => {
		await saveOrdinaryPreparation(storage, "task-one", "manual")
		await saveOrdinaryPreparation(storage, "task-two", "automatic")
		await saveOrdinaryPreparation(storage, "task-one", null)
		expect(await readOrdinaryPreparation(storage, "task-one")).toBeUndefined()
		expect(await readOrdinaryPreparation(storage, "task-two")).toBe("automatic")
		expect(await readOrdinaryPreparation(storage, "new-task")).toBeUndefined()
	})
})
