# PyCharm 2026 packages

IVOL Code Agent 5 version **5.17.114** provides two separate packages:

| Target           | SDK build        | Supported range      | Bytecode |
| ---------------- | ---------------- | -------------------- | -------- |
| PyCharm 2026.1   | PY-261.22158.340 | 261.22158.340–261.\* | Java 21  |
| PyCharm 2026.2.3 | PY-262.10968.92  | 262.10968.92–262.\*  | Java 25  |

Download the matching package from [GitHub release v5.17.114](https://github.com/oiv-an/ivol-code-agent-5/releases/tag/v5.17.114):

- [PyCharm 2026.1](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.17.114/ivol-code-agent-5-5.17.114-pycharm-2026.1.zip)
- [PyCharm 2026.2.3](https://github.com/oiv-an/ivol-code-agent-5/releases/download/v5.17.114/ivol-code-agent-5-5.17.114-pycharm-2026.2.zip)

In PyCharm, use **Settings → Plugins → gear icon → Install Plugin from Disk**, then select the ZIP without extracting it. Restart the IDE yourself after finishing active work if requested by the IDE. The build process does not install, launch, stop or restart an IDE.

The existing plugin ID `pro.ivol.kilocode5.jetbrains` and storage identities are unchanged. Do not delete history or settings before updating. Use the IDE's bundled JetBrains Runtime with JCEF, enable the bundled Terminal plugin, and make Node.js 20.6.0 or later available to the IDE. Native dependencies are included for Windows x64, Linux x64, macOS Intel and Apple Silicon; interactive execution on every OS has not been verified.

## Build

The default PyCharm target remains the legacy 2025.1 package. Select the new targets explicitly using `-PplatformType=PY -PpycharmTarget=2026.1` or `-PplatformType=PY -PpycharmTarget=2026.2`.

Refresh the shared extension, webview and host resources before Gradle packaging. Run Gradle from `jetbrains/plugin`, not only with `-p` from the repository root: packaging reads the generated dependency list relative to the working directory. Use the matching official SDK through `-PlocalIdePath`, a native runtime through `-PlocalRuntimePath`, and the real native dependency archive through `-PplatformZipPath`. Run target builds sequentially within one worktree because generated resources are shared.

Outputs are isolated under `build/pycharm261` and `build/pycharm262`. Target selection also controls Java bytecode, the modular JCEF dependency and the legacy/modern CEF callback adapter. Do not widen the legacy package's compatibility range as a substitute for compiling against the new SDKs.

## Verification of 5.17.114

- Both targets compile and package successfully against their exact official SDKs.
- Both pass `verifyBuildTargetConfiguration` and JetBrains Plugin Verifier with no compatibility, missing dependency, invalid plugin or plugin structure failures. Legacy deprecated/internal API warnings remain.
- ZIP integrity, plugin ID/version, compatibility ranges, Java class versions and identical shared extension bundles were checked.
- Backend and webview TypeScript checks pass in the isolated source tree.
- Direct JUnit execution against the 2026.1 SDK passes all 206 tests.
- Direct JUnit execution against the 2026.2.3 SDK passes 205 of 206 tests. `ThreadLeakPreventionTest` fails its thread-growth assertion (56 threads against a threshold below 50 on the second run; 74 on the first). This test was not changed or suppressed.
- The standard Gradle test launcher rejects the Linux x64 SDK on a macOS ARM64 host; direct JUnit execution uses the compiled tests and a native JVM instead.
- Installation and interactive use in the user's PyCharm have not been verified. Archive checks, unit tests and Plugin Verifier are not substitutes for that check.
