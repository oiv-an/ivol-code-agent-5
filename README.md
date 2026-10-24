# IVOL Code Agent 5

IVOL Code Agent 5 is an AI coding agent for VS Code, built on the open-source upstream **v5.16.2** codebase (Kilo Code legacy, which is derived from Roo Code and Cline). JetBrains packages for PhpStorm, IntelliJ IDEA, PyCharm and WebStorm were built in the past and are available as separate archives.

This is an independent, unofficial fork. It is not affiliated with or endorsed by the original upstream authors.

**Current version: 5.17.121.** The full per-version history is in [CHANGELOG.md](CHANGELOG.md). This README summarizes everything that differs from upstream 5.16.2.

## Install

| Editor                    | Where to get it                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VS Code                   | [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=ivol.ivol-code-agent-5) or [Open VSX](https://open-vsx.org/extension/ivol/ivol-code-agent-5)              |
| PyCharm 2026.1 / 2026.2.3 | [GitHub release v5.17.114](https://github.com/oiv-an/ivol-code-agent-5/releases/tag/v5.17.114)                                                                                            |
| Other JetBrains IDEs      | [GitHub release v5.17.81](https://github.com/oiv-an/ivol-code-agent-5/releases/tag/v5.17.81) (PhpStorm, IntelliJ IDEA 2026.2 / 2025.3, PyCharm 2025.1, WebStorm). These are older builds. |

The extension ID is `ivol.ivol-code-agent-5`, so an official upstream update cannot replace it. Updating over an existing install keeps task history, provider profiles and secure credentials.

JetBrains ZIPs are installed through **Settings → Plugins → ⚙ → Install Plugin from Disk** without unpacking. They require Node.js 20.6.0 or newer, the bundled JCEF runtime and the Terminal plugin. Pick the archive that matches your IDE platform. Russian instructions: [DOWNLOADS.md](DOWNLOADS.md).

Active development and regular releases currently target VS Code only. New JetBrains packages are built only on request.

## What is different from upstream 5.16.2

### Identity, privacy and providers

- Independent product name, icon and extension ID. Upstream updates, the upstream Marketplace listing and upstream cloud services can no longer replace or reach this build.
- Automatic Kilo/Roo account, task sharing, telemetry, cloud Marketplace and upgrade traffic are disabled. Legacy Kilo Gateway choices are removed from settings.
- The provider list is reduced to the ones that are maintained: **OpenAI-compatible endpoints, OpenAI Codex (ChatGPT Plus/Pro account), Claude Code account, Ollama and LM Studio**.
- Each provider profile has an optional, off-by-default **Ignore TLS certificate errors** checkbox for trusted servers with self-signed certificates. It applies only to that profile's API origin, never globally or to OAuth login.
- The **Check connection** button sends a short test request and produces a copyable diagnostic report without credentials or conversation content.
- JetBrains authentication parameters and webview message contents are no longer written to IDE logs.

### Models and reasoning

- **Agent Manager:** launch sub-agents with the active provider's model catalog and a reasoning level. Change the model inside an existing session without restarting it, then use **Continue** after an API failure or repeated tool-use errors. A single manager panel lists saved project sessions across restarts and resumes their local history. Closing the panel stops execution without deleting the saved list; stopped requests no longer show an active spinner.

- The quick model selector shows every model the OpenAI-compatible provider exposes. The catalog is cached, so it appears immediately and survives restarts and temporary provider failures.
- The reasoning level is chosen right next to the model selector. Added levels: GPT-5.6 **max** and **Ultra** for OpenAI-compatible and Codex connections, with automatic fallback when a provider rejects the highest level.
- **MAX / MED / MIN presets**: three buttons next to the model selector store a model and reasoning pair for each provider profile. The active preset is highlighted in green. New conversations and new windows always start on **MAX** when it is configured; reopened tasks keep their own choice.
- Each conversation keeps its own model, reasoning level and preset. Switching in one window or project no longer changes other windows. New tasks use configured MAX, or provider defaults when MAX is not configured.
- The model selected on the home screen is used for the first message of a new task. The model selector stays available during every task operation.
- The signed-in ChatGPT Plus/Pro model catalog loads automatically, with a 370k context limit and prompt caching kept on.
- OpenAI-compatible requests send an explicit output limit (64,000-token fallback), which prevents silently truncated answers.
- Supported prompt caching is enabled, with stable per-task cache affinity.

### Web search

- **Native web search** (optional) for OpenAI-compatible profiles. The main model decides on its own when to search. Only the isolated search call goes through the Responses API, using a separately selectable search model. Normal turns stay on Chat Completions. Results come back with clickable sources.
- A separate **web search window** opens from the globe button below the chat. It does not send task history or project files, and results can be saved as Markdown (existing files are never overwritten).
- The agent is instructed to use web search first for plain lookups and to open a browser only for logins, forms, testing your own site or when you ask for it.

### Long conversations and performance

- Updates in very long conversations are incremental, which keeps the UI responsive.
- Chat memory is reduced through lightweight previews and a bounded live window of about 80 messages. Older history loads when you scroll up, and the reading position and filters are kept.
- Task history stays small: oversized first messages (for example pasted JSON) are capped in the history index, and the project index is cached. Saving, starting and stopping tasks no longer slow down every window.
- Recursive directory scans stop at `.gitignore` exclusions, so large ignored folders cannot freeze the extension host.
- Large files are read in resumable sections. Listing large archives does not read their contents. Checkpoint diffs no longer freeze on large or binary files.
- OpenAI-compatible stream timeouts and cancellation are fixed. Failed automatic retries are limited and do not replay partial tool work.

### Context compression and task memory (Current Task)

- **Current Task** is on by default. The agent maintains `CURRENT_TASK.md` in the project root with the goal, checklist, key data and the exact next step. It removes completed blocks after you confirm and keeps the file short.
- Before compression, the task memory is updated and verified. Afterwards the agent rereads it and **continues working** instead of stopping with a status report. A summary you request yourself still hands control back to you.
- The automatic compression threshold is configurable from 1% to 95% of remaining context (default 10%), globally or per profile, based on the full context window.
- When compression fails, work pauses for an explicit **Retry compression**; there is no bypass that continues ordinary work without the required compression. If the task-memory update itself failed, retry that step first. A verified update is retained across model changes and window reloads. Model, operation and technical details of failures are shown.
- Compression requests do not send screenshots and end with an explicit summary request. This prevents empty summaries on large or image-heavy histories.
- **Frozen messages**: you can freeze important messages so they are sent with every request, even after compression.
- The agent replies in your language, while code and memory/instruction files stay in English.

### Chat interface

- Agent commands, tool calls, MCP and browser actions are shown in the chat, including auto-approved ones. A toggle next to chat search hides or shows them. Command rows start collapsed with a one-line preview.
- A **Stop** button is always available during tool execution. It shows the current command with elapsed time and cancels task-owned terminal and MCP work without closing the conversation.
- **Search** in the current conversation from the chat, also available to the agent as a tool.
- **Attach files** from anywhere on disk with drag and drop or the paperclip button. The `@` button lists files from the open project.
- Messages you send while the agent is busy are queued and never lost. Unsent input is restored when a task stops.
- A **clock** button in the chat input sets one reminder per task: repeat every N minutes or hours, once after a delay, or at an exact time. While the task is open, the text is sent when the agent has finished and is waiting; runs that fall while it works are skipped. A countdown shows the time left, and closing the task stops the reminder. An "Allow browser control" checkbox confirms browser access for that task automatically, without the prompt.
- The auto-approval checkbox is always visible in the bottom toolbar. A **YOLO timer** temporarily auto-approves everything and returns to normal rules when it expires.
- One checkbox approves all current and future tools of a selected MCP server.
- Completed root tasks remain open for follow-up. A notification appears 5 minutes after a task finishes if you left the editor.
- A dedicated **IVOL settings** section brings together task memory, storage, Telegram, personal browser, web search and model presets.

### Task history and checkpoints

- New tasks are stored **inside each project** in a hidden `.ivol/` folder with automatic Git exclusion, so history and checkpoints move with the project. Older tasks in global storage can be copied with verification.
- History writes are atomic and recover after interrupted window reloads. Incomplete restores cannot overwrite saved conversations.
- When a task cannot start, an explicit **Retry** action is offered instead of a stuck chat.
- Restoring a checkpoint no longer shows false timeout or "superseded" errors and cancels a pending compression.
- Windows-specific `EPERM ... fsync` history save failures are fixed.

### Browser control

- **BrowserOS neo** integration through local MCP with one-button connect, confirmed browser launch and connection recovery after startup delays.
- **Personal Chrome control** (preview) through a browser extension, with per-task consent, background tabs, visible tab groups, and pause and revoke controls.
- Browser approval is **remembered per task** across window reloads and browser restarts. A browser checkmark beside auto-approval revokes it. If the browser session drops or expires, the next browser action reconnects without asking again; only a manual pause or revoke requires a new approval.
- Browser scripts (`run`, `evaluate`) are allowed after explicit approval. Element interactions still require a fresh page observation.

### Telegram

- An explicitly connected task can continue in a private Telegram topic, with readable titles, the pinned original request, formatted replies, screenshots, one-shot approval buttons and remote stop. Bot credentials are never shown in errors.

### Autocomplete

- A separate autocomplete model can be chosen from the current provider, with searchable selection and complete multi-line suggestions. The chat model is not changed.
- Autocomplete is off by default. It is compatible with IntelliSense, reuses pending requests, discards stale results and sends text-only requests. Diagnostics never record source code or credentials.

### Skills and MCP

- Project skills and MCP configuration are discovered in the shared `.agents` folder, and remote servers can be configured with `serverUrl`.
- Automatic MCP reconnection no longer shows notification spam.

### JetBrains editions (legacy)

- Compatibility with PhpStorm 2026.2, separate packages for IntelliJ IDEA 2026.2 and 2025.3.6.1, PyCharm 2025.1.1.1, 2026.1 and 2026.2.3, and WebStorm 2024.3, 2026.1.5 and 2026.2.3.
- Fixes for task history stored outside the plugin folder (updates cannot erase it), false "connection lost" warnings, concurrent native-library startup and safe editor opening.

## Claude Code account access

If `ANTHROPIC_API_KEY` is set in the environment, Claude Code account access may use that key instead of your subscription. Unset the variable and restart VS Code when you want to use your Claude account.

See [PRIVACY.md](PRIVACY.md) for the data and network behavior of this build.

## Documentation and design history

- [Improvements at a glance](IVOL_CHANGES_RU.md): a compact overview of the fork's additions, updated through 5.17.121 (English content; historical filename retained).
- [Release history](CHANGELOG.md): version-by-version changes, including Agent Manager recovery, scheduled reminders, browser consent, task-history performance and compression fixes.
- [Project task storage](docs/project-task-storage.md): project-local history and migration behavior.
- [Modern prompt audit](docs/modern-prompts-audit-2026-10-01.md): historical source audit and research; proposed prompt changes are not shipped features, and model/API claims require revalidation.
- [Continuous-context proposal](plans/2026-09-11-continuous-context-management.md) and [freeze implementation snapshot](plans/2026-09-11-blocks-C-D-design.md): historical design decisions and recorded verification, not current implementation instructions or a release checklist.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for local build instructions. A VSIX can be built with:

```bash
pnpm vsix
```

## License and attribution

IVOL Code Agent 5 is distributed under the Apache License 2.0. It is based on the [upstream legacy repository](https://github.com/Kilo-Org/kilocode-legacy), which is itself derived from Roo Code and Cline and includes software from Continue. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
