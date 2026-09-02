# IVOL Code Agent 5 Privacy Notice

IVOL Code Agent 5 is a local, independent build of the open-source upstream v5.16.2 codebase. It does not require a Kilo account and does not include automatic Kilo/Roo upgrade notifications or telemetry credentials.

## Data stored locally

Task history, extension settings, provider profiles, and caches are stored in VS Code's local extension storage. Provider credentials are stored through VS Code's secure secret storage.

## Data sent to providers

When you submit a request, the extension sends the prompt and any context you selected to the active AI provider. That provider processes data under its own privacy policy and terms. The providers exposed by this build are OpenAI-compatible endpoints, OpenAI Codex account access, Claude Code account access, Ollama, and LM Studio.

Ollama and LM Studio can run locally, but their actual network behavior depends on the endpoint configured by the user.

## Tools and integrations

Commands run on the local machine. Browser, MCP, terminal, and other tools can communicate with services or files explicitly selected or configured by the user.

## Independent fork

IVOL Code Agent 5 is not affiliated with or endorsed by the original upstream authors. The included `LICENSE` and `NOTICE` files describe the open-source license and upstream attribution.
