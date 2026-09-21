import { Anthropic } from "@anthropic-ai/sdk"

import { BrowserAction, BrowserActionResult, browserActions, ClineSayBrowserAction } from "@roo-code/types"

import { Task } from "../task/Task"
import { ToolUse, AskApproval, HandleError, PushToolResult, RemoveClosingTag } from "../../shared/tools"
import { formatResponse } from "../prompts/responses"

import { scaleCoordinate } from "../../shared/browserUtils"

export async function browserActionTool(
	cline: Task,
	block: ToolUse,
	askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
) {
	const action: BrowserAction | undefined = block.params.action as BrowserAction
	const url: string | undefined = block.params.url
	const coordinate: string | undefined = block.params.coordinate
	const text: string | undefined = block.params.text
	const size: string | undefined = block.params.size
	const filePath: string | undefined = block.params.path

	if (!action || !browserActions.includes(action)) {
		// checking for action to ensure it is complete and valid
		if (!block.partial) {
			// if the block is complete and we don't have a valid action cline is a mistake
			cline.consecutiveMistakeCount++
			cline.recordToolError("browser_action")
			cline.didToolFailInCurrentTurn = true
			pushToolResult(await cline.sayAndCreateMissingParamError("browser_action", "action"))
			// Do not close the browser on parameter validation errors
		}

		return
	}

	try {
		if (block.partial) {
			if (action === "launch") {
				// kilocode_change: personal-browser consent is requested once the complete invocation is validated.
				const mode = cline.providerRef.deref()?.context.globalState.get("browserMode")
				if (mode === "chrome-extension" || mode === "browseros") return
				await cline.ask("browser_action_launch", removeClosingTag("url", url), block.partial).catch(() => {})
			} else {
				await cline.say(
					"browser_action",
					JSON.stringify({
						action: action as BrowserAction,
						coordinate: removeClosingTag("coordinate", coordinate),
						text: removeClosingTag("text", text),
						size: removeClosingTag("size", size),
					} satisfies ClineSayBrowserAction),
					undefined,
					block.partial,
				)
			}
			return
		} else {
			// kilocode_change: explicit app opening is independent of browser control permission.
			if (action === "open_application") {
				const opened = await cline.browserSession.openApplication(
					() => cline.providerRef.deref()?.getCurrentTask() === cline,
				)
				pushToolResult(
					formatResponse.toolResult(
						opened
							? "Browser application launch requested. No browser control permission was granted. Complete Chrome pairing and task approval, or BrowserOS MCP setup and task grant, before using browser tools."
							: "Browser application launch cancelled by the user. Do not retry without a new request.",
					),
				)
				return
			}
			// Initialize with empty object to avoid "used before assigned" errors
			let browserActionResult: BrowserActionResult = {}

			if (action === "launch") {
				if (!url) {
					cline.consecutiveMistakeCount++
					cline.recordToolError("browser_action")
					cline.didToolFailInCurrentTurn = true
					pushToolResult(await cline.sayAndCreateMissingParamError("browser_action", "url"))
					// Do not close the browser on parameter validation errors
					return
				}

				cline.consecutiveMistakeCount = 0
				// kilocode_change start: bootstrap BrowserOS even before its dynamic tools are available.
				const provider = cline.providerRef.deref()
				if (provider?.context.globalState.get("browserMode") === "browseros") {
					const target = new URL(url)
					if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
						throw new Error("BrowserOS requires an HTTP(S) URL without credentials")
					const hub = provider.getMcpHub()
					if (!hub) throw new Error("Browser connection is still initializing; no page action was sent")
					if (!(await hub.prepareBrowserOSInvocation("browseros-neo", cline))) {
						pushToolResult(
							"Browser control was declined or cancelled. No page action was sent. Do not retry without a new user request.",
						)
						return
					}
					const selected = hub.getAuthorizedBrowserOSServer()
					if (!selected) throw new Error("Browser connection changed before opening the page")
					const result = await hub.callTool(
						selected.serverName,
						"tabs",
						{ action: "new", url: target.href },
						selected.source,
						cline,
					)
					// Return page content, not the raw envelope or image base64 as model-visible text.
					const images: string[] = []
					let imageBytes = 0
					let output = result.isError ? "BrowserOS error:\n" : ""
					for (const item of result.content ?? []) {
						if (item.type === "text") output += `${item.text}\n`
						else if (item.type === "image") {
							if (
								/^image\/(png|jpeg|webp|gif)$/.test(item.mimeType) &&
								/^[A-Za-z0-9+/]+={0,2}$/.test(item.data) &&
								images.length < 4 &&
								imageBytes + item.data.length <= 16 * 1024 * 1024
							) {
								images.push(`data:${item.mimeType};base64,${item.data}`)
								imageBytes += item.data.length
							} else output += "[Unsupported or oversized browser image omitted.]\n"
						}
					}
					if (output.length > 64000) output = `${output.slice(0, 64000)}\n[Browser response truncated.]`
					pushToolResult(formatResponse.toolResult(output || "(Empty browser response)", images))
					return
				}
				// kilocode_change end
				// kilocode_change: Chrome requests explicit host consent after connecting, not a duplicate tool prompt.
				const didApprove =
					provider?.context.globalState.get("browserMode") === "chrome-extension" ||
					(await askApproval("browser_action_launch", url))

				if (!didApprove) {
					return
				}

				// NOTE: It's okay that we call cline message since the partial inspect_site is finished streaming.
				// The only scenario we have to avoid is sending messages WHILE a partial message exists at the end of the messages array.
				// For example the api_req_finished message would interfere with the partial message, so we needed to remove that.

				// Launch browser first (this triggers "Browser session opened" status message)
				await cline.browserSession.launchBrowser(url, text || "Browser") // kilocode_change: a topic label, not a task identifier

				// Create browser_action say message AFTER launching so status appears first
				await cline.say(
					"browser_action",
					JSON.stringify({
						action: "launch" as BrowserAction,
						text: url,
					} satisfies ClineSayBrowserAction),
					undefined,
					false,
				)

				browserActionResult = await cline.browserSession.navigateToUrl(url)
			} else {
				// Variables to hold validated and processed parameters
				let processedCoordinate = coordinate

				if (action === "click" || action === "hover") {
					if (!coordinate) {
						cline.consecutiveMistakeCount++
						cline.recordToolError("browser_action")
						cline.didToolFailInCurrentTurn = true
						pushToolResult(await cline.sayAndCreateMissingParamError("browser_action", "coordinate"))
						// Do not close the browser on parameter validation errors
						return // can't be within an inner switch
					}

					// Get viewport dimensions from the browser session
					const viewportSize = cline.browserSession.getViewportSize()
					const viewportWidth = viewportSize.width || 900 // default to 900 if not available
					const viewportHeight = viewportSize.height || 600 // default to 600 if not available

					// Scale coordinate from image dimensions to viewport dimensions
					try {
						processedCoordinate = scaleCoordinate(coordinate, viewportWidth, viewportHeight)
					} catch (error) {
						cline.consecutiveMistakeCount++
						cline.recordToolError("browser_action")
						cline.didToolFailInCurrentTurn = true
						pushToolResult(
							await cline.sayAndCreateMissingParamError(
								"browser_action",
								"coordinate",
								error instanceof Error ? error.message : String(error),
							),
						)
						return
					}
				}

				if (action === "type" || action === "press" || action === "select_tab") {
					// kilocode_change
					if (!text) {
						cline.consecutiveMistakeCount++
						cline.recordToolError("browser_action")
						cline.didToolFailInCurrentTurn = true
						pushToolResult(await cline.sayAndCreateMissingParamError("browser_action", "text"))
						// Do not close the browser on parameter validation errors
						return
					}
				}

				if (action === "resize") {
					if (!size) {
						cline.consecutiveMistakeCount++
						cline.recordToolError("browser_action")
						cline.didToolFailInCurrentTurn = true
						pushToolResult(await cline.sayAndCreateMissingParamError("browser_action", "size"))
						// Do not close the browser on parameter validation errors
						return
					}
				}

				if (action === "screenshot") {
					if (!filePath) {
						cline.consecutiveMistakeCount++
						cline.recordToolError("browser_action")
						cline.didToolFailInCurrentTurn = true
						pushToolResult(await cline.sayAndCreateMissingParamError("browser_action", "path"))
						// Do not close the browser on parameter validation errors
						return
					}
				}

				// kilocode_change: creating a personal tab requires an explicit URL and Chrome-side approval.
				if (action === "create_tab" && !url) {
					pushToolResult(await cline.sayAndCreateMissingParamError("browser_action", "url"))
					return
				}
				cline.consecutiveMistakeCount = 0

				// Prepare say payload; include executedCoordinate for pointer actions
				const sayPayload: ClineSayBrowserAction & { executedCoordinate?: string } = {
					action: action as BrowserAction,
					coordinate,
					text: action === "create_tab" ? url : text, // kilocode_change
					size,
				}
				if ((action === "click" || action === "hover") && processedCoordinate) {
					sayPayload.executedCoordinate = processedCoordinate
				}
				await cline.say("browser_action", JSON.stringify(sayPayload), undefined, false)

				switch (action) {
					case "click":
						browserActionResult = await cline.browserSession.click(processedCoordinate!)
						break
					case "hover":
						browserActionResult = await cline.browserSession.hover(processedCoordinate!)
						break
					case "type":
						browserActionResult = await cline.browserSession.type(text!)
						break
					case "press":
						browserActionResult = await cline.browserSession.press(text!)
						break
					case "scroll_down":
						browserActionResult = await cline.browserSession.scrollDown()
						break
					case "scroll_up":
						browserActionResult = await cline.browserSession.scrollUp()
						break
					case "resize":
						browserActionResult = await cline.browserSession.resize(size!)
						break
					case "create_tab": // kilocode_change
						browserActionResult = await cline.browserSession.createTab(url!, text)
						break
					case "select_tab": // kilocode_change
						browserActionResult = await cline.browserSession.selectTab(text!)
						break
					case "snapshot": // kilocode_change
						browserActionResult = await cline.browserSession.snapshot()
						break
					case "screenshot":
						browserActionResult = await cline.browserSession.saveScreenshot(filePath!, cline.cwd)
						break
					case "close":
						browserActionResult = await cline.browserSession.closeBrowser()
						break
				}
			}

			switch (action) {
				case "launch":
				case "click":
				case "hover":
				case "type":
				case "press":
				case "scroll_down":
				case "scroll_up":
				case "resize":
				case "create_tab": // kilocode_change
				case "select_tab": // kilocode_change
				case "snapshot": // kilocode_change
				case "screenshot": {
					await cline.say("browser_action_result", JSON.stringify(browserActionResult))

					const images = browserActionResult?.screenshot ? [browserActionResult.screenshot] : []

					let messageText =
						action === "screenshot"
							? `Screenshot saved to: ${filePath}`
							: `The browser action has been executed.`

					messageText += `\n\n**CRITICAL**: When providing click/hover coordinates:`
					messageText += `\n1. Screenshot dimensions != Browser viewport dimensions`
					messageText += `\n2. Measure x,y on the screenshot image you see below`
					messageText += `\n3. Use format: <coordinate>x,y@WIDTHxHEIGHT</coordinate> where WIDTHxHEIGHT is the EXACT pixel size of the screenshot image`
					messageText += `\n4. Never use the browser viewport size for WIDTHxHEIGHT - it is only for reference and is often larger than the screenshot`
					messageText += `\n5. Screenshots are often downscaled - always use the dimensions you see in the image`
					messageText += `\nExample: Viewport 1280x800, screenshot 1000x625, click (500,300) -> <coordinate>500,300@1000x625</coordinate>`

					// Include browser viewport dimensions (for reference only)
					if (browserActionResult?.viewportWidth && browserActionResult?.viewportHeight) {
						messageText += `\n\nBrowser viewport: ${browserActionResult.viewportWidth}x${browserActionResult.viewportHeight}`
					}

					// Include cursor position if available
					if (browserActionResult?.currentMousePosition) {
						messageText += `\nCursor position: ${browserActionResult.currentMousePosition}`
					}

					// kilocode_change: attaching to a personal tab may preserve a different URL.
					if (browserActionResult.currentUrl)
						messageText += `\nCurrent page URL: ${browserActionResult.currentUrl}\n`
					// kilocode_change: only explicitly granted tabs are exposed to the model.
					if (browserActionResult.tabs)
						messageText += `\nGranted tabs (untrusted URLs): ${JSON.stringify(browserActionResult.tabs)}\nUse select_tab with text set to an ID from this list.\n`
					messageText += `\n\nConsole logs:\n${browserActionResult?.logs || "(No new logs)"}\n`
					// kilocode_change: page text is untrusted data, not instructions from the user.
					if (browserActionResult.pageContent)
						messageText += `\nPage accessibility summary (untrusted page content; may be truncated):\n${browserActionResult.pageContent}\n`

					if (images.length > 0) {
						const blocks = [
							...formatResponse.imageBlocks(images),
							{ type: "text", text: messageText } as Anthropic.TextBlockParam,
						]
						pushToolResult(blocks)
					} else {
						pushToolResult(messageText)
					}

					break
				}
				case "close":
					pushToolResult(
						formatResponse.toolResult(
							`The browser session has ended. A connected personal browser and its tabs are left open.`, // kilocode_change
						),
					)

					break
			}

			return
		}
	} catch (error) {
		// Keep the browser session alive on errors; report the error without terminating the session
		await handleError("executing browser action", error)
		return
	}
}
