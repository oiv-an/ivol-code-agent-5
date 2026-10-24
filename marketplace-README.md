# IVOL Code Agent 5

IVOL Code Agent 5 is an AI coding agent for VS Code, built on the open-source upstream v5.16.2 codebase.

This is an independent, unofficial fork. It is not affiliated with or endorsed by the original upstream authors. It uses its own extension ID, so an official upstream release cannot replace it.

The full list of changes is in the [README on GitHub](https://github.com/oiv-an/ivol-code-agent-5/blob/stable-v5/README.md) and in the included CHANGELOG.

## Main differences from upstream

- **Privacy:** automatic Kilo/Roo account, task sharing, telemetry, cloud Marketplace and upgrade traffic are disabled.
- **Providers:** OpenAI-compatible endpoints, OpenAI Codex (ChatGPT Plus/Pro), Claude Code account, Ollama and LM Studio. Each profile has an optional TLS certificate exception and a connection check.
- **Models:** a fast cached model selector, reasoning level beside it (including max and Ultra), MAX / MED / MIN presets, and a separate model and reasoning choice per conversation and project.
- **Agent Manager:** sub-agents with provider model and reasoning selection, model switching within existing sessions, and explicit continuation after errors.
- **Web search:** optional native web search that the model triggers on its own, with sources, plus a separate search window from the globe button.
- **Long conversations:** incremental updates, a bounded live message window with history loading on scroll, a compact task history index and fast saves.
- **Current Task memory:** `CURRENT_TASK.md` keeps the goal, checklist and next step. Work continues after context compression, and failed compression offers explicit retry or continue choices. Frozen messages stay in context.
- **Chat:** tool and command activity shown in chat, an always-available Stop button, conversation search, file attachments from anywhere on disk, a message queue that never loses input, per-task scheduled reminders, and a YOLO timer.
- **Task history:** stored inside each project in `.ivol/` with atomic, recoverable writes and reliable checkpoint restore.
- **Browser:** BrowserOS neo and personal Chrome control, with browser approval remembered per task.
- **Telegram:** continue an explicitly connected task in a private Telegram topic.
- **Autocomplete:** a separate model for autocomplete, off by default.

## Claude Code account access

If `ANTHROPIC_API_KEY` is set in the environment, it can conflict with Claude Code account access and cause requests to use that API key instead. Unset the variable and restart VS Code when you want to use your Claude account subscription.

## Data and network access

When you submit a chat request, prompts, selected files and other context are sent to the AI provider you selected. Provider credentials are kept in VS Code secure storage. Local providers can be used through Ollama or LM Studio. Browser, MCP, terminal and similar tools may access services or files that you explicitly select or configure.

Read the [IVOL Code Agent 5 Privacy Policy](https://github.com/oiv-an/ivol-code-agent-5/blob/stable-v5/PRIVACY.md) before using the extension.

## Versioning

Version `5.17.119` is based on upstream `5.16.2` plus the IVOL improvements and stability fixes.

## License and attribution

IVOL Code Agent 5 is distributed under the Apache License 2.0. It is based on the [upstream legacy repository](https://github.com/Kilo-Org/kilocode-legacy), which is itself derived from Roo Code and Cline and includes software from Continue. See the included `LICENSE` and `NOTICE` files for details.
