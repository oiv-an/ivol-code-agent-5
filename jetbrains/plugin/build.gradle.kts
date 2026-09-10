// Copyright 2009-2025 Weibo, Inc.
// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: APACHE2.0
// SPDX-License-Identifier: Apache-2.0

import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.tasks.InstrumentCodeTask
import org.jetbrains.intellij.platform.gradle.tasks.PatchPluginXmlTask
import org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask
import java.nio.file.Files
import java.util.Locale
import java.util.Properties

// Convenient for reading variables from gradle.properties
fun properties(key: String) = providers.gradleProperty(key)

buildscript {
    dependencies {
        classpath("com.google.code.gson:gson:2.10.1")
    }
}

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.3.20"
    id("org.jetbrains.intellij.platform") version "2.18.1"
    id("org.jlleitschuh.gradle.ktlint") version "14.0.1"
}

// Keep PhpStorm as the default. The current IntelliJ IDEA distribution is the
// unified IU product, not the discontinued separate Community target. Older
// IDEA/PyCharm SDKs get their own bytecode targets, never a wider 262 range.
fun resolvePlatformType(code: String): IntelliJPlatformType = when (code) {
    "PS" -> IntelliJPlatformType.PhpStorm
    "IU" -> IntelliJPlatformType.IntellijIdea
    "PY" -> IntelliJPlatformType.PyCharmProfessional
    else -> throw GradleException("Unsupported platformType '$code': use PS (PhpStorm), IU (IntelliJ IDEA), or PY (PyCharm).")
}

fun resolveIdeaTarget(platformCode: String, requestedTarget: String?): String? {
    if (platformCode != "IU") {
        require(requestedTarget == null) { "ideaTarget applies only to platformType=IU." }
        return null
    }
    val target = requestedTarget ?: "2026.2"
    require(target in setOf("2026.2", "2025.3")) {
        "Unsupported ideaTarget '$target': use 2026.2 (default) or 2025.3."
    }
    return target
}

fun compareBuildNumbers(left: List<Int>, right: List<Int>): Int {
    for (index in 0 until maxOf(left.size, right.size)) {
        val comparison = (left.getOrElse(index) { 0 }).compareTo(right.getOrElse(index) { 0 })
        if (comparison != 0) return comparison
    }
    return 0
}

fun parseBuildNumber(value: String): List<Int> = value.substringAfterLast('-').split('.').map {
    it.toIntOrNull() ?: throw GradleException("Invalid IDE build number '$value'.")
}

fun checkedInstrumentationOutput(buildDirectory: File, outputDirectory: File, taskName: String): File {
    require(taskName.matches(Regex("instrument[A-Za-z0-9_]*Code"))) { "Unexpected instrumentation task: $taskName" }
    val buildRoot = buildDirectory.canonicalFile.toPath()
    val expected = buildRoot.resolve("instrumented").resolve(taskName)
    val actual = outputDirectory.canonicalFile.toPath()
    require(actual != buildRoot && actual.startsWith(buildRoot) && actual == expected) {
        "Refusing to reconcile instrumentation outside its exact generated directory: $actual"
    }
    return actual.toFile()
}

/** Preserve incremental outputs, removing only classes absent from every current compiler output. */
fun pruneObsoleteInstrumentedClasses(buildDirectory: File, outputDirectory: File, taskName: String, classesDirs: Set<File>): Int {
    val output = checkedInstrumentationOutput(buildDirectory, outputDirectory, taskName)
    if (!output.isDirectory) return 0
    val compiledClasses = classesDirs.filter(File::isDirectory).flatMap { root ->
        root.walkTopDown().filter { it.isFile && it.extension == "class" }.map { it.relativeTo(root).invariantSeparatorsPath }.toList()
    }.toSet()
    val instrumentedClasses = output.walkTopDown().filter { it.isFile && it.extension == "class" }.toList()
    require(compiledClasses.isNotEmpty() || instrumentedClasses.isEmpty()) {
        "Compiler outputs are missing; refusing to remove instrumented classes for $taskName."
    }
    val obsolete = instrumentedClasses.filter { it.relativeTo(output).invariantSeparatorsPath !in compiledClasses }
    obsolete.forEach { file ->
        require(file.canonicalFile.toPath().startsWith(output.toPath()) && !Files.isSymbolicLink(file.toPath())) {
            "Refusing to remove a linked instrumentation output: $file"
        }
        Files.delete(file.toPath())
    }
    return obsolete.size
}

fun descriptorForPlatform(source: String, platformCode: String): String {
    if (platformCode != "PY") return source
    val modularJcefDependency = "<depends>com.intellij.modules.jcef</depends>"
    require(source.split(modularJcefDependency).size == 2) {
        "Expected exactly one modular JCEF dependency in the shared plugin descriptor."
    }
    // JCEF is part of the base 251 platform, not a separately declared plugin.
    // Leave all other dependencies, plugin identity, and registrations intact.
    return source.replace(modularJcefDependency, "")
}

