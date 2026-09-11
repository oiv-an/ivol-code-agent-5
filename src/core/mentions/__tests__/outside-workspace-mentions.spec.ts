// kilocode_change - new file
// npx vitest core/mentions/__tests__/outside-workspace-mentions.spec.ts

import fs from "fs/promises"
import os from "os"
import * as path from "path"

import { parseMentions } from "../index"
import { UrlContentFetcher } from "../../../services/browser/UrlContentFetcher"

vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
	},
	languages: {
		getDiagnostics: vi.fn(() => []),
	},
	DiagnosticSeverity: { Error: 0, Warning: 1 },
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

describe("parseMentions with files outside the workspace", () => {
	let outsideDir: string
	let outsideFile: string
	let workspaceDir: string

	const urlContentFetcher = {
		launchBrowser: vi.fn(),
		urlToMarkdown: vi.fn(),
		closeBrowser: vi.fn(),
	} as unknown as UrlContentFetcher

	beforeAll(async () => {
		outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-outside-"))
		workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-workspace-"))
		outsideFile = path.join(outsideDir, "external-notes.txt")
		await fs.writeFile(outsideFile, "secret sauce recipe", "utf8")
	})

	afterAll(async () => {
		await fs.rm(outsideDir, { recursive: true, force: true })
		await fs.rm(workspaceDir, { recursive: true, force: true })
	})

	it("inlines the contents of an absolute path that lives outside the workspace", async () => {
		const result = await parseMentions(`Please read @${outsideFile}`, workspaceDir, urlContentFetcher)

		expect(result.text).toContain("secret sauce recipe")
		expect(result.text).toContain("(see below for file content)")
	})

	it("still resolves workspace-relative mentions", async () => {
		await fs.writeFile(path.join(workspaceDir, "inside.txt"), "inside the workspace", "utf8")

		const result = await parseMentions("Look at @/inside.txt", workspaceDir, urlContentFetcher)

		expect(result.text).toContain("inside the workspace")
	})

	it("reports an error for a path that exists nowhere", async () => {
		const result = await parseMentions("Check @/definitely/not/here.txt", workspaceDir, urlContentFetcher)

		expect(result.text).toContain("Error fetching content")
	})
})
