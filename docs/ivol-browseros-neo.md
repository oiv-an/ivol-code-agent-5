# BrowserOS neo integration preview

## Verified compatibility

On September 20, 2026, a local BrowserOS neo application version 0.50.5 exposed an MCP server identifying itself as `browseros-neo` version 0.0.54. These are separate version numbers.

A standalone MCP SDK client successfully initialized a Streamable HTTP connection and listed 20 tool schemas. No browser tools, page reads, history reads, screenshots or interactions were invoked during that check. This verifies transport and tool discovery, not end-to-end operation through the installed IVOL extension.

Local core 5.17.10 was installed and loaded on September 21, 2026. Its native browser launch, explicit MCP snapshot, click and follow-up snapshot successfully navigated from example.com to IANA. A later research-session request failed with expired permission, so complete consent-lifecycle acceptance remains outstanding. The earlier consent failures motivated the host-scoped design below; passing mock tests does not establish that all live failures are resolved. Core 5.17.11 is being prepared with the same browser preview and an additional WebStorm target. Chrome connector 0.7.0 (protocol 2) is a separate artifact; its latest discovery timeout remains unresolved.

## Connection and permission

1. Select and save BrowserOS mode once. The first browser invocation prepares the connection and shows an explicit IDE consent dialog; advance permission in settings is not required. After approval, the original unsent operation runs once. Permission lasts in this IDE host across chats until disconnect, connection loss or host restart; it is not persisted. **Connect and allow control** remains an optional settings path.
2. If the browser is already reachable, it is not launched again. If its profile is missing or the local connection is refused, IVOL offers the existing trusted application picker and launch confirmation, then retries transport readiness for a bounded period. Cancelling stops the sequence. Invalid configuration, disabled servers and identity errors are not reasons to launch an application. No page actions are replayed. Selecting an advanced named connection preserves that selection rather than silently replacing it.
3. Explicitly disabled connections remain disabled. MCP must be enabled. Conflicting project server names are reported rather than overwritten. Other server entries and unrelated top-level settings are preserved; an intervening settings change causes setup to stop rather than overwrite it. Concurrent writers that ignore the file lock cannot be fully controlled.
4. The UI shows connection, launch and permission stages. Pause, resume and revoke remain separate. Advanced connection details are collapsed. Revoke or task replacement invalidates the pending sequence. Saving settings separately still only prepares the transport; it does not grant control.
5. Use only the tools and argument schemas advertised by the connected server. In BrowserOS mode, `browser_action` launch can bootstrap the connection and create the first page before dynamic MCP tools are available; subsequent page control uses MCP. Other browser modes are never silently switched to BrowserOS.

The verified macOS profile publishes `ports.proxy` in `Library/Application Support/BrowserClaw/.browseros/config.json`. The port is not hardcoded. Windows and Linux profile candidates are best-effort and have not been verified against installed browsers. Automatic setup is restricted to local IDE hosts, not SSH, code-server or spawned agents. Advanced configuration remains available for nonstandard installations.

Protected endpoints use HTTP on literal `127.0.0.1` or `[::1]`, without embedded credentials, query parameters or fragments. The identity probe forbids redirects, bounds response size and duration, accepts JSON and SSE responses, and attempts to terminate its own temporary MCP transport session when one is created. Server self-identification is a compatibility check, not cryptographic proof of ownership. Discovery never invokes page tools or copies profile credentials.

Permission covers the profile exposed by the MCP server, not a Chrome-style selected-tab allowlist. Page results may reach the AI provider and task history. Do not import Chrome credentials as part of setup.

### Host-scoped approval of subsequent actions (preview)

The first-invocation dialog explicitly covers subsequent page views, clicks, typing, navigation and tab operations without repeated prompts. The settings checkbox controls the optional settings grant path and remains a saved preference, not a saved permission. Changing it revokes the previous grant. Neither saving settings nor restarting the IDE restores consent.

This in-memory permission skips the ordinary per-call MCP prompt, not the execution guard, observation requirements or disabled-tool validation. Task completion/replacement invalidates stale work and observations but retains an established host grant. Pause blocks execution; resume requires an explicit decision and a fresh observation. Disconnect, transport failure and host restart end access. Upload, download, PDF and unsupported operations do not receive page-action automatic approval. Refusal suppresses further automatic prompts for the invoking chat; explicit settings consent can supersede it. Resetting refusal on a new user message is still pending.

## Initial observation and session continuity

After a grant, `tabs` with `action: "list"` or `action: "active"` can obtain a page ID before the first snapshot. This discovery does not satisfy the observation requirement. `tabs` with `action: "new"` may create a background tab before any observation, including when there are no usable pages; URLs are restricted to HTTP(S) without credentials or `about:blank`. Creation is a mutation, not discovery, and its result does not unlock interactions. Never blindly repeat creation after a failed response.

A successful, nonempty `snapshot` or `screenshot` is required for the exact numeric target page before a page interaction. A capture of page A does not unlock page B. Every interaction (including navigation) or creation conservatively invalidates all observed pages, because it may change references or affect other tabs. Take another explicit snapshot before the next interaction; returned diffs are not treated as complete observations. An empty capture invalidates an earlier observation of that page. Pause/resume and revocation clear all observations. Arguments are copied before queueing so the target cannot change while waiting.

The preview permits page-scoped snapshot, screenshot, navigation, act, diff, read, grep, wait, PDF, upload and download calls, plus tab discovery, creation and closing. This policy is not a claim that all those capabilities passed live acceptance. Unclassified operations, including arbitrary scripts (`run`, `evaluate`), profile history, window/group mutations, skill persistence and resource reads, are rejected until they have an explicit policy. Supplying a `page` argument to a script does not make it page-scoped. Ordinary non-BrowserOS MCP servers are unaffected.

The verified server advertises an opaque browser-session handle in result metadata under `com.browseros.neo/session`. IVOL holds this handle in memory within the current grant, injects it into subsequent tool arguments inside the authorized serial queue, and removes that metadata field from returned results. A model-supplied `session` argument is ignored. This is distinct from the MCP transport's own session identifier.

Pause preserves the handle but blocks requests and requires a fresh observation on resume. Revocation clears it. Late results after revocation cannot restore it. Transport failures and tool results marked `isError: true` revoke the grant without replaying the request. Continuing requires explicit permission; IVOL must not silently revive a server-stopped session.

## Outstanding acceptance requirements

- Install a verified matching core build and test the complete flow through IVOL's actual task grant, not a standalone diagnostic client.
- Verify page ownership, user stop, reconnect, pause/resume and task replacement against the running server.
- Verify the per-page observation gate and first-tab creation against the real server. Local tracking cannot detect every asynchronous page change or unannounced manual intervention; it is not a guarantee that the page has remained unchanged since capture.
- Extend the policy for currently blocked capabilities without treating arbitrary scripts or mutations as read-only discovery. File operations still need their applicable approvals and live verification.
- The screenshot schema advertises a capture-size option. Whether it resizes the page or only scales the output has not been verified. Do not change browser window dimensions, page viewport or zoom during acceptance.
- Server annotations and descriptions are capability metadata, not authorization to call tools. In particular, scenario execution, uploads, downloads, history and skill storage require their applicable approvals.
- Real file operations, OAuth, frames, concurrent IDEs, all supported IDE dialogs and complete localization remain unverified.

The existing isolated browser and personal Chrome connector must remain available as explicit alternatives. Do not silently fall back between browser modes or copy profile data.
