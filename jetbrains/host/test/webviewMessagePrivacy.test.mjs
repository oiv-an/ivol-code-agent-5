import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { URL } from "node:url"

test("the prepared host dispatches webview messages without logging their private payload", async () => {
	const source = await readFile(
		new URL("../deps/vscode/vs/workbench/api/common/extHostWebview.ts", import.meta.url),
		"utf8",
	)
	const handler = source.split("public $onMessage(")[1]?.split("public $onMissingCsp(")[0]
	assert.ok(handler, "The real extension-host webview message handler must be present")
	assert.match(handler, /webview\._onMessageEmitter\.fire\(message\)/)
	assert.doesNotMatch(handler, /console\.(?:log|debug|info|warn|error)\s*\(/)
})

test("the tracked dependency patch cannot restore webview payload logging on rebuild", async () => {
	const patch = await readFile(new URL("../../../deps/patches/vscode/jetbrains.patch", import.meta.url), "utf8")
	const webviewPatch = patch
		.split("diff --git a/src/vs/workbench/api/common/extHostWebview.ts ")[1]
		?.split("\ndiff --git ")[0]
	assert.ok(webviewPatch, "The reproducible dependency patch must cover the webview handler")
	assert.match(webviewPatch, /private standalone searches/)
	assert.doesNotMatch(webviewPatch, /^\+.*console\.(?:log|debug|info|warn|error)\s*\(/m)
})
