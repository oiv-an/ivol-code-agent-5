package ai.kilocode.jetbrains.core

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

class ExtensionManagerTest {
    private lateinit var extensionDirectory: Path

    @Before
    fun setUp() {
        extensionDirectory = Files.createTempDirectory("ivol-jetbrains-extension")
    }

    @After
    fun tearDown() {
        extensionDirectory.toFile().deleteRecursively()
    }

    @Test
    fun testMarketplaceNameDoesNotChangeJetBrainsRuntimeIdentity() {
        Files.writeString(
            extensionDirectory.resolve("package.json"),
            """
            {
              "name": "ivol-code-agent-5",
              "displayName": "IVOL Code Agent 5",
              "publisher": "ivol",
              "version": "5.16.216",
              "main": "./dist/extension.js"
            }
            """.trimIndent(),
        )

        val manager = ExtensionManager()
        try {
            val description = manager.registerExtension(extensionDirectory.toString())

            assertEquals("Kilo Code.kilo-code", description.id)
            assertEquals("Kilo Code.kilo-code", description.identifier.value)
            assertEquals("Kilo Code.kilo-code", description.name)
            assertEquals("Kilo Code", description.publisher)
            assertEquals("IVOL Code Agent 5", description.displayName)
            assertEquals("5.16.216", description.version)
        } finally {
            manager.dispose()
        }
    }
}
