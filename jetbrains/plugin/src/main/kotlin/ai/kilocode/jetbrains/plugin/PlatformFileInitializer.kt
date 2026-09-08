package ai.kilocode.jetbrains.plugin

import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.COPY_ATTRIBUTES
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.StandardOpenOption.CREATE
import java.nio.file.StandardOpenOption.WRITE
import java.nio.file.attribute.PosixFileAttributeView
import java.nio.file.attribute.PosixFilePermission.OWNER_EXECUTE

/** Shared by all projects; packaged sources remain available for retries and repairs. */
internal object PlatformFileInitializer {
    private val monitor = Any()
    private val supportedSuffixes = setOf("darwin-arm64", "darwin-x64", "linux-x64", "windows-x64")

    fun initialize(pluginDir: Path, platformSuffix: String) {
        require(platformSuffix in supportedSuffixes) { "Unsupported native platform: $platformSuffix" }
        synchronized(monitor) {
            val root = pluginDir.toRealPath()
            val manifest = root.resolve("platform.txt")
            // Older releases removed this marker after preparing the installation.
            if (!Files.exists(manifest, NOFOLLOW_LINKS)) return
            requireRegularFile(manifest)
            // Keep the lock file: deleting it would let another process lock a different inode.
            FileChannel.open(root.resolve(".ivol-platform-init.lock"), CREATE, WRITE, NOFOLLOW_LINKS).use { channel ->
                channel.lock().use {
                    prepare(root, manifest, platformSuffix)
                }
            }
        }
    }

    private fun prepare(root: Path, manifest: Path, suffix: String) {
        val modules = root.resolve("node_modules")
        require(Files.isDirectory(modules, NOFOLLOW_LINKS)) { "Missing native module directory: $modules" }
        // Validate the whole manifest before publishing any file.
        val targets = Files.readAllLines(manifest).map(String::trim)
            .filter { it.isNotEmpty() && !it.startsWith("#") }
            .distinct()
            .map { entry ->
                require(!entry.contains('\\') && !entry.contains(':')) { "Invalid native module path: $entry" }
                val relative = Path.of(entry)
                require(!relative.isAbsolute && relative.none { it.toString() == ".." || it.toString() == "." }) {
                    "Invalid native module path: $entry"
                }
                val target = modules.resolve(relative)
                val source = target.resolveSibling("${target.fileName}$suffix")
                // This exact layout is also included in our platform payload.
                val recovery = modules.resolve("native-modules").resolve(suffix).resolve(relative)
                listOf(target, source, recovery).forEach { validateContainedPath(modules, it) }
                val availableSource = when {
                    Files.exists(source, NOFOLLOW_LINKS) -> source.also(::requireRegularFile)
                    Files.exists(recovery, NOFOLLOW_LINKS) -> recovery.also(::requireRegularFile)
                    else -> null
                }
                if (Files.exists(target, NOFOLLOW_LINKS)) requireRegularFile(target)
                if (availableSource == null && !Files.isRegularFile(target, NOFOLLOW_LINKS)) {
                    throw IOException("Native module is missing for $suffix: $entry. Reinstall the plugin archive.")
                }
                availableSource to target
            }

        targets.forEach { (source, target) ->
            if (source == null || (Files.isRegularFile(target, NOFOLLOW_LINKS) && Files.mismatch(source, target) == -1L)) {
                // Avoid replacing a library already loaded by another project/process.
                ensureExecutable(target)
            } else {
                installFile(source, target)
            }
        }
    }

    private fun validateContainedPath(modules: Path, path: Path) {
        require(path.normalize().startsWith(modules)) { "Native module path escapes installation: $path" }
        var current = modules
        for (part in modules.relativize(path)) {
            current = current.resolve(part)
            require(!Files.isSymbolicLink(current)) { "Native module path contains a symbolic link: $current" }
        }
    }

    private fun requireRegularFile(path: Path) {
        require(Files.isRegularFile(path, NOFOLLOW_LINKS)) { "Native module is not a regular file: $path" }
    }

    private fun ensureExecutable(path: Path) {
        val posix = Files.getFileAttributeView(path, PosixFileAttributeView::class.java, NOFOLLOW_LINKS)
        if (posix != null) {
            val permissions = posix.readAttributes().permissions()
            if (OWNER_EXECUTE !in permissions) posix.setPermissions(permissions + OWNER_EXECUTE)
        } else if (!Files.isExecutable(path) && !path.toFile().setExecutable(true, true)) {
            throw IOException("Cannot enable executable permission for native module: $path")
        }
    }

    /** No truncate/delete of the live target, even when copying or atomic publication fails. */
    internal fun installFile(
        source: Path,
        target: Path,
        publish: (Path, Path) -> Unit = { staged, destination ->
            Files.move(staged, destination, ATOMIC_MOVE, REPLACE_EXISTING)
        },
    ) {
        Files.createDirectories(target.parent)
        val staged = Files.createTempFile(target.parent, ".ivol-native-", ".tmp")
        try {
            Files.copy(source, staged, COPY_ATTRIBUTES, REPLACE_EXISTING)
            ensureExecutable(staged)
            publish(staged, target)
        } finally {
            Files.deleteIfExists(staged)
        }
    }
}