fun validateLocalRuntimeMetadata(info: Map<String, String>, expectedJava: Int, hostOs: String, hostArch: String) {
    val runtimeJava = info["JAVA_VERSION"]?.substringBefore('.')?.toIntOrNull()
    require(runtimeJava == expectedJava) {
        "localRuntimePath contains Java $runtimeJava, but this IDE target requires Java $expectedJava."
    }
    fun normalizedOs(value: String): String = when (value.lowercase(Locale.ROOT)) {
        "mac os x", "macos", "darwin" -> "darwin"
        "linux" -> "linux"
        else -> if (value.startsWith("Windows", ignoreCase = true)) "windows" else value.lowercase(Locale.ROOT)
    }
    fun normalizedArch(value: String): String = when (value.lowercase(Locale.ROOT)) {
        "aarch64", "arm64" -> "arm64"
        "x86_64", "amd64", "x64" -> "amd64"
        else -> value.lowercase(Locale.ROOT)
    }
    require(info["OS_NAME"]?.let(::normalizedOs) == normalizedOs(hostOs)) {
        "localRuntimePath OS '${info["OS_NAME"]}' does not match this build host '$hostOs'."
    }
    require(info["OS_ARCH"]?.let(::normalizedArch) == normalizedArch(hostArch)) {
        "localRuntimePath architecture '${info["OS_ARCH"]}' does not match this build host '$hostArch'."
    }
}

fun validateLocalIdeTarget(
    info: com.google.gson.JsonObject,
    expectedProductCode: String,
    sinceBuild: String,
    untilBuild: String,
    compilerJavaVersion: Int,
    runtimeJavaVersion: Int,
) {
    val productCode = info.get("productCode")?.asString
    require(productCode == expectedProductCode) {
        "localIdePath product '$productCode' does not match platformType '$expectedProductCode'."
    }
    val build = info.get("buildNumber")?.asString.orEmpty()
    val buildParts = parseBuildNumber(build)
    val minimumBuildParts = parseBuildNumber(sinceBuild)
    val maximumBuildParts = parseBuildNumber(untilBuild.removeSuffix(".*"))
    val withinMaximum = if (untilBuild.endsWith(".*")) {
        compareBuildNumbers(buildParts.take(maximumBuildParts.size), maximumBuildParts) <= 0
    } else {
        compareBuildNumbers(buildParts, maximumBuildParts) <= 0
    }
    require(compareBuildNumbers(buildParts, minimumBuildParts) >= 0 && withinMaximum) {
        "localIdePath build '$build' is outside the supported $sinceBuild–$untilBuild platform range."
    }
    // Older product-info files omit this field. Accept only the explicitly
    // supported legacy SDK, not a guessed Java version for any older product.
    val knownLegacyMinimumJava = when {
        productCode == "PY" && buildParts == listOf(251, 25410, 159) && info.get("version")?.asString == "2025.1.1.1" -> 21
        productCode == "IU" && buildParts == listOf(253, 33813, 55) && info.get("version")?.asString == "2025.3.6.1" -> 21
        else -> null
    }
    val minimumJava = info.get("minRequiredJavaVersion")?.takeUnless { it.isJsonNull }?.asInt
        ?: knownLegacyMinimumJava
        ?: throw GradleException("localIdePath does not declare minRequiredJavaVersion and is not an explicitly supported legacy SDK.")
    // Bytecode newer than the IDE's required runtime would install but fail to
    // load. Running Gradle on a newer JDK is fine; compiling newer bytecode is not.
    require(compilerJavaVersion == minimumJava && runtimeJavaVersion >= minimumJava) {
        "localIdePath requires Java $minimumJava; configured compiler is $compilerJavaVersion and Gradle runs on $runtimeJavaVersion."
    }
}

val platformCode = properties("platformType").orElse("PS").get().uppercase(Locale.ROOT)
val selectedPlatformType = resolvePlatformType(platformCode)
val selectedIdeaTarget = resolveIdeaTarget(platformCode, properties("ideaTarget").orNull)
val isIdea253 = selectedIdeaTarget == "2025.3"
// IU 253 already modularizes JCEF, but its callback API is still the old one.
// Descriptor/module selection and callback source selection are independent.
val usesLegacyCefCallbacks = platformCode == "PY" || isIdea253
// Global gradle.properties intentionally continues to describe PS/IU 2026.2.
// Legacy targets cannot inherit its Java 25 bytecode or compatibility range.
// IDEA 2025.3 is deliberately pinned to the user's exact supported SDK.
val selectedPlatformVersion = when {
    isIdea253 -> providers.provider { "2025.3.6.1" }
    platformCode == "PY" -> properties("pycharmPlatformVersion").orElse("2025.1.1.1")
    else -> properties("platformVersion")
}
val selectedSinceBuild = when {
    isIdea253 -> providers.provider { "253.33813.55" }
    platformCode == "PY" -> properties("pycharmSinceBuild").orElse("251.25410.159")
    else -> properties("pluginSinceBuild")
}
val selectedUntilBuild = when {
    isIdea253 -> providers.provider { "253.*" }
    platformCode == "PY" -> properties("pycharmUntilBuild").orElse("251.*")
    else -> properties("pluginUntilBuild")
}
val selectedJavaVersion = when {
    isIdea253 -> providers.provider { "21" }
    platformCode == "PY" -> properties("pycharmJavaVersion").orElse("21")
    else -> properties("javaVersion")
}
val selectedBuildDirectory = when {
    isIdea253 -> "build/idea253"
    platformCode == "IU" -> "build/idea"
    platformCode == "PY" -> "build/pycharm"
    else -> "build"
}
val selectedArchiveClassifier = when {
    isIdea253 -> "idea-2025.3"
    platformCode == "IU" -> "idea"
    platformCode == "PY" -> "pycharm"
    else -> null
}
val localIdePath = providers.gradleProperty("localIdePath").orNull
val localIdeDirectory = localIdePath?.let { file(it).canonicalFile }
val localRuntimeDirectory = providers.gradleProperty("localRuntimePath").orNull?.let { file(it).canonicalFile }

