# IVOL Browser Connector (development preview)

Connect personal Chrome to a local IVOL IDE host without a remote debugging port, profile copying or a companion application. The browser extension is only a connector: no popup, pairing codes or browser-side approval buttons.

## Compatibility

Connector **0.7.0 uses protocol 2** and matches IVOL core 5.17.10 and the planned 5.17.11 release. Update both together; reload an existing unpacked extension in Chrome after updating its files. Core 5.17.9 and connector 0.6.1 use the previous protocol. A protocol mismatch is rejected; discovery may currently end with a generic timeout rather than an update-specific IDE message.

Earlier Chrome navigation, typing and scrolling were checked live. The latest attempt on installed core 5.17.10 timed out during connector discovery before browser authorization. The registered extension directory contained 0.7.0, but the running worker's version and enabled state were not established. This connection issue remains unresolved. Host-scoped consent, thematic groups and pause/resume have automated coverage but still require complete live acceptance.

## Setup and consent

1. In Chrome's extensions page, enable Developer mode and choose **Load unpacked**, selecting this directory.
2. Select **My Chrome — IVOL extension (preview)** in IVOL Browser settings and save. This also enables the browser tool.
3. Ask the agent to use Chrome. The connector discovers the waiting IDE automatically. IVOL presents an explicit modal permission dialog before browser authorization; the browser does not ask a second time.

Consent is kept only in the current IDE host's memory. It continues across chats until disconnect, transport loss or host restart. Ending a chat cancels its stale work and clears observations without closing browser tabs or withdrawing an established host grant. A declined request is not automatically retried. Explicit settings resume can supersede a prior refusal; resetting refusal on a new user message is still pending.

Discovery listens on an available loopback port in 19440–19449 for up to 45 seconds. A suspended Chrome worker may take up to 30 seconds to discover it. Cancellation closes the temporary listener. A disconnected session needs fresh consent; failed clicks and uncertain tab creations are never replayed automatically.

## Tabs and groups

Requested URLs open in background tabs without switching the user's foreground tab. The connector never changes window size, page viewport, zoom or layout. Background freshness is best-effort, not guaranteed.

New tabs use a short English topic such as **Research** or **Invoices**, supplied through the browser action's text argument; the default is **Browser**. Topics contain 1–24 English letters. There is no task hash or agent prefix in group titles.

The worker remembers only native group IDs it created during its current lifetime. It does not adopt a personal group merely because the name matches. Deleted or renamed groups are not reused. After worker restart, old tabs/groups remain but are not automatically adopted or granted. Group membership is organization, never permission. Restart, movement between windows and concurrent IDE/profile behavior still need live acceptance.

Up to 20 tabs are granted per connection, with one debugger attached at a time. Only granted tab IDs are returned. Use snapshot to observe them and select_tab to switch; switching does not reload or close a tab. A request without a URL may attach to the current tab through the internal adapter. The public launch action requires a URL.

## Manual control

Browser settings expose **Pause**, **Resume**, **Disconnect** and status refresh. Pause blocks new commands and invalidates queued work. Resume requires an explicit IDE modal decision, then a fresh screenshot before interaction. A browser invocation while paused can request the same decision. It never blindly replays an old click after manual control.

When Chrome reports a file chooser on the controlled tab, the connector pauses and discards console summaries. Finish file selection manually before returning control. It does not intercept the native dialog or supply file paths. Detection depends on an experimental CDP event; pause manually before sensitive input if unavailable.

Disconnect detaches the debugger without closing Chrome or its tabs. Another IDE may discover the connector only after release/disconnect; active connections are not stolen. Revocation cannot undo an already executed action.

## Capabilities and limitations

- Screenshots, clicks, hover, text input, scrolling and common keyboard combinations. These are page events, not guaranteed system or browser-toolbar shortcuts.
- Scrolling directly moves the document; wheel-driven applications and nested scrolling require further work.
- Bounded accessibility summaries include roles/names, not field values. Screenshots, names and console output can still contain sensitive information.
- Bounded console/error summaries from the controlled tab; events during pause are discarded.
- New HTTP(S) tabs and selection of granted tabs. OAuth popups and iframe flows remain unverified.
- Saved screenshots currently require PNG. Window resizing is manual.
- Application launch uses a trusted local application picker and a separate launch confirmation. It does not grant page control or change profile flags. Automatic launch offering on Chrome connection failure remains pending.
- Automated upload/download, protected Chrome pages, debugger conflicts, all supported IDE dialogs, Windows/Linux discovery and complete localization remain outstanding.
- Only local IDE hosts are supported; SSH/container forwarding needs a separate design.

## Data boundaries

Discovery requires an extension-origin POST, connector header and expected Host. It provides a short-lived one-use WebSocket token that is not exposed to the model. This prevents ordinary webpage access, not impersonation by a malicious local process. No persistent trust credential is stored.

Chrome installation permissions are broad. The connector enforces a narrower in-memory tab allowlist and exposes no arbitrary CDP execution. Granted tabs retain the profile's existing logins. Page content, screenshots and logs may reach the selected AI provider and task history; there is no guaranteed secret redaction. Prefer a dedicated profile for sensitive work.

## BrowserOS neo

BrowserOS uses its own local MCP server and separate profile, not this Chrome extension. See [BrowserOS integration](../docs/ivol-browseros-neo.md) for automatic setup, first-invocation consent and current restrictions. Its consent covers the exposed profile rather than this connector's tab allowlist. Thematic BrowserOS groups remain unimplemented. Never copy Chrome credentials or silently fall back between browser modes.
