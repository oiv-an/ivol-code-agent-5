# Download IVOL Code Agent 5

**[VS Code 5.17.145](https://github.com/oiv-an/ivol-code-agent-5/releases/tag/v5.17.145)** is the latest VS Code release, with its VSIX and [SHA256SUMS.txt](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.17.145/SHA256SUMS.txt). The task header now shows the custom task name when one is set, falling back to the first message otherwise. Verification: webview type check passed. Reload the VS Code window to activate the update.

**[JetBrains packages 5.17.136](https://github.com/oiv-an/ivol-code-agent-5/releases/tag/v5.17.136)** remain unchanged. This release contains nine JetBrains ZIPs, the previous VSIX and its own checksums. No JetBrains builds or installations were performed for the subsequent VS Code-only releases through 5.17.145.

## Choose your IDE version

Find the IDE version and build number in **Help → About**. Plugin versions (**VS Code 5.17.145**, **JetBrains 5.17.136**) are independent of IDE versions. SDK verification below means automated checks, not an interactive installation test.

| IDE                  | SDK used for compilation and verification | Declared compatibility                                       | Download                                                                                                                                       |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| VS Code              | VSIX package                              | See the VS Code engine requirement in the extension manifest | [VSIX](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.17.145/ivol-code-agent-5-5.17.145.vsix)                                |
| PhpStorm 2026.2      | 2026.2.3, PS-262.10968.76                 | 262–262.\*                                                   | [PhpStorm ZIP](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.17.136/ivol-code-agent-5-5.17.136-phpstorm.zip)                |
| IntelliJ IDEA 2026.2 | 2026.2.2, IU-262.10315.125                | 262–262.\*                                                   | [IDEA 2026.2 ZIP](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.17.136/ivol-code-agent-5-5.17.136-intellij-idea.zip)        |
| IntelliJ IDEA 2025.3 | 2025.3.6.1, IU-253.33813.55               | 253.33813.55–253.\*                                          | [IDEA 2025.3 ZIP](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.17.136/ivol-code-agent-5-5.17.136-intellij-idea-2025.3.zip) |
| PyCharm 2025.1       | 2025.1.1.1, PY-251.25410.159              | 251.25410.159–251.\*                                         | [PyCharm 2025.1 ZIP](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.17.136/ivol-code-agent-5-5.17.136-pycharm-2025.1.zip)    |
| PyCharm 2026.1       | 2026.1, PY-261.22158.340                  | 261.22158.340–261.\*                                         | [PyCharm 2026.1 ZIP](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.17.136/ivol-code-agent-5-5.17.136-pycharm-2026.1.zip)    |
| PyCharm 2026.2       | 2026.2.3, PY-262.10968.92                 | 262.10968.92–262.\*                                          | [PyCharm 2026.2 ZIP](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.17.136/ivol-code-agent-5-5.17.136-pycharm-2026.2.zip)    |
| WebStorm 2024.3      | 2024.3.5, WS-243.26053.12                 | 243.26053.12–243.\*                                          | [WebStorm 2024.3 ZIP](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.17.136/ivol-code-agent-5-5.17.136-webstorm-2024.3.zip)  |
| WebStorm 2026.1      | 2026.1.5, WS-261.27258.45                 | 261.27258.45–261.\*                                          | [WebStorm 2026.1 ZIP](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.17.136/ivol-code-agent-5-5.17.136-webstorm-2026.1.zip)  |
| WebStorm 2026.2      | 2026.2.3, WS-262.10968.77                 | 262.10968.77–262.\*                                          | [WebStorm 2026.2 ZIP](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.17.136/ivol-code-agent-5-5.17.136-webstorm-2026.2.zip)  |

**IDEA 2025.3 needs the filename containing `intellij-idea-2025.3`.** The `intellij-idea.zip` package is for IDEA 2026.2. Likewise, choose the exact PyCharm or WebStorm generation; editing the ZIP compatibility range does not make it compatible. Other major IDE generations are not claimed. The broader declared PS/IU 262 range is not a claim that every patch has been tested.

## Installation

**VS Code:** use [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=ivol.ivol-code-agent-5), [Open VSX](https://open-vsx.org/extension/ivol/ivol-code-agent-5), or **Extensions → … → Install from VSIX…** and select the downloaded VSIX.

**PhpStorm / IntelliJ IDEA / PyCharm / WebStorm:** open **Settings → Plugins → gear icon → Install Plugin from Disk** and select the downloaded ZIP **without extracting it**.

Finish active work before restarting an IDE. Update over the existing IVOL installation: deleting history or settings is unnecessary. Do not enable official Kilo Code and IVOL Code simultaneously in the same IDE. JetBrains plugin identity `pro.ivol.kilocode5.jetbrains`, internal extension identity `Kilo Code.kilo-code` and the existing `.kilocode/globalStorage` / `.kilocode/workspaceStorage` locations are preserved.

In GitHub Assets, choose an installer rather than **Source code (zip)** / **Source code (tar.gz)**. Those two generated archives are source snapshots, not installable plugins. Developers can build from the source tag; see the [JetBrains build guide](jetbrains/README.md) and the target-specific guides it links to. Generated resources must be prepared from the same source version before packaging.

## Requirements

- JetBrains requires an installed **Node.js 20.6.0 or newer**, available to the IDE. Node.js is not included in the ZIPs. A current supported Node.js runtime is recommended; the declared minimum does not establish that every runtime/dependency combination has been tested.
- Use the IDE's standard JetBrains Runtime with JCEF and enable its bundled Terminal plugin.
- PhpStorm, IDEA, PyCharm and WebStorm **2026.2** packages use Java 25 bytecode. IDEA 2025.3, PyCharm 2025.1/2026.1 and WebStorm 2024.3/2026.1 packages use Java 21 bytecode.
- Native dependencies are included for Windows x64, Linux x64, macOS Intel and Apple Silicon. Windows ARM64 and Linux ARM64 are not claimed. Included files do not prove interactive execution on every OS.

## Changes in 5.17.136

- The Telegram button opens a persistent project control topic with the command list, in addition to the current task's topic.
- Start tasks by text or voice, open recent tasks, switch mode or provider profile, stop the current task and check status from Telegram.
- Telegram messages are marked for delivery with the agent's next model request instead of waiting for the task to finish.
- While connected, IDE messages are mirrored to Telegram and tasks opened in the IDE receive their own topics.
- All nine JetBrains targets include the same shared extension and webview as the VS Code release. See [CHANGELOG.md](CHANGELOG.md) for the complete accumulated history.

The earlier Windows history-saving fix remains included: `EPERM: operation not permitted, fsync` / `API conversation history could not be saved`. Temporary history files and backups are opened with write access without truncating existing content, and real disk-error protection remains. The earlier native-library parallel-start fix is retained too. The original history regression was reproduced automatically with Windows-style `fsync` restrictions, including create/update, preservation of the previous file and retry. These historical checks do not constitute a new interactive Windows test. Changing a server, API key or antivirus settings is not a remedy for that fixed defect.

## Verification of the unchanged multi-IDE release 5.17.136

- Binary source revision: [ee8bfdf36](https://github.com/oiv-an/ivol-code-agent-5/commit/ee8bfdf36). The VSIX is the already accepted Marketplace/Open VSX artifact, not a replacement upload.
- All nine JetBrains variants passed target configuration checks, compilation, packaging, **206 tests each with zero failures or skips**, and Plugin Verifier against the SDKs above: **1854 passing test executions** in total.
- ZIP integrity, plugin ID/version, compatibility ranges, Java bytecode and native-platform payload presence were checked.
- Every bundled shared extension file matches the published VSIX byte for byte, and the newly built JetBrains host is identical across the nine packages.
- Plugin Verifier still reports existing deprecated, internal, experimental and other legacy API usage. No configured fatal compatibility, missing dependency or plugin-structure check failed.
- No JetBrains IDE was installed, launched, stopped or restarted during this release. Interactive installation, JCEF, terminal operations and real project work remain separate checks. Automated compatibility verification is not a promise of compatibility with future IDE versions.

Compare downloads with [SHA256SUMS.txt](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.17.136/SHA256SUMS.txt) before installation.
