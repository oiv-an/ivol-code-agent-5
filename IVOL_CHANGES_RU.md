# IVOL improvements at a glance

Updated for 5.17.121. This document was originally a Russian draft; its filename is retained for
existing local references, while the published content follows the repository's English documentation policy.
See [README](README.md) for the complete feature overview and [CHANGELOG](CHANGELOG.md) for release history.

## 1. Privacy and direct connections

- Automatic Kilo/Roo cloud, gateway, telemetry and upgrade traffic is disabled. Maintained provider
  choices are OpenAI-compatible endpoints, Codex (ChatGPT Plus/Pro), Claude Code, Ollama and LM Studio.

## 2. Models and reasoning

- Per-profile **MAX / MED / MIN** presets store a model and reasoning pair. The active preset is
  green. New conversations start with configured MAX; restored tasks keep their own selection.
- Choose reasoning beside the model selector, including **max** and **Ultra** where supported.
- Model selection remains available while a task is running; changing it applies to subsequent
  requests without automatically restarting the current one.
- The OpenAI-compatible catalog is cached across restarts and temporary provider failures.
- Codex loads the account's model catalog, retains the last working catalog offline, uses a 370k
  context limit and stable per-task prompt caching. Other supported providers also use caching.
- Responses API input is a structured array, including proxy and Codex OAuth routes.

## 3. Agent Manager

- Start sub-agents with the active provider's models, a reasoning level and an operating mode.
- Switch models in an existing session and explicitly continue after API or tool-use errors.
- A single manager panel retains project sessions across IDE restarts and resumes local history.
- Closing the panel stops execution, not storage. Stopped requests do not retain active spinners.

## 4. Web search

- Optional native search for OpenAI-compatible profiles uses a separately selected search model,
  is triggered by the agent when needed, and returns clickable sources.
- The globe button opens an independent search window without sending project files or task
  history; results can be saved as Markdown.
- Ordinary information lookups should use search before browser control.

## 5. Context and task memory

- **Current Task** maintains the goal, progress, key data and next step in the project's task-memory
  document so work can continue after compression.
- Automatic compression supports a configurable remaining-context threshold of 1–95% (default 10%).
- Failed compression requires explicit retry; a verified memory update is not repeated simply
  because the model changed. Successful automatic compression resumes the task.
- Summary requests omit screenshots and explicitly request summary text rather than tool actions.
- Frozen messages remain in outgoing context after compression.

## 6. Reliability and performance

- Messages submitted during work are queued; large files are read in resumable sections.
- Truncated write commands are not executed with partial file contents.
- Streaming has cancellation, timeouts and bounded retries.
- Long chats use incremental rendering and bounded live history. Task indexes cap oversized titles
  and cache parsed project history; large ignored folders do not require recursive scanning.
- History writes are atomic and recoverable, including fixes for Windows save failures.
- Task history is stored inside projects; checkpoint restores avoid false initialization timeouts.

## 7. Chat and integrations

- Attach any file from disk by drag-and-drop or the paperclip button.
- Per-task reminders support intervals, delays and exact times, with a countdown. Busy runs are
  skipped; reminders run only while the task is open. Optional browser approval belongs to that task.
- YOLO mode has a timer. Stop remains available during tool execution.
- Provider connection checks produce credential-free diagnostics; TLS exceptions are per profile.
- A notification reminds users about completed tasks when they leave the editor.
- Explicitly connected tasks can continue in private Telegram topics, including approvals and Stop.
- Autocomplete uses a separately chosen model and is off by default.

## 8. Browser control

- Personal Chrome control is a preview with background tabs, groups, pause and revoke controls.
- BrowserOS neo connects through local MCP. Script execution requires explicit approval.
- Browser approval is remembered per task across connection loss and reload; manual pause/revoke
  remains authoritative.

## 9. Legacy JetBrains editions

- Separate archives exist for PhpStorm, IntelliJ IDEA, PyCharm and WebStorm; use an archive matching
  the IDE platform. Routine releases now target VS Code only.
- History is stored outside the plugin installation and survives updates.
- Historical fixes cover false connection-loss errors, multi-window startup, memory leaks and
  removal of authentication parameters from IDE logs.

Design documents in [plans](plans/) and the [prompt audit](docs/modern-prompts-audit-2026-10-01.md)
are historical research, not promises that every proposal has shipped.