if (localRuntimeDirectory != null) {
    val releaseFile = localRuntimeDirectory.resolve("release")
    val javaExecutable = localRuntimeDirectory.resolve(if (System.getProperty("os.name").startsWith("Windows")) "bin/java.exe" else "bin/java")
    require(releaseFile.isFile && javaExecutable.isFile && javaExecutable.canExecute()) {
        "localRuntimePath must be a runtime home containing release metadata and an executable bin/java: $localRuntimeDirectory"
    }
    val releaseProperties = Properties().apply { releaseFile.inputStream().use { load(it) } }
    val runtimeInfo = releaseProperties.stringPropertyNames().associateWith { releaseProperties.getProperty(it).trim('"') }
    validateLocalRuntimeMetadata(runtimeInfo, selectedJavaVersion.get().toInt(), System.getProperty("os.name"), System.getProperty("os.arch"))
}

if (selectedBuildDirectory != "build") {
    // Separate all outputs/sandbox/verifier reports, not just the final ZIP.
    // This must be set before genPlatform.gradle captures its build paths.
    layout.buildDirectory.set(layout.projectDirectory.dir(selectedBuildDirectory))
}

if (localIdeDirectory != null) {
    val productInfo = listOf(
        localIdeDirectory.resolve("product-info.json"),
        localIdeDirectory.resolve("Resources/product-info.json"),
        localIdeDirectory.resolve("Contents/Resources/product-info.json"),
    ).firstOrNull { it.isFile }
        ?: throw GradleException("No product-info.json found under localIdePath: $localIdeDirectory")
    val info = com.google.gson.JsonParser.parseString(productInfo.readText()).asJsonObject
    validateLocalIdeTarget(
        info,
        platformCode,
        selectedSinceBuild.get(),
        selectedUntilBuild.get(),
        selectedJavaVersion.get().toInt(),
        JavaVersion.current().majorVersion.toInt(),
    )
}

apply("genPlatform.gradle")

// ------------------------------------------------------------
// The 'debugMode' setting controls how plugin resources are prepared during the build process.
// It supports the following three modes:
//
// 1. "idea" — Local development mode (used for debugging VSCode plugin integration)
//    - Copies theme resources from src/main/resources/themes to:
//        ../resources/<vscodePlugin>/src/integrations/theme/default-themes/
//    - Automatically creates a .env file, which the Extension Host (Node.js side) reads at runtime.
//    - Enables the VSCode plugin to load resources from this directory for integration testing.
//    - Typically used when running IntelliJ with an Extension Host for live debugging and hot-reloading.
//
// 2. "release" — Production build mode (used to generate deployment artifacts)
//    - Requires platform.zip to exist, which can be retrieved via git-lfs or generated with genPlatform.gradle.
//    - This file includes the full runtime environment for VSCode plugins (e.g., node_modules, platform.txt).
//    - The zip is extracted to build/platform/, and its node_modules take precedence over other dependencies.
//    - Copies compiled host outputs (dist, package.json, node_modules) and plugin resources.
//    - The result is a fully self-contained package ready for deployment across platforms.
//
// 3. "none" (default) — Lightweight mode (used for testing and CI)
//    - Does not rely on platform.zip or prepare VSCode runtime resources.
//    - Only copies the plugin's core assets such as themes.
//    - Useful for early-stage development, static analysis, unit tests, and continuous integration pipelines.
//
// How to configure:
//   - Set via gradle argument: -PdebugMode=idea / release / none
//     Example: ./gradlew prepareSandbox -PdebugMode=idea
//   - Defaults to "none" if not explicitly set.
// ------------------------------------------------------------
ext {
    set("debugMode", project.findProperty("debugMode") ?: "none")
    set("debugResource", project.projectDir.resolve("../resources").absolutePath)
    set("vscodePlugin", project.findProperty("vscodePlugin") ?: "kilocode")
}

project.afterEvaluate {
    tasks.findByName(":prepareSandbox")?.inputs?.properties?.put("build_mode", ext.get("debugMode") ?: "none")
}

group = properties("pluginGroup").get()
version = properties("pluginVersion").get()

repositories {
    mavenCentral()
    // Fallback mirrors for when Maven Central returns 403 (common in CI environments)
    maven {
        url = uri("https://repo1.maven.org/maven2/")
        content {
            includeGroupByRegex("com\\.squareup.*")
            includeGroupByRegex("com\\.google.*")
        }
    }
    maven {
        url = uri("https://maven-central.storage.googleapis.com/maven2/")
        content {
            includeGroupByRegex("com\\.squareup.*")
            includeGroupByRegex("com\\.google.*")
        }
    }

    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.10.0") {
        // Kotlin is provided by the IDE. OkHttp/Okio otherwise package old stdlib
        // jars that shadow the IDE runtime and break cancellation/stack recovery
        // for coroutines compiled with the current Kotlin compiler.
        exclude(group = "org.jetbrains.kotlin")
    }
    implementation("com.google.code.gson:gson:2.10.1")
    testImplementation("junit:junit:4.13.2")
    intellijPlatform {
        if (localIdeDirectory != null) {
            local(localIdeDirectory)
        } else {
            create(selectedPlatformType, selectedPlatformVersion.get())
        }
        if (localRuntimeDirectory != null) {
            // Cross-OS SDKs are useful for compilation/verifying remote users'
            // builds, but their bundled JVM cannot run on this host. An explicit
            // native JBR override leaves the downloaded SDK itself untouched.
            jetbrainsRuntimeLocal(localRuntimeDirectory.absolutePath)
        }

        bundledPlugin("org.jetbrains.plugins.terminal")
        if (platformCode != "PY") {
            bundledModule("com.intellij.modules.jcef")
        }
        // In 251 JBCefBrowser and CefClient already belong to app-client.jar
        // and lib-client.jar. The separate com.intellij.modules.jcef plugin
        // dependency exists in both the 253 and 262 SDKs.

        // Plugin verifier
        pluginVerifier()

    }
}

