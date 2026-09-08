// Copyright 2009-2025 Weibo, Inc.
// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: APACHE2.0
// SPDX-License-Identifier: Apache-2.0

import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask
import java.util.Locale

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
// unified IU product, not the discontinued separate Community target.
fun resolvePlatformType(code: String): IntelliJPlatformType = when (code) {
    "PS" -> IntelliJPlatformType.PhpStorm
    "IU" -> IntelliJPlatformType.IntellijIdea
    else -> throw GradleException("Unsupported platformType '$code': use PS (PhpStorm) or IU (IntelliJ IDEA).")
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
    val branch = build.substringAfterLast('-').substringBefore('.').toIntOrNull()
    val firstBranch = sinceBuild.substringBefore('.').toInt()
    val lastBranch = untilBuild.substringBefore('.').toInt()
    require(branch != null && branch in firstBranch..lastBranch) {
        "localIdePath build '$build' is outside the supported $sinceBuild–$untilBuild platform range."
    }
    val minimumJava = info.get("minRequiredJavaVersion")?.asInt
    require(minimumJava != null && compilerJavaVersion >= minimumJava && runtimeJavaVersion >= minimumJava) {
        "localIdePath requires Java $minimumJava; configured compiler is $compilerJavaVersion and Gradle runs on $runtimeJavaVersion."
    }
}

val platformCode = properties("platformType").orElse("PS").get().uppercase(Locale.ROOT)
val selectedPlatformType = resolvePlatformType(platformCode)
val localIdePath = providers.gradleProperty("localIdePath").orNull
val localIdeDirectory = localIdePath?.let { file(it).canonicalFile }

if (platformCode == "IU") {
    // Separate all outputs/sandbox/verifier reports, not just the final ZIP.
    // This must be set before genPlatform.gradle captures its build paths.
    layout.buildDirectory.set(layout.projectDirectory.dir("build/idea"))
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
        properties("pluginSinceBuild").get(),
        properties("pluginUntilBuild").get(),
        properties("javaVersion").get().toInt(),
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
            create(selectedPlatformType, properties("platformVersion").get())
        }

        bundledPlugin("org.jetbrains.plugins.terminal")
        bundledModule("com.intellij.modules.jcef")

        // Plugin verifier
        pluginVerifier()

    }
}

// Both supported 2026.2 IDE targets run on Java 25.
java {
    sourceCompatibility = JavaVersion.VERSION_25
    targetCompatibility = JavaVersion.VERSION_25
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(properties("javaVersion").get().toInt()))
    }
}

// Configure IntelliJ Platform Gradle Plugin 2.x
// Read more: https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin.html
intellijPlatform {
    pluginConfiguration {
        version = properties("pluginVersion")

        ideaVersion {
            sinceBuild = properties("pluginSinceBuild")
            untilBuild = properties("pluginUntilBuild")
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
                create(selectedPlatformType, properties("platformVersion").get())
            }
        }
    }
}

tasks {
    buildPlugin {
        if (platformCode == "IU") {
            archiveClassifier.set("idea")
        }
    }

    register("verifyBuildTargetConfiguration") {
        group = "verification"
        description = "Check the supported IDE targets and local SDK validation without launching an IDE."
        doLast {
            check(resolvePlatformType("PS") == IntelliJPlatformType.PhpStorm)
            check(resolvePlatformType("IU") == IntelliJPlatformType.IntellijIdea)
            check(runCatching { resolvePlatformType("IC") }.isFailure)
            val info = com.google.gson.JsonParser.parseString(
                """{"productCode":"IU","buildNumber":"262.10315.125","minRequiredJavaVersion":25}""",
            ).asJsonObject
            validateLocalIdeTarget(info, "IU", "262", "262.*", 25, 25)
            check(runCatching { validateLocalIdeTarget(info, "PS", "262", "262.*", 25, 25) }.isFailure)
            check(runCatching { validateLocalIdeTarget(info, "IU", "261", "261.*", 25, 25) }.isFailure)
            check(runCatching { validateLocalIdeTarget(info, "IU", "262", "262.*", 21, 25) }.isFailure)
            check(runCatching { validateLocalIdeTarget(info, "IU", "262", "262.*", 25, 21) }.isFailure)
            val expectedOutput = if (platformCode == "IU") "build/idea" else "build"
            check(layout.buildDirectory.get().asFile == layout.projectDirectory.dir(expectedOutput).asFile)
            val archiveName = (project.tasks.getByName("buildPlugin") as Zip).archiveFileName.get()
            check(archiveName.endsWith(if (platformCode == "IU") "-idea.zip" else "-${project.version}.zip"))
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
            doFirst {
                // Validate required files exist
                val vscodePluginDir = File("./plugins/${ext.get("vscodePlugin")}")
                if (!vscodePluginDir.exists()) {
                    throw IllegalStateException("missing plugin dir: ${vscodePluginDir.absolutePath}")
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

            val vscodePluginDir = File("./plugins/${ext.get("vscodePlugin")}")
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
            from("${vscodePluginDir.path}/extension") { into("$pluginSandboxDirName/${ext.get("vscodePlugin")}") }

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
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_25)
        }
    }

    withType<JavaCompile> {
        sourceCompatibility = properties("javaVersion").get()
        targetCompatibility = properties("javaVersion").get()
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
    version.set("0.50.0")
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
