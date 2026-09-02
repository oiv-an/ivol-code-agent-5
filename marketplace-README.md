# IVOL Code Agent 5

IVOL Code Agent 5 is a stable VS Code AI coding agent based on the open-source upstream v5.16.2 codebase.

This is an independent, unofficial fork. It is not affiliated with or endorsed by the original upstream authors.

## Why this build exists

This build preserves the version 5 workflow while keeping it compatible with current VS Code releases. It is intentionally isolated from the official upstream extension and cannot be automatically replaced by a newer upstream release.

## Included improvements

- Fast model switching from the chat input.
- Persistent OpenAI-compatible model catalogs that remain available after restart or a temporary provider failure.
- More efficient updates for very long conversations.
- Reliable reopening of saved tasks.
- Supported prompt caching is enabled.
- Automatic Kilo/Roo account, Marketplace, task-sharing, telemetry, and upgrade communications are disabled in this build.

## Providers available in this build

- OpenAI-compatible API endpoints.
- OpenAI Codex account access.
- Claude Code account access.
- Ollama.
- LM Studio.

Other provider choices and Kilo subscription services are hidden in this build.

## Data and network access

When you submit a chat request, prompts, selected files, and other context are sent to the AI provider selected by the user. Provider credentials are kept in VS Code secure storage. Local providers can be used through Ollama or LM Studio. Browser, MCP, terminal, and similar tools may access services or files that the user explicitly selects or configures.

See `PRIVACY.md`, included with the extension, for details.

## Versioning

Version `5.16.210` corresponds to the upstream `5.16.2` base plus the tenth IVOL stability revision.

## License and attribution

IVOL Code Agent 5 is distributed under the Apache License 2.0. It is based on the [upstream legacy repository](https://github.com/Kilo-Org/kilocode-legacy), which is itself derived from Roo Code and Cline and includes software from Continue. See the included `LICENSE` and `NOTICE` files for details.