// The 2026.2 IDEs need Java 25; the separate 2025.x targets need Java 21.
java {
    sourceCompatibility = JavaVersion.toVersion(selectedJavaVersion.get())
    targetCompatibility = JavaVersion.toVersion(selectedJavaVersion.get())
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(selectedJavaVersion.get().toInt()))
    }
}

kotlin {
    sourceSets.named("main") {
        // New CEF callback classes do not exist in 251 or 253. Compile exactly one
        // thin adapter instead of shipping references that cannot load there.
        kotlin.srcDir(if (usesLegacyCefCallbacks) "src/pycharm/kotlin" else "src/modern/kotlin")
    }
}

// Configure IntelliJ Platform Gradle Plugin 2.x
// Read more: https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin.html
intellijPlatform {
    pluginConfiguration {
        version = properties("pluginVersion")

        ideaVersion {
            sinceBuild = selectedSinceBuild
            untilBuild = selectedUntilBuild
        }
    }

    pluginVerification {
        // This is a deliberately frozen v5 branch. Keep the verifier strict for
        // actual compatibility/packaging failures while reporting legacy API
        // usage without failing an otherwise compatible build.
        failureLevel = listOf(
            VerifyPluginTask.FailureLevel.COMPATIBILITY_PROBLEMS,
            VerifyPluginTask.FailureLevel.MISSING_DEPENDENCIES,
            VerifyPluginTask.FailureLevel.INVALID_PLUGIN,
            VerifyPluginTask.FailureLevel.PLUGIN_STRUCTURE_WARNINGS,
        )

        ides {
            if (localIdeDirectory != null) {
                local(localIdeDirectory)
            } else {
                create(selectedPlatformType, selectedPlatformVersion.get())
            }
        }
    }
}

