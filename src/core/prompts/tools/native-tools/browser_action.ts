import type OpenAI from "openai"

// kilocode_change: browser transport is selected by the user, not the model.
const BROWSER_ACTION_DESCRIPTION = `Request to interact with the configured browser. Page actions return a screenshot of the browser's current state and new console logs; close and open_application return text only. You may only perform one browser action per message, and wait for its result before deciding the next action.

This tool is particularly useful for web development tasks as it allows you to launch a browser, navigate to pages, interact with elements through clicks and keyboard input, and capture the results through screenshots and console logs. Use it at key stages of web development tasks - such as after implementing new features, making substantial changes, when troubleshooting issues, or to verify the result of your work. Analyze the provided screenshots to ensure correct rendering or identify errors, and review console logs for runtime issues.

The user may ask generic non-development tasks (such as "what's the latest news" or "look up the weather"), in which case you might use this tool to complete the task if it makes sense to do so, rather than trying to create a website or using curl to answer the question. However, if an available MCP server tool or resource can be used instead, you should prefer to use it over browser_action.

Browser Session Lifecycle:
- Browser sessions start with launch and end with close
- open_application can request opening an installed browser with a trusted application picker and explicit launch confirmation. It does not grant control; never repeat after refusal. In BrowserOS mode, launch with a URL prepares the connection and requests control in this IDE window automatically, then opens the original URL once. Do not send the user to settings to grant access in advance. After launch, use the advertised BrowserOS MCP tools and take a fresh snapshot before interacting.
- The session remains active across multiple messages and tool uses
- You can use other tools while the browser session is active - it will stay open in the background
- Personal browser consent is temporary for this IDE host and connection, not tied to a chat identifier. Never bypass refusal or manual pause. Disconnecting or restarting the host ends consent.
- For personal Chrome launch/create_tab, supply text as one short English word describing the topic, for example Research or Invoices. Newly created tabs are grouped by that topic without task hashes. A matching personal group name does not grant ownership.
- After the user returns control, use snapshot to get a fresh screenshot without saving a file before clicking or typing. It also returns a bounded accessibility summary in personal Chrome.
- Personal Chrome results list only authorized tabs. Use select_tab with text set to a listed tab ID. Use create_tab with url to open an additional background tab within the approved connection; it preserves the current tab and returns the available IDs. Select the new ID explicitly afterward. The Chrome connector has no permission popup. Never assume access to unrelated tabs or OAuth windows.
- Closing a personal browser session releases access but leaves the browser and its tabs open.
- Personal Chrome supports manual resizing and PNG file screenshots; unsupported operations return an error.` // kilocode_change

const ACTION_PARAMETER_DESCRIPTION = `Browser action to perform`

const URL_PARAMETER_DESCRIPTION = `URL for launch or create_tab; must include protocol. Personal Chrome accepts HTTP(S) only.` // kilocode_change

const COORDINATE_PARAMETER_DESCRIPTION = `Screen coordinate for hover or click actions in format 'x,y@WIDTHxHEIGHT' where x,y is the target position on the screenshot image and WIDTHxHEIGHT is the exact pixel dimensions of the screenshot image (not the browser viewport). Example: '450,203@900x600' means click at (450,203) on a 900x600 screenshot. The coordinates will be automatically scaled to match the actual viewport dimensions.`

const SIZE_PARAMETER_DESCRIPTION = `Viewport dimensions for the resize action in format 'WIDTHxHEIGHT' or 'WIDTH,HEIGHT'. Example: '1280x800' or '1280,800'`

const TEXT_PARAMETER_DESCRIPTION = `Text to type, key name for press (e.g., 'Enter', 'Tab', 'Escape'), an authorized tab ID for select_tab, or one short English topic word for personal Chrome launch/create_tab (e.g., Research)` // kilocode_change

const PATH_PARAMETER_DESCRIPTION = `File path where the screenshot should be saved (relative to workspace). Required for screenshot action. Supports .png, .jpeg, and .webp extensions. Example: 'screenshots/result.png'`

export default {
	type: "function",
	function: {
		name: "browser_action",
		description: BROWSER_ACTION_DESCRIPTION,
		strict: false,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					description: ACTION_PARAMETER_DESCRIPTION,
					enum: [
						"launch",
						"click",
						"hover",
						"type",
						"press",
						"scroll_down",
						"scroll_up",
						"resize",
						"close",
						"screenshot",
						"snapshot", // kilocode_change
						"select_tab", // kilocode_change
						"create_tab", // kilocode_change
						"open_application", // kilocode_change
					],
				},
				url: {
					type: ["string", "null"],
					description: URL_PARAMETER_DESCRIPTION,
				},
				coordinate: {
					type: ["string", "null"],
					description: COORDINATE_PARAMETER_DESCRIPTION,
				},
				size: {
					type: ["string", "null"],
					description: SIZE_PARAMETER_DESCRIPTION,
				},
				text: {
					type: ["string", "null"],
					description: TEXT_PARAMETER_DESCRIPTION,
				},
				path: {
					type: ["string", "null"],
					description: PATH_PARAMETER_DESCRIPTION,
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
