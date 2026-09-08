package ai.kilocode.jetbrains.plugin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.IOException
import java.net.URI
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption.CREATE
import java.nio.file.StandardOpenOption.WRITE
import java.nio.file.attribute.FileTime
import java.nio.file.attribute.PosixFileAttributeView
import java.nio.file.attribute.PosixFilePermission.OWNER_EXECUTE
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class PlatformFileInitializerTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    private val suffix = "darwin-arm64"
    private val entry = "@parcel/watcher/build/Release/watcher.node"

    @Test
    fun `initialization preserves manifest and packaged source and sets executable permission`() {
        val root = fixture()
        initialize(root)
        assertEquals("native payload", Files.readString(target(root)))
        assertEquals("native payload", Files.readString(source(root)))
        assertEquals(entry, Files.readString(root.resolve("platform.txt")))
        assertTrue(Files.isExecutable(target(root)))
        assertNoStagingFiles(root)
    }

    @Test
    fun `repeated initialization does not replace an identical live library`() {
        val root = fixture()
        initialize(root)
        val oldTime = FileTime.fromMillis(1_000_000)
        Files.setLastModifiedTime(target(root), oldTime)
        repeat(3) { initialize(root) }
        assertEquals(oldTime, Files.getLastModifiedTime(target(root)))
        assertTrue(Files.exists(source(root)))
    }

    @Test
    fun `concurrent project initializations cannot consume or delete shared libraries`() {
        val root = fixture()
        val executor = Executors.newFixedThreadPool(12)
        val gate = CountDownLatch(1)
        try {
            val results = (1..36).map {
                executor.submit(Callable {
                    gate.await()
                    initialize(root)
                })
            }
            gate.countDown()
            results.forEach { it.get(20, TimeUnit.SECONDS) }
        } finally {
            executor.shutdownNow()
        }
        assertEquals("native payload", Files.readString(target(root)))
        assertEquals("native payload", Files.readString(source(root)))
        assertNoStagingFiles(root)
    }

    @Test
    fun `initialization waits for an installation lock held by another IDE process`() {
        val root = fixture()
        val classPath = listOf(
            PlatformFileInitializer::class.java,
            PlatformInitializationProcess::class.java,
            Unit::class.java,
        ).map(::classPathEntry)
            .distinct().joinToString(java.io.File.pathSeparator)
        val javaName = if (System.getProperty("os.name").startsWith("Windows")) "java.exe" else "java"
        val executable = Path.of(System.getProperty("java.home"), "bin", javaName)
        val executor = Executors.newSingleThreadExecutor()
        var process: Process? = null
        try {
            FileChannel.open(root.resolve(".ivol-platform-init.lock"), CREATE, WRITE).use { channel ->
                channel.lock().use {
                    val child = ProcessBuilder(
                        executable.toString(), "-cp", classPath,
                        PlatformInitializationProcess::class.java.name, root.toString(), suffix,
                    ).redirectErrorStream(true).start()
                    process = child
                    val output = child.inputStream.bufferedReader()
                    assertEquals("ready", executor.submit(Callable { output.readLine() }).get(20, TimeUnit.SECONDS))
                    assertFalse("Child bypassed the installation lock", child.waitFor(300, TimeUnit.MILLISECONDS))
                    assertFalse(Files.exists(target(root)))
                }
            }
            assertTrue("Child failed to finish after lock release", process!!.waitFor(20, TimeUnit.SECONDS))
            assertEquals(0, process!!.exitValue())
            assertEquals("native payload", Files.readString(target(root)))
            assertTrue(Files.exists(source(root)))
        } finally {
            process?.destroyForcibly()
            executor.shutdownNow()
        }
    }

    @Test
    fun `missing destination is repaired on a later initialization`() {
        val root = fixture()
        initialize(root)
        Files.delete(target(root))
        initialize(root)
        assertEquals("native payload", Files.readString(target(root)))
    }

    @Test
    fun `legacy installation with consumed source and valid target remains usable`() {
        val root = fixture()
        Files.move(source(root), target(root))
        initialize(root)
        assertEquals("native payload", Files.readString(target(root)))
        assertTrue(Files.exists(root.resolve("platform.txt")))
    }

    @Test
    fun `legacy installation without marker is left unchanged`() {
        val root = fixture()
        Files.move(source(root), target(root))
        Files.delete(root.resolve("platform.txt"))
        initialize(root)
        assertEquals("native payload", Files.readString(target(root)))
        assertFalse(Files.exists(root.resolve("platform.txt")))
    }

    @Test
    fun `secondary platform copy recovers a consumed source and missing target`() {
        val root = fixture()
        val recovery = root.resolve("node_modules/native-modules/$suffix/$entry")
        Files.createDirectories(recovery.parent)
        Files.move(source(root), recovery)
        initialize(root)
        assertEquals("native payload", Files.readString(target(root)))
        assertEquals("native payload", Files.readString(recovery))
    }

    @Test
    fun `secondary platform copy can recreate a missing target directory`() {
        val root = fixture()
        val recovery = root.resolve("node_modules/native-modules/$suffix/$entry")
        Files.createDirectories(recovery.parent)
        Files.move(source(root), recovery)
        Files.delete(target(root).parent)
        initialize(root)
        assertEquals("native payload", Files.readString(target(root)))
    }

    @Test
    fun `incomplete package fails explicitly and keeps existing libraries untouched`() {
        val root = fixture()
        Files.writeString(target(root), "working old payload")
        Files.writeString(root.resolve("platform.txt"), "$entry\nmissing/build/module.node")
        val failure = runCatching { initialize(root) }.exceptionOrNull()
        assertTrue(failure is IOException)
        assertTrue(failure!!.message!!.contains("Reinstall the plugin archive"))
        assertEquals("working old payload", Files.readString(target(root)))
        assertEquals("native payload", Files.readString(source(root)))
    }

    @Test
    fun `failed atomic publication preserves working target and cleans staged file`() {
        val root = fixture()
        Files.writeString(target(root), "working old payload")
        val expected = IOException("atomic replacement rejected")
        val failure = runCatching {
            PlatformFileInitializer.installFile(source(root), target(root)) { staged, destination ->
                assertEquals("native payload", Files.readString(staged))
                assertEquals("working old payload", Files.readString(destination))
                throw expected
            }
        }.exceptionOrNull()
        assertEquals(expected, failure)
        assertEquals("working old payload", Files.readString(target(root)))
        assertEquals("native payload", Files.readString(source(root)))
        assertNoStagingFiles(root)
    }

    @Test
    fun `copy failure cannot remove a working destination`() {
        val root = fixture()
        Files.writeString(target(root), "working old payload")
        val failure = runCatching {
            PlatformFileInitializer.installFile(source(root).resolveSibling("absent.node"), target(root))
        }.exceptionOrNull()
        assertTrue(failure is IOException)
        assertEquals("working old payload", Files.readString(target(root)))
        assertNoStagingFiles(root)
    }

    @Test
    fun `matching library has executable permission repaired without content replacement`() {
        val root = fixture()
        initialize(root)
        val view = Files.getFileAttributeView(target(root), PosixFileAttributeView::class.java) ?: return
        view.setPermissions(view.readAttributes().permissions() - OWNER_EXECUTE)
        val oldTime = FileTime.fromMillis(1_000_000)
        Files.setLastModifiedTime(target(root), oldTime)
        initialize(root)
        assertTrue(OWNER_EXECUTE in view.readAttributes().permissions())
        assertEquals(oldTime, Files.getLastModifiedTime(target(root)))
    }

    @Test
    fun `unsafe manifest paths are rejected before any existing target changes`() {
        for (unsafe in listOf("../outside.node", "/tmp/outside.node", "C:/outside.node", "..\\outside.node", "nested/../outside.node")) {
            val root = fixture()
            Files.writeString(target(root), "working old payload")
            Files.writeString(root.resolve("platform.txt"), "$entry\n$unsafe")
            assertTrue(runCatching { initialize(root) }.exceptionOrNull() is IllegalArgumentException)
            assertEquals("working old payload", Files.readString(target(root)))
        }
    }

    @Test
    fun `symbolic link target cannot redirect native module writes`() {
        val root = fixture()
        val outside = temporaryFolder.newFile("outside.node").toPath()
        Files.writeString(outside, "outside content")
        Files.createSymbolicLink(target(root), outside)
        assertTrue(runCatching { initialize(root) }.exceptionOrNull() is IllegalArgumentException)
        assertEquals("outside content", Files.readString(outside))
        assertTrue(Files.isSymbolicLink(target(root)))
    }

    @Test
    fun `blank lines comments and duplicate entries do not alter manifest`() {
        val root = fixture()
        val manifest = "# native files\n\n $entry \n$entry\n"
        Files.writeString(root.resolve("platform.txt"), manifest)
        initialize(root)
        assertEquals(manifest, Files.readString(root.resolve("platform.txt")))
        assertEquals("native payload", Files.readString(target(root)))
    }

    private fun fixture(): Path = temporaryFolder.newFolder().toPath().also { root ->
        Files.createDirectories(target(root).parent)
        Files.writeString(root.resolve("platform.txt"), entry)
        Files.writeString(source(root), "native payload")
    }

    private fun initialize(root: Path) = PlatformFileInitializer.initialize(root, suffix)

    private fun target(root: Path): Path = root.resolve("node_modules/$entry")

    private fun source(root: Path): Path = root.resolve("node_modules/$entry$suffix")

    private fun assertNoStagingFiles(root: Path) {
        Files.walk(root).use { paths ->
            assertFalse(paths.anyMatch { it.fileName.toString().startsWith(".ivol-native-") })
        }
    }

    private fun classPathEntry(type: Class<*>): String {
        type.protectionDomain?.codeSource?.location?.let { return Path.of(it.toURI()).toString() }
        // The IDE's instrumented test class loader can have a CodeSource with no location.
        val name = "${type.name.replace('.', '/')}.class"
        val resource = requireNotNull(type.getResource("/$name")) { "Missing class resource: $name" }
        if (resource.protocol == "jar") {
            // IntelliJ installs its own jar handler, not java.net.JarURLConnection.
            val jarUri = resource.toExternalForm().removePrefix("jar:").substringBefore("!/")
            return Path.of(URI.create(jarUri)).toString()
        }
        require(resource.protocol == "file") { "Unsupported test class resource: $resource" }
        var root = Path.of(resource.toURI())
        repeat(name.split('/').size) { root = root.parent }
        return root.toString()
    }
}

/** Separate JVM entrypoint: exercises the same lock used by independent IDE processes. */
object PlatformInitializationProcess {
    @JvmStatic
    fun main(args: Array<String>) {
        println("ready")
        PlatformFileInitializer.initialize(Path.of(args[0]), args[1])
    }
}
