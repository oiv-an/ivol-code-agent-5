import * as vscode from "vscode"
import { spawn } from "node:child_process"
import { stat } from "node:fs/promises"
import path from "node:path"
import { t } from "../../../i18n"

let launching = false

/** User-picked application only: never accept a model-provided command or browser flags. */
export async function launchPersonalBrowser(
	browser: "chrome-extension" | "browseros",
	isCurrent: () => boolean = () => true,
): Promise<boolean> {
	if (launching) throw new Error("A browser launch confirmation is already pending")
	launching = true
	try {
		return await selectAndLaunch(browser, isCurrent)
	} finally {
		launching = false
	}
}

async function selectAndLaunch(browser: "chrome-extension" | "browseros", isCurrent: () => boolean): Promise<boolean> {
	if (!isCurrent()) throw new Error("Browser launch request expired")
	if (
		vscode.env.remoteName ||
		vscode.env.uiKind !== vscode.UIKind.Desktop ||
		process.env.AGENT_CONFIG ||
		process.env.SSH_CONNECTION ||
		process.env.CODE_SERVER === "true"
	)
		throw new Error("Browser application launch requires a local desktop IDE host")
	const name = browser === "chrome-extension" ? "Google Chrome" : "BrowserOS neo"
	const selected = await vscode.window.showOpenDialog({
		canSelectMany: false,
		canSelectFiles: true,
		canSelectFolders: process.platform === "darwin",
		title: t("mcp:browserLaunch.select", { name }),
		openLabel: t("mcp:browserLaunch.selectButton"),
		...(process.platform === "win32" ? { filters: { Application: ["exe"] } } : {}),
	})
	if (!selected?.[0]) return false
	if (selected[0].scheme !== "file") throw new Error("Select a local browser application")
	const application = selected[0].fsPath
	const platformPath = process.platform === "win32" ? path.win32 : path.posix
	if (!platformPath.isAbsolute(application) || application.includes("\0")) throw new Error("Invalid application path")
	const info = await stat(application)
	if (process.platform === "darwin") {
		if (!application.endsWith(".app") || !info.isDirectory()) throw new Error("Select the browser's .app bundle")
	} else {
		if (!info.isFile()) throw new Error("Select the browser executable")
		if (process.platform === "win32" && !application.toLowerCase().endsWith(".exe"))
			throw new Error("Select the browser's .exe file")
	}
	const allow = t("mcp:browserLaunch.allow")
	const answer = await vscode.window.showWarningMessage(
		t("mcp:browserLaunch.confirm", { name, application }),
		{ modal: true },
		allow,
	)
	if (answer !== allow) return false
	if (!isCurrent()) throw new Error("Browser launch request expired")
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			process.platform === "darwin" ? "/usr/bin/open" : application,
			process.platform === "darwin" ? ["-a", application] : [],
			{ shell: false, detached: true, stdio: "ignore" },
		)
		child.once("error", reject)
		if (process.platform === "darwin") {
			child.once("exit", (code) =>
				code === 0 ? resolve() : reject(new Error("The system could not launch the selected browser")),
			)
		} else {
			child.once("spawn", () => {
				child.unref()
				resolve()
			})
		}
	})
	return true
}
