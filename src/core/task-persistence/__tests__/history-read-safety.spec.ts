// kilocode_change - new file
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { readApiMessages } from "../apiMessages"
import { readTaskMessages } from "../taskMessages"

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi.fn(async (root: string, id: string) => path.join(root, id)),
}))

let root: string
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "ivol-history-read-"))
})
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
})

it("rejects missing resumed histories without creating directories or empty replacements", async () => {
	const options = { taskId: "task", globalStoragePath: root, mustExist: true }
	await expect(readApiMessages(options)).rejects.toThrow("API history is missing")
	await expect(readTaskMessages(options)).rejects.toThrow("Task messages are missing")
	expect(await fs.readdir(root)).toEqual([])
})

it("preserves the only legacy API copy across repeated reads", async () => {
	await fs.mkdir(path.join(root, "task"))
	const file = path.join(root, "task", "claude_messages.json")
	const content = JSON.stringify([{ role: "user", content: "original request" }])
	await fs.writeFile(file, content)
	const options = { taskId: "task", globalStoragePath: root, mustExist: true }
	await expect(readApiMessages(options)).resolves.toEqual(JSON.parse(content))
	await expect(readApiMessages(options)).resolves.toEqual(JSON.parse(content))
	expect(await fs.readFile(file, "utf8")).toBe(content)
})

it.each(["{}", "broken JSON"])("rejects invalid histories without changing their bytes: %s", async (content) => {
	await fs.mkdir(path.join(root, "task"))
	const api = path.join(root, "task", "api_conversation_history.json")
	const ui = path.join(root, "task", "ui_messages.json")
	await fs.writeFile(api, content)
	await fs.writeFile(ui, content)
	const options = { taskId: "task", globalStoragePath: root, mustExist: true }
	await expect(readApiMessages(options)).rejects.toThrow()
	await expect(readTaskMessages(options)).rejects.toThrow()
	expect(await fs.readFile(api, "utf8")).toBe(content)
	expect(await fs.readFile(ui, "utf8")).toBe(content)
})