tasks {
    withType<InstrumentCodeTask>().configureEach {
        doLast {
            // Upstream 2.18.1 overlays incremental changes and can retain orphaned
            // coroutine classes after classpath/output-history changes. Never
            // clear the whole directory: unchanged classes are not regenerated
            // during an incremental invocation.
            val removed = pruneObsoleteInstrumentedClasses(
                layout.buildDirectory.get().asFile,
                outputDirectory.get().asFile,
                name,
                classesDirs.files,
            )
            if (removed > 0) logger.lifecycle("Removed $removed obsolete instrumented classes from $name")
        }
    }

    val pycharmDescriptor = layout.buildDirectory.file("generated/plugin-descriptor/META-INF/plugin.xml")
    val generatePyCharmDescriptor = if (platformCode == "PY") {
        register("generatePyCharmPluginDescriptor") {
            group = "build"
            description = "Adapt the shared descriptor for PyCharm 251 without modifying the source descriptor."
            val sourceDescriptor = layout.projectDirectory.file("src/main/resources/META-INF/plugin.xml")
            inputs.file(sourceDescriptor)
            outputs.file(pycharmDescriptor)
            doLast {
                val destination = pycharmDescriptor.get().asFile
                destination.parentFile.mkdirs()
                destination.writeText(descriptorForPlatform(sourceDescriptor.asFile.readText(), platformCode))
            }
        }
    } else {
        null
    }
    if (generatePyCharmDescriptor != null) {
        named<PatchPluginXmlTask>("patchPluginXml") {
            dependsOn(generatePyCharmDescriptor)
            inputFile.set(pycharmDescriptor)
        }
    }

    buildPlugin {
        if (selectedArchiveClassifier != null) {
            archiveClassifier.set(selectedArchiveClassifier)
        }
    }

    register("verifyBuildTargetConfiguration") {
        group = "verification"
        description = "Check the supported IDE targets and local SDK validation without launching an IDE."
        if (generatePyCharmDescriptor != null) dependsOn(generatePyCharmDescriptor)
        doLast {
            temporaryDir.mkdirs()
            val fixture = Files.createTempDirectory(temporaryDir.toPath(), "instrumentation-check-").toFile()
            try {
                val fixtureBuild = fixture.resolve("build")
                val compiled = fixtureBuild.resolve("classes/kotlin/main").apply { mkdirs() }
                val instrumented = fixtureBuild.resolve("instrumented/instrumentCode").apply { mkdirs() }
                compiled.resolve("Current.class").writeText("compiler")
                instrumented.resolve("Current.class").writeText("instrumented unchanged")
                instrumented.resolve("Obsolete.class").writeText("old coroutine")
                fixtureBuild.resolve("keep.txt").writeText("other build output")
                check(pruneObsoleteInstrumentedClasses(fixtureBuild, instrumented, "instrumentCode", setOf(compiled)) == 1)
                check(instrumented.resolve("Current.class").readText() == "instrumented unchanged")
                check(!instrumented.resolve("Obsolete.class").exists())
                check(fixtureBuild.resolve("keep.txt").readText() == "other build output")
                check(pruneObsoleteInstrumentedClasses(fixtureBuild, instrumented, "instrumentCode", setOf(compiled)) == 0)
                check(runCatching { pruneObsoleteInstrumentedClasses(fixtureBuild, instrumented, "instrumentCode", emptySet()) }.isFailure)
                check(instrumented.resolve("Current.class").exists())
                check(runCatching { checkedInstrumentationOutput(fixtureBuild, fixtureBuild, "instrumentCode") }.isFailure)
                check(runCatching { checkedInstrumentationOutput(fixtureBuild, fixtureBuild.resolve("other"), "instrumentCode") }.isFailure)
                check(runCatching { checkedInstrumentationOutput(fixtureBuild, fixture.resolve("outside"), "instrumentCode") }.isFailure)
                check(runCatching { checkedInstrumentationOutput(fixtureBuild, instrumented, "../instrumentCode") }.isFailure)
            } finally {
                check(fixture.deleteRecursively()) { "Cannot remove instrumentation test fixture: $fixture" }
            }
            check(resolvePlatformType("PS") == IntelliJPlatformType.PhpStorm)
            check(resolvePlatformType("IU") == IntelliJPlatformType.IntellijIdea)
            check(resolvePlatformType("PY") == IntelliJPlatformType.PyCharmProfessional)
            check(runCatching { resolvePlatformType("IC") }.isFailure)
            check(resolveIdeaTarget("PS", null) == null)
            check(resolveIdeaTarget("PY", null) == null)
            check(resolveIdeaTarget("IU", null) == "2026.2")
            check(resolveIdeaTarget("IU", "2026.2") == "2026.2")
            check(resolveIdeaTarget("IU", "2025.3") == "2025.3")
            check(runCatching { resolveIdeaTarget("IU", "2025.1") }.isFailure)
            check(runCatching { resolveIdeaTarget("IU", "") }.isFailure)
            check(runCatching { resolveIdeaTarget("PS", "2025.3") }.isFailure)
            check(runCatching { resolveIdeaTarget("PY", "2025.3") }.isFailure)
            check(runCatching { resolveIdeaTarget("PS", "2026.2") }.isFailure)
            check(runCatching { resolveIdeaTarget("PY", "2026.2") }.isFailure)
            val info = com.google.gson.JsonParser.parseString(
                """{"productCode":"IU","buildNumber":"262.10315.125","minRequiredJavaVersion":25}""",
            ).asJsonObject
            validateLocalIdeTarget(info, "IU", "262", "262.*", 25, 25)
            check(runCatching { validateLocalIdeTarget(info, "PS", "262", "262.*", 25, 25) }.isFailure)
            check(runCatching { validateLocalIdeTarget(info, "IU", "261", "261.*", 25, 25) }.isFailure)
            check(runCatching { validateLocalIdeTarget(info, "IU", "262", "262.*", 21, 25) }.isFailure)
            check(runCatching { validateLocalIdeTarget(info, "IU", "262", "262.*", 25, 21) }.isFailure)
            val idea253Info = com.google.gson.JsonParser.parseString(
                """{"productCode":"IU","version":"2025.3.6.1","buildNumber":"253.33813.55"}""",
            ).asJsonObject
            validateLocalIdeTarget(idea253Info, "IU", "253.33813.55", "253.*", 21, 21)
            validateLocalIdeTarget(idea253Info, "IU", "253.33813.55", "253.*", 21, 25)
            check(runCatching { validateLocalIdeTarget(idea253Info, "PS", "253.33813.55", "253.*", 21, 21) }.isFailure)
            check(runCatching { validateLocalIdeTarget(idea253Info, "IU", "262", "262.*", 21, 25) }.isFailure)
            check(runCatching { validateLocalIdeTarget(info, "IU", "253.33813.55", "253.*", 25, 25) }.isFailure)
            check(runCatching { validateLocalIdeTarget(idea253Info, "IU", "253.33813.55", "253.*", 25, 25) }.isFailure)
            check(runCatching { validateLocalIdeTarget(idea253Info, "IU", "253.33813.55", "253.*", 21, 17) }.isFailure)
            val earlierIdea253Info = idea253Info.deepCopy().apply { addProperty("buildNumber", "253.33813.54") }
            check(runCatching { validateLocalIdeTarget(earlierIdea253Info, "IU", "253.33813.55", "253.*", 21, 21) }.isFailure)
            check(runCatching { validateLocalIdeTarget(earlierIdea253Info, "IU", "253", "253.*", 21, 21) }.isFailure)
            val unknownIdea253Info = idea253Info.deepCopy().apply { addProperty("version", "2025.3.6") }
            check(runCatching { validateLocalIdeTarget(unknownIdea253Info, "IU", "253.33813.55", "253.*", 21, 21) }.isFailure)
            val legacyInfo = com.google.gson.JsonParser.parseString(
                """{"productCode":"PY","version":"2025.1.1.1","buildNumber":"PY-251.25410.159"}""",
            ).asJsonObject
            validateLocalIdeTarget(legacyInfo, "PY", "251.25410.159", "251.*", 21, 21)
            validateLocalIdeTarget(legacyInfo, "PY", "251.25410.159", "251.*", 21, 25)
            check(runCatching { validateLocalIdeTarget(legacyInfo, "PY", "262", "262.*", 21, 25) }.isFailure)
            check(runCatching { validateLocalIdeTarget(legacyInfo, "PY", "251.25410.159", "251.*", 25, 25) }.isFailure)
            check(runCatching { validateLocalIdeTarget(legacyInfo, "PY", "251.25410.159", "251.*", 21, 17) }.isFailure)
            check(runCatching { validateLocalIdeTarget(legacyInfo, "PS", "251", "251.*", 21, 21) }.isFailure)
            val earlierLegacyInfo = legacyInfo.deepCopy().apply { addProperty("buildNumber", "251.25410.100") }
            check(runCatching { validateLocalIdeTarget(earlierLegacyInfo, "PY", "251.25410.159", "251.*", 21, 21) }.isFailure)
            check(runCatching { validateLocalIdeTarget(earlierLegacyInfo, "PY", "251", "251.*", 21, 21) }.isFailure)
            val unknownLegacyInfo = legacyInfo.deepCopy().apply { addProperty("version", "2025.1") }
            check(runCatching { validateLocalIdeTarget(unknownLegacyInfo, "PY", "251", "251.*", 21, 21) }.isFailure)
            val undeclaredModernInfo = info.deepCopy().apply { remove("minRequiredJavaVersion") }
            check(runCatching { validateLocalIdeTarget(undeclaredModernInfo, "IU", "262", "262.*", 25, 25) }.isFailure)
            val nativeRuntime = mapOf("JAVA_VERSION" to "21.0.8", "OS_NAME" to "Darwin", "OS_ARCH" to "aarch64")
            validateLocalRuntimeMetadata(nativeRuntime, 21, "Mac OS X", "arm64")
            check(runCatching { validateLocalRuntimeMetadata(nativeRuntime, 25, "Mac OS X", "arm64") }.isFailure)
            check(runCatching { validateLocalRuntimeMetadata(nativeRuntime, 21, "Linux", "arm64") }.isFailure)
            check(runCatching { validateLocalRuntimeMetadata(nativeRuntime, 21, "Mac OS X", "amd64") }.isFailure)
            check(runCatching { validateLocalRuntimeMetadata(nativeRuntime - "JAVA_VERSION", 21, "Mac OS X", "arm64") }.isFailure)
            validateLocalRuntimeMetadata(mapOf("JAVA_VERSION" to "25", "OS_NAME" to "Linux", "OS_ARCH" to "x86_64"), 25, "Linux", "amd64")
            val expectedOutput = when {
                isIdea253 -> "build/idea253"
                platformCode == "IU" -> "build/idea"
                platformCode == "PY" -> "build/pycharm"
                else -> "build"
            }
            check(layout.buildDirectory.get().asFile == layout.projectDirectory.dir(expectedOutput).asFile)
            val archiveName = (project.tasks.getByName("buildPlugin") as Zip).archiveFileName.get()
            val expectedSuffix = when {
                isIdea253 -> "-idea-2025.3.zip"
                platformCode == "IU" -> "-idea.zip"
                platformCode == "PY" -> "-pycharm.zip"
                else -> "-${project.version}.zip"
            }
            check(archiveName.endsWith(expectedSuffix))
            check(java.sourceCompatibility == JavaVersion.toVersion(selectedJavaVersion.get()))
            check(java.targetCompatibility == JavaVersion.toVersion(selectedJavaVersion.get()))
            val kotlinCompilerOptions = (project.tasks.getByName("compileKotlin") as org.jetbrains.kotlin.gradle.tasks.KotlinCompile).compilerOptions
            check(kotlinCompilerOptions.jvmTarget.get().target == selectedJavaVersion.get())
            if (platformCode == "PY") {
                check(selectedSinceBuild.get().substringBefore('.') == "251")
                check(selectedUntilBuild.get().substringBefore('.') == "251")
                check(selectedJavaVersion.get() == "21")
                check(kotlinCompilerOptions.languageVersion.get() == org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_1)
                check(kotlinCompilerOptions.apiVersion.get() == org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_1)
            }
            if (isIdea253) {
                check(selectedPlatformVersion.get() == "2025.3.6.1")
                check(selectedSinceBuild.get() == "253.33813.55")
                check(selectedUntilBuild.get() == "253.*")
                check(selectedJavaVersion.get() == "21")
                check(kotlinCompilerOptions.languageVersion.get() == org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_2)
                check(kotlinCompilerOptions.apiVersion.get() == org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_2)
            }
            val sourceDescriptor = layout.projectDirectory.file("src/main/resources/META-INF/plugin.xml").asFile.readText()
            val legacyDescriptor = descriptorForPlatform(sourceDescriptor, "PY")
            check(descriptorForPlatform(sourceDescriptor, "PS") == sourceDescriptor)
            check(descriptorForPlatform(sourceDescriptor, "IU") == sourceDescriptor)
            check(!legacyDescriptor.contains("<depends>com.intellij.modules.jcef</depends>"))
            val pluginId = Regex("<id>([^<]+)</id>")
            check(pluginId.find(sourceDescriptor)?.groupValues?.get(1) == "pro.ivol.kilocode5.jetbrains")
            check(pluginId.find(legacyDescriptor)?.value == pluginId.find(sourceDescriptor)?.value)
            check(legacyDescriptor.contains("<depends>com.intellij.modules.platform</depends>"))
            check(legacyDescriptor.contains("<depends>org.jetbrains.plugins.terminal</depends>"))
            check(runCatching { descriptorForPlatform(legacyDescriptor, "PY") }.isFailure)
            check(runCatching { descriptorForPlatform(sourceDescriptor + "<depends>com.intellij.modules.jcef</depends>", "PY") }.isFailure)
            if (platformCode == "PY") {
                check(pycharmDescriptor.get().asFile.readText() == legacyDescriptor)
                check((project.tasks.getByName("patchPluginXml") as PatchPluginXmlTask).inputFile.get().asFile == pycharmDescriptor.get().asFile)
            }
            val kotlinSources = kotlin.sourceSets.getByName("main").kotlin.srcDirs
            val expectedAdapter = file(if (usesLegacyCefCallbacks) "src/pycharm/kotlin" else "src/modern/kotlin")
            val excludedAdapter = file(if (usesLegacyCefCallbacks) "src/modern/kotlin" else "src/pycharm/kotlin")
            check(expectedAdapter in kotlinSources)
            check(excludedAdapter !in kotlinSources)
            println("Build target checks passed: $platformCode, $expectedOutput/distributions/$archiveName")
        }
    }

    // Configure test task to disable CDS (Class Data Sharing) to avoid warning:
    // "Archived non-system classes are disabled because the java.system.class.loader
    // property is specified (value = "com.intellij.util.lang.PathClassLoader")"
    //
    // IntelliJ Platform uses a custom PathClassLoader which conflicts with CDS's
    // archived non-system classes feature. Disabling CDS for tests eliminates the
    // warning while maintaining test functionality. Production builds are unaffected.
    withType<Test> {
        jvmArgs("-Xshare:off")
    }

    // Create task for generating configuration files
    register("generateConfigProperties") {
        description = "Generate properties file containing plugin configuration"
        doLast {
            val configDir = File("$projectDir/src/main/resources/ai/kilocode/jetbrains/plugin/config")
            configDir.mkdirs()

            val configFile = File(configDir, "plugin.properties")
            configFile.writeText("debug.mode=${ext.get("debugMode")}")
            configFile.appendText("\n")
            configFile.appendText("debug.resource=${ext.get("debugResource")}")
            println("Configuration file generated: ${configFile.absolutePath}")
        }
    }

    prepareSandbox {
        dependsOn("generateConfigProperties")
        duplicatesStrategy = DuplicatesStrategy.INCLUDE

        if (ext.get("debugMode") == "idea") {
            from("${project.projectDir.absolutePath}/src/main/resources/themes/") {
                into("${ext.get("debugResource")}/${ext.get("vscodePlugin")}/integrations/theme/default-themes/")
            }
            doLast {
                val vscodePluginDir = File("${ext.get("debugResource")}/${ext.get("vscodePlugin")}")
                vscodePluginDir.mkdirs()
                File(vscodePluginDir, ".env").createNewFile()
            }
        } else if (ext.get("debugMode") != "none") {
            // A target can bundle a freshly unpacked VSIX without changing the
            // shared staging directory used by another IDE build.
            val bundledExtensionDir = providers.gradleProperty("bundledExtensionPath").orNull
                ?.let { file(it).canonicalFile }
                ?: File("./plugins/${ext.get("vscodePlugin")}/extension")
            doFirst {
                // Validate required files exist
                if (!bundledExtensionDir.isDirectory) {
                    throw IllegalStateException("missing bundled extension dir: ${bundledExtensionDir.absolutePath}")
                }
                if (ext.get("debugMode") == "release" && !bundledExtensionDir.resolve("package.json").isFile) {
                    throw IllegalStateException("missing bundled extension package.json: ${bundledExtensionDir.absolutePath}")
                }
                val depfile = File("prodDep.txt")
                if (!depfile.exists()) {
                    throw IllegalStateException("missing prodDep.txt")
                }

                // Handle platform.zip for release mode
                if (ext.get("debugMode") == "release") {
                    val platformZip = project.findProperty("platformZipPath")
                        ?.toString()
                        ?.let(::File)
                        ?: File("platform.zip")
                    if (!platformZip.exists() || platformZip.length() < 1024 * 1024) {
                        throw IllegalStateException("platform.zip file does not exist or is smaller than 1MB: ${platformZip.absolutePath}")
                    }

                    // Extract platform.zip to the platform subdirectory under the project build directory
                    val platformDir = File("${layout.buildDirectory.get().asFile}/platform")
                    platformDir.mkdirs()
                    copy {
                        from(zipTree(platformZip))
                        into(platformDir)
                    }
                }
            }

            val depfile = File("prodDep.txt")
            val list = mutableListOf<String>()

            // Read dependencies during execution
            doFirst {
                depfile.readLines().forEach { line ->
                    list.add(line.substringAfterLast("node_modules/") + "/**")
                }
            }

            // PrepareSandbox already creates the actual plugin directory using
            // rootProject.name. Runtime resources must be copied into that same
            // directory so both runIde and the distributable ZIP see them.
            val pluginSandboxDirName = rootProject.name

            // Copy host runtime files
            from("../host/dist") { into("$pluginSandboxDirName/runtime/") }
            from("../host/package.json") { into("$pluginSandboxDirName/runtime/") }

            // Copy host node_modules based on prodDep.txt
            from("../resources/node_modules") {
                into("$pluginSandboxDirName/node_modules/")
                doFirst {
                    list.forEach {
                        include(it)
                    }
                }
            }

            // Copy VSCode plugin extension
            from(bundledExtensionDir) { into("$pluginSandboxDirName/${ext.get("vscodePlugin")}") }

            // Copy themes
            from("src/main/resources/themes/") {
                into("$pluginSandboxDirName/${ext.get("vscodePlugin")}/integrations/theme/default-themes/")
            }

            // Copy platform files for release mode
            if (ext.get("debugMode") == "release") {
                val platformDir = File("${layout.buildDirectory.get().asFile}/platform")
                from(File(platformDir, "platform.txt")) { into("$pluginSandboxDirName/") }
                // Copy platform node_modules last to ensure it takes precedence over host node_modules
                from(File(platformDir, "node_modules")) { into("$pluginSandboxDirName/node_modules") }
            }

            doLast {
                File("$destinationDir/$pluginSandboxDirName/${ext.get("vscodePlugin")}/.env").apply {
                    parentFile.mkdirs()
                    createNewFile()
                }
            }
        }
    }

    // Generate configuration file before compilation
    withType<JavaCompile> {
        dependsOn("generateConfigProperties")
    }

    // Set the JVM compatibility versions
    withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
        dependsOn("generateConfigProperties")
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.fromTarget(selectedJavaVersion.get()))
            if (platformCode == "PY") {
                // The 251 SDK supplies Kotlin 2.1; do not emit calls to newer
                // stdlib APIs merely because the build compiler is newer.
                languageVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_1)
                apiVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_1)
            } else if (isIdea253) {
                // The 253 platform supplies Kotlin 2.2, not the 262 stdlib.
                languageVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_2)
                apiVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_2)
            }
        }
    }

    withType<JavaCompile> {
        sourceCompatibility = selectedJavaVersion.get()
        targetCompatibility = selectedJavaVersion.get()
    }

    signPlugin {
        certificateChain.set(System.getenv("CERTIFICATE_CHAIN"))
        privateKey.set(System.getenv("PRIVATE_KEY"))
        password.set(System.getenv("PRIVATE_KEY_PASSWORD"))
    }

    publishPlugin {
        token.set(System.getenv("PUBLISH_TOKEN"))
    }

    // Convert the extension's JSON translation files to JetBrains ResourceBundle .properties format
    register("convertTranslations") {
        description = "Convert JSON translation files to the native ResourceBundle .properties format"

        val sourceDir = file("../../src/i18n/locales")
        val targetDir = file("src/main/resources/messages")

        inputs.dir(sourceDir)
        outputs.dir(targetDir)

        doLast {
            if (!sourceDir.exists()) {
                throw IllegalStateException("Source translation directory not found: ${sourceDir.absolutePath}")
            }

            targetDir.mkdirs()

            // Find all JSON bundles (jetbrains.json, kilocode.json, etc.)
            val jsonBundles = mutableSetOf<String>()
            sourceDir.listFiles()?.forEach { localeDir ->
                if (localeDir.isDirectory) {
                    localeDir.listFiles { file -> file.extension == "json" }?.forEach { jsonFile ->
                        jsonBundles.add(jsonFile.nameWithoutExtension)
                    }
                }
            }
            println("Found translation bundles: ${jsonBundles.joinToString(", ")}")

            jsonBundles.forEach { bundleName ->
                convertBundleToProperties(sourceDir, targetDir, bundleName)
            }
            println("Converted ${jsonBundles.size} translation bundles to ResourceBundle .properties format")
        }
    }

    named("processResources") {
        dependsOn("convertTranslations")
    }
}

