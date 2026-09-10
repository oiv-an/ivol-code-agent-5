package ai.kilocode.jetbrains.actors

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DialogDefaultPathTest {
    private fun portablePath(components: Map<String, String?>): String? = resolveDialogDefaultPath(components)?.replace('\\', '/')

    @Test
    fun `windows drive URI loses its leading URI slash before native path parsing`() {
        assertEquals(
            "c:/Users/Иван/Downloads/Search result.md",
            portablePath(mapOf("scheme" to "file", "path" to "/C:/Users/Иван/Downloads/Search result.md")),
        )
    }

    @Test
    fun `UNC authority remains part of the native path`() {
        assertEquals(
            "//fileserver/shared folder/Search result.md",
            portablePath(
                mapOf("scheme" to "file", "authority" to "fileserver", "path" to "/shared folder/Search result.md"),
            ),
        )
    }

    @Test
    fun `decoded local paths preserve spaces unicode and literal percent and hash characters`() {
        assertEquals(
            "/Users/Иван/Downloads/100% # поиск.md",
            portablePath(mapOf("scheme" to "file", "path" to "/Users/Иван/Downloads/100% # поиск.md")),
        )
    }

    @Test
    fun `missing and nonfile defaults leave the native chooser location unspecified`() {
        assertNull(resolveDialogDefaultPath(null))
        assertNull(resolveDialogDefaultPath(emptyMap()))
        assertNull(resolveDialogDefaultPath(mapOf("scheme" to "file", "path" to "")))
        assertNull(resolveDialogDefaultPath(mapOf("scheme" to "https", "path" to "/result.md")))
    }
}
