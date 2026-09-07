# IVOL Code Agent 5

IVOL Code Agent 5 is a stable VS Code AI coding agent based on the open-source upstream v5.16.2 codebase.

This is an independent, unofficial fork. It is not affiliated with or endorsed by the original upstream authors.

## Download and install

1. Open the [latest GitHub release](https://github.com/oiv-an/ivol-code-agent-5/releases/latest).
2. Download the file named `ivol-code-agent-5-<version>.vsix`.
3. In VS Code, open **Extensions**, choose **… → Install from VSIX…**, and select the downloaded file.
4. Restart VS Code when prompted.

The extension uses the independent ID `ivol.ivol-code-agent-5`, so an official upstream update cannot replace it.

## Goals

- Preserve the version 5 workflow on current VS Code and JetBrains IDE releases.
- Keep very long conversations responsive.
- Make OpenAI-compatible model switching fast and reliable.
- Let compatible OpenAI Responses models use optional native web search autonomously and return source links.
- Keep the extension isolated from official upstream updates and cloud services.
- Retain local task history, provider profiles, and secure credentials across personal builds.

## Providers enabled in this build

- OpenAI-compatible API endpoints.
- OpenAI Codex account access.
- Claude Code account access.
- Ollama.
- LM Studio.

Other provider choices and Kilo subscription services are hidden.

## Claude Code account access

If `ANTHROPIC_API_KEY` is set in the environment, it can conflict with Claude Code account access and cause requests to use that API key instead. Unset the variable and restart VS Code when you want to use your Claude account subscription.

See [PRIVACY.md](PRIVACY.md) for the data and network behavior of this build.

## VS Code extension identity

- Display name: `IVOL Code Agent 5`
- Extension ID: `ivol.ivol-code-agent-5`
- Version: `5.16.230`

Version `5.16.230` corresponds to the upstream `5.16.2` base plus the current IVOL stability revisions.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for local build instructions. A production VSIX can be built with:

```bash
corepack pnpm vsix:production
```

## License and attribution

IVOL Code Agent 5 is distributed under the Apache License 2.0. It is based on the [upstream legacy repository](https://github.com/Kilo-Org/kilocode-legacy), which is itself derived from Roo Code and Cline and includes software from Continue. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