// Helper function to convert JSON bundle to .properties files
fun convertBundleToProperties(sourceDir: File, targetDir: File, bundleName: String) {
    val gson = com.google.gson.Gson()

    sourceDir.listFiles()?.forEach { localeDir ->
        if (localeDir.isDirectory) {
            val jsonFile = File(localeDir, "$bundleName.json")
            if (jsonFile.exists()) {
                try {
                    val locale = localeDir.name
                    val capitalizedBundleName = bundleName.replaceFirstChar { it.uppercase() }

                    // Determine properties file name
                    val propertiesFileName = if (locale == "en") {
                        "${capitalizedBundleName}Bundle.properties"
                    } else {
                        "${capitalizedBundleName}Bundle_${locale.replace("-", "_")}.properties"
                    }

                    val propertiesFile = File(targetDir, propertiesFileName)

                    // Parse JSON
                    val jsonContent = jsonFile.readText()
                    val jsonObject = gson.fromJson(jsonContent, com.google.gson.JsonObject::class.java)

                    // Convert to flat properties
                    val properties = mutableMapOf<String, String>()
                    flattenJsonObject(jsonObject, "", properties)

                    // Write properties file
                    propertiesFile.writeText("# Auto-generated from $bundleName.json - do not edit directly\n")
                    properties.toSortedMap().forEach { (key, value) ->
                        // Keep named parameters as {{paramName}} for Kotlin named substitution
                        val escapedValue = value
                            .replace("\\", "\\\\")
                            .replace("\n", "\\n")
                            .replace("\r", "\\r")
                            .replace("\t", "\\t")
                            .replace("=", "\\=")
                            .replace(":", "\\:")
                            .replace("#", "\\#")
                            .replace("!", "\\!")

                        propertiesFile.appendText("$key=$escapedValue\n")
                    }

                    println("  → $locale: ${properties.size} keys → $propertiesFileName")
                } catch (e: Exception) {
                    throw RuntimeException("Failed to convert $jsonFile", e)
                }
            }
        }
    }
}

// Helper function to flatten nested JSON objects into dot-notation keys
fun flattenJsonObject(jsonObject: com.google.gson.JsonObject, prefix: String, properties: MutableMap<String, String>) {
    for (entry in jsonObject.entrySet()) {
        val key = entry.key
        val element = entry.value
        val fullKey = if (prefix.isEmpty()) key else "$prefix.$key"

        when {
            element.isJsonObject -> {
                flattenJsonObject(element.asJsonObject, fullKey, properties)
            }
            element.isJsonPrimitive -> {
                properties[fullKey] = element.asString
            }
            else -> {
                // Skip arrays and other complex types for now
                println("  Warning: Skipping complex type for key: $fullKey")
            }
        }
    }
}

// Configure ktlint
ktlint {
    version.set("1.5.0")
    debug.set(false)
    verbose.set(true)
    android.set(false)
    outputToConsole.set(true)
    outputColorName.set("RED")
    ignoreFailures.set(true)
    enableExperimentalRules.set(false)
    filter {
        exclude("**/generated/**")
        include("**/kotlin/**")
    }
}
