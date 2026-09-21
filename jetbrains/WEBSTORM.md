# IVOL Code Agent 5 for WebStorm

WebStorm uses separate archives for different IntelliJ Platform generations. Installing the 2024.3 archive in WebStorm 2026.1 correctly fails with a compatibility error; do not edit the archive's compatibility range to bypass it.

## Choose the matching archive

| WebStorm | Exact SDK       | Supported build range | Archive suffix      | Plugin bytecode |
| -------- | --------------- | --------------------- | ------------------- | --------------- |
| 2024.3.5 | WS-243.26053.12 | 243.26053.12–243.\*   | webstorm-2024.3.zip | Java 21         |
| 2026.1.5 | WS-261.27258.45 | 261.27258.45–261.\*   | webstorm-2026.1.zip | Java 21         |
| 2026.2.3 | WS-262.10968.77 | 262.10968.77–262.\*   | webstorm-2026.2.zip | Java 25         |

The 2026.2 target is available starting with plugin 5.17.13. Build with `-PwebstormTarget=2026.2` and Java 25; outputs use `build/webstorm262`. It retains the modular JCEF dependency and uses modern CEF callbacks, unlike the older WebStorm targets. Compilation, automated tests and Plugin Verifier against the exact WS-262.10968.77 SDK passed. Live installation remains a separate check.

The 2026.1 package was built for release 5.17.11. Compilation and 206 automated tests passed, and Plugin Verifier reported **Compatible** against WS-261.27258.45. The final ZIP passed CRC, identity, version, build-range and Java 21 bytecode checks; its shared extension distribution matches the same-version VSIX byte for byte. These checks do not replace live installation testing. The SDK declares Java 21 as its minimum even though its bundled JBR runs Java 25.

## Installation

1. Check **Help → About** for the IDE build number.
2. Download the matching WebStorm ZIP from the project's GitHub release.
3. Choose **Settings → Plugins → gear → Install Plugin from Disk** and select the ZIP without unpacking it.
4. Restart the IDE yourself after finishing your current work.

Use the standard JetBrains Runtime with JCEF, enable the Terminal plugin, and make Node.js 20.6.0 or later available to the IDE. Node.js is not bundled. Native dependencies are included for Windows x64, Linux x64, macOS Intel and Apple Silicon; packaged files do not establish live acceptance on every OS.

Do not enable official Kilo Code and IVOL Code simultaneously in the same IDE. Updates retain plugin identity `pro.ivol.kilocode5.jetbrains`, internal extension identity `Kilo Code.kilo-code`, and the existing `.kilocode/globalStorage` and `.kilocode/workspaceStorage` directories. Do not delete settings or history to resolve an archive compatibility error.

## Building

Refresh the shared extension and JetBrains host resources with the repository's JetBrains bundle workflow before packaging. From `jetbrains/plugin`, with Java 21 available:

```sh
JAVA_HOME=/path/to/jdk-21 ./gradlew verifyBuildTargetConfiguration test buildPlugin verifyPlugin \
  -PplatformType=WS -PwebstormTarget=2026.1 \
  -PdebugMode=release \
  -PplatformZipPath=/path/to/platform.zip \
  --no-daemon --max-workers=2 \
  -Pkotlin.compiler.execution.strategy=in-process
```

Use `-PwebstormTarget=2024.3` for the older target; it remains the default for `platformType=WS`. New outputs use `build/webstorm261`, while older outputs retain `build/webstorm`. Do not run a shared clean when other target artifacts need to be preserved.

Both targets use legacy CEF resource callbacks. The 243 target uses Kotlin language/API 2.0 and removes the separate JCEF module dependency. The 261 target retains the JCEF module declared by its SDK and uses the current compiler defaults. These choices do not change the PhpStorm, IntelliJ IDEA or PyCharm targets.

## Verification boundaries

The previous 5.17.3 archive passed Plugin Verifier against WS-243.26053.12, with legacy/internal API warnings. That result does not apply to the new 261 archive or prove interactive operation. Verify each final archive's plugin identity, version, build range, Java bytecode and shared extension contents before publishing it.

Installation, JCEF rendering, terminal actions and normal project work require separate live acceptance in the user's WebStorm. Builds do not launch an IDE or modify its existing installation.

Official references: [WebStorm 2026.1.5 release metadata](https://data.services.jetbrains.com/products/releases?code=WS&version=2026.1.5&type=release), [WebStorm 2024.3.5 release metadata](https://data.services.jetbrains.com/products/releases?code=WS&version=2024.3.5&type=release), [platform build and Java requirements](https://plugins.jetbrains.com/docs/intellij/build-number-ranges.html), [installing plugins](https://www.jetbrains.com/help/webstorm/managing-plugins.html#install_plugin_from_disk).
