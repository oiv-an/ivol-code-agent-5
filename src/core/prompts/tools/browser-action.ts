import { ToolArgs } from "./types"

export function getBrowserActionDescription(args: ToolArgs): string | undefined {
	if (!args.supportsComputerUse) {
		return undefined
	}
	// kilocode_change: describe personal-browser consent and fresh observations too.
	return `## browser_action
Description: Request to interact with the configured browser. Page actions return a screenshot and new console logs; \`close\` and \`open_application\` return text only. Perform one browser action per message and wait for its result before deciding the next action.

This tool is particularly useful for web development tasks as it allows you to launch a browser, navigate to pages, interact with elements through clicks and keyboard input, and capture the results through screenshots and console logs. Use it at key stages of web development tasks - such as after implementing new features, making substantial changes, when troubleshooting issues, or to verify the result of your work. Analyze the provided screenshots to ensure correct rendering or identify errors, and review console logs for runtime issues. It is NOT a research tool: do not use it to look up facts you could search for.

The user may ask generic non-development tasks (such as "what's the latest news" or "look up the weather"). Do NOT open a browser for those. Read-only information from the public web must come from a web search tool first: use the provider's web_search tool when it is available, or an MCP search tool otherwise. A connected browser is not a reason to skip search - it is slower, costs screenshots, and exposes the user's session. Open the browser only when search genuinely cannot answer the request: pages behind the user's login, interactive steps such as filling or submitting a form, checking a site you are building or debugging, or when the user explicitly asks you to use the browser.

**Browser Session Lifecycle:**
- Browser sessions **start** with \`launch\` and **end** with \`close\`
- The session remains active across multiple messages and tool uses
- You can use other tools while the browser session is active - it will stay open in the background
- Personal-browser consent lasts for this IDE host and connection until disconnect or restart, not for a chat identifier. Never bypass refusal or manual pause. The Chrome connector has no permission popup.
- In BrowserOS mode, use launch with a URL to prepare the connection and request explicit consent automatically in the calling IDE window. After confirmation the original URL is opened once; use advertised MCP tools afterward. Do not require the user to visit settings before calling.
- For personal Chrome launch/create_tab, provide text as one short English topic word, such as Research or Invoices. Only connector-created groups are reused; matching personal group titles never imply ownership.
- After the user returns control, use \`snapshot\` before clicking or typing. Closing a personal session releases access without closing tabs.
- Personal Chrome resizing is manual; file screenshots require PNG. Unsupported operations return an error.

Parameters:
- action: (required) The action to perform. The available actions are:
    * open_application: Request opening the installed application. No other parameters. The user selects a trusted application and confirms a separate modal; cancellation must be respected. Returns text, not a screenshot, and grants no browser access. BrowserOS launch can prepare the connection and request consent directly when needed.
    * launch: Start a session in the configured browser at the specified URL. In personal Chrome, the user can instead preserve the selected tab's current page. This must precede page interaction; open_application may precede it.
        - Use with the \`url\` parameter to provide the URL.
        - Ensure the URL is valid and includes the appropriate protocol (e.g. http://localhost:3000/page, file:///path/to/file.html, etc.)
    * hover: Move the cursor to a specific x,y coordinate.
        - Use with the \`coordinate\` parameter to specify the location.
        - Always move to the center of an element (icon, button, link, etc.) based on coordinates derived from a screenshot.
    * click: Click at a specific x,y coordinate.
        - Use with the \`coordinate\` parameter to specify the location.
        - Always click in the center of an element (icon, button, link, etc.) based on coordinates derived from a screenshot.
    * type: Type a string of text on the keyboard. You might use this after clicking on a text field to input text.
        - Use with the \`text\` parameter to provide the string to type.
    * press: Press a single keyboard key or key combination (e.g., Enter, Tab, Escape, Cmd+K, Shift+Enter).
        - Use with the \`text\` parameter to provide the key name or combination.
        - For single keys: Enter, Tab, Escape, etc.
        - For key combinations: Cmd+K, Ctrl+C, Shift+Enter, Alt+F4, etc.
        - Supported modifiers: Cmd/Command/Meta, Ctrl/Control, Shift, Alt/Option
        - Example: <text>Cmd+K</text> or <text>Shift+Enter</text>
    * resize: Resize the viewport to a specific w,h size.
        - Use with the \`size\` parameter to specify the new size.
    * scroll_down: Scroll down the page by one page height.
    * scroll_up: Scroll up the page by one page height.
    * snapshot: Get a fresh screenshot and new console messages without saving a file. Personal Chrome also returns a bounded accessibility summary and user-granted tab IDs. No path is required. Use after manual control returns.
    * select_tab: In personal Chrome, select an authorized tab using its ID in the text parameter. Returns a fresh observation. Never assume access to unrelated tabs or OAuth windows.
    * create_tab: Personal Chrome only. Open a background tab at url within the approved connection. Optionally pass one English topic word in text. The current tab is preserved; the result lists the new tab ID. Use select_tab afterward to control it.
    * screenshot: Take a screenshot and save it to a file.
        - Use with the \`path\` parameter to specify the destination file path.
        - Supported formats: .png, .jpeg, .webp
        - Example: \`<action>screenshot</action>\` with \`<path>screenshots/result.png</path>\`
    * close: End the browser session; personal browser tabs remain open. This **must always be the final browser action**.
        - Example: \`<action>close</action>\`
- url: (optional) Required for \`launch\` and \`create_tab\`. Personal Chrome supports HTTP(S) URLs only.
    * Example: <url>https://example.com</url>
- coordinate: (optional) The X and Y coordinates for the \`click\` and \`hover\` actions.
    * **CRITICAL**: Screenshot dimensions are NOT the same as the browser viewport dimensions
    * Format: <coordinate>x,y@widthxheight</coordinate>
    * Measure x,y on the screenshot image you see in chat
    * The widthxheight MUST be the EXACT pixel size of that screenshot image (never the browser viewport)
    * Never use the browser viewport size for widthxheight - the viewport is only a reference and is often larger than the screenshot
    * Images are often downscaled before you see them, so the screenshot's dimensions will likely be smaller than the viewport
    * Example A: If the screenshot you see is 1094x1092 and you want to click (450,300) on that image, use: <coordinate>450,300@1094x1092</coordinate>
    * Example B: If the browser viewport is 1280x800 but the screenshot is 1000x625 and you want to click (500,300) on the screenshot, use: <coordinate>500,300@1000x625</coordinate>
- size: (optional) The width and height for the \`resize\` action.
    * Example: <size>1280,720</size>
- text: (optional) Use this for providing the text for the \`type\` action.
    * Example: <text>Hello, world!</text>
- path: (optional) File path for the \`screenshot\` action. Path is relative to the workspace.
    * Supported formats: .png, .jpeg, .webp
    * Example: <path>screenshots/my-screenshot.png</path>
Usage:
<browser_action>
<action>Action to perform (e.g., launch, click, type, press, scroll_down, scroll_up, close)</action>
<url>URL to launch the browser at (optional)</url>
<coordinate>x,y@widthxheight coordinates (optional)</coordinate>
<text>Text to type (optional)</text>
</browser_action>

Example: Requesting to launch a browser at https://example.com
<browser_action>
<action>launch</action>
<url>https://example.com</url>
</browser_action>

Example: Requesting to click on the element at coordinates 450,300 on a 1024x768 image
<browser_action>
<action>click</action>
<coordinate>450,300@1024x768</coordinate>
</browser_action>

Example: Taking a screenshot and saving it to a file
<browser_action>
<action>screenshot</action>
<path>screenshots/result.png</path>
</browser_action>`
}
