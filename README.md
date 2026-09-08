# IVOL Code Agent 5

IVOL Code Agent 5 is a stable AI coding agent for VS Code, PhpStorm, IntelliJ IDEA, and PyCharm, based on the open-source upstream v5.16.2 codebase.

This is an independent, unofficial fork. It is not affiliated with or endorsed by the original upstream authors.

## Download and install

**[Download version 5.16.234 — choose your IDE](https://github.com/oiv-an/ivol-code-agent-5/releases/tag/v5.16.234)** · **[Инструкция на русском](DOWNLOADS.md)**

| IDE / verified version                     | Download                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| VS Code                                    | [VSIX](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.16.234/ivol-code-agent-5-5.16.234.vsix)                                |
| PhpStorm 2026.2.2 — PS-262.10315.130       | [PhpStorm ZIP](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.16.234/ivol-code-agent-5-5.16.234-phpstorm.zip)                |
| IntelliJ IDEA 2026.2.2 — IU-262.10315.125  | [IDEA 2026.2 ZIP](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.16.234/ivol-code-agent-5-5.16.234-intellij-idea.zip)        |
| IntelliJ IDEA 2025.3.6.1 — IU-253.33813.55 | [IDEA 2025.3 ZIP](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.16.234/ivol-code-agent-5-5.16.234-intellij-idea-2025.3.zip) |
| PyCharm 2025.1.1.1 — PY-251.25410.159      | [PyCharm 2025.1 ZIP](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.16.234/ivol-code-agent-5-5.16.234-pycharm-2025.1.zip)    |

For VS Code, open **Extensions → … → Install from VSIX…** and choose the VSIX. Restart when prompted and your work is finished.

The extension uses the independent ID `ivol.ivol-code-agent-5`, so an official upstream update cannot replace it.

### JetBrains installation

Open **Settings → Plugins → Settings menu → Install Plugin from Disk**, select the ZIP without unpacking it, and restart when your work is finished. Choose the correct IDE version: the IDEA 2026.2 ZIP cannot be installed in IDEA 2025.3.

Install the update over your existing IVOL Code plugin. Do not delete its history or settings. Version 5.16.234 fixes Windows task startup failing with `EPERM: operation not permitted, fsync` / `API conversation history could not be saved`. The shared JSON writer now synchronizes both new files and backup copies using writable, non-truncating handles. Atomic saves and protection of previous history on genuine write failures remain enabled. The fix is included in VS Code and all four JetBrains packages, together with the JetBrains native-startup fix from 5.16.233.

JetBrains packages require Node.js **20.6.0 or newer** available to the IDE, its standard runtime with JCEF, and the enabled Terminal plugin. The 2026.2 targets require Java 25; IDEA 2025.3 and PyCharm 2025.1 use Java 21.

JetBrains verification covers automated tests, package contents, and Plugin Verifier against the exact builds listed above. These checks do not replace an interactive IDE check after installation. See the [IDEA 2026.2](jetbrains/INTELLIJ_IDEA.md), [IDEA 2025.3](jetbrains/INTELLIJ_IDEA_2025_3.md), and [PyCharm](jetbrains/PYCHARM.md) guides for details.

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

### Optional certificate exception (5.16.232)

Each enabled provider profile has an **Ignore TLS certificate errors** checkbox, off by default. Enable it only for an API server you trust when its certificate is invalid or self-signed: it removes server identity verification and can expose prompts and API credentials to interception.

The exception is restricted to the profile's API origin, including chat, model discovery, context preparation, and native web-search requests. It does not disable certificate verification globally, on unrelated redirect destinations, or during subscription OAuth login/token refresh. Unknown custom network dispatchers fail closed rather than bypassing their proxy route. LM Studio over HTTPS with this exception uses its REST model catalog instead of an unverified WebSocket connection.

The setting lives in the shared core and interface used by the VS Code, PhpStorm, IntelliJ IDEA, and separately targeted PyCharm editions. It is not included in the already-published 5.16.231 packages.

## Claude Code account access

If `ANTHROPIC_API_KEY` is set in the environment, it can conflict with Claude Code account access and cause requests to use that API key instead. Unset the variable and restart VS Code when you want to use your Claude account subscription.

See [PRIVACY.md](PRIVACY.md) for the data and network behavior of this build.

## VS Code extension identity

- Display name: `IVOL Code Agent 5`
- Extension ID: `ivol.ivol-code-agent-5`
- Version: `5.16.234`

Version `5.16.234` corresponds to the upstream `5.16.2` base plus the current IVOL stability revisions.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for local build instructions. A production VSIX can be built with:

```bash
corepack pnpm vsix:production
```

## License and attribution

IVOL Code Agent 5 is distributed under the Apache License 2.0. It is based on the [upstream legacy repository](https://github.com/Kilo-Org/kilocode-legacy), which is itself derived from Roo Code and Cline and includes software from Continue. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
