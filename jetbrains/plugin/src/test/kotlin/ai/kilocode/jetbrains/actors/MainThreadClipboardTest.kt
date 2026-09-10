package ai.kilocode.jetbrains.actors

import kotlinx.coroutines.CancellationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test
import java.awt.datatransfer.Clipboard

class MainThreadClipboardTest {
    @Test
    fun `copies a diagnostic verbatim using an isolated in-memory clipboard`() {
        val clipboard = Clipboard("isolated test clipboard")
        val handler = MainThreadClipboard { clipboard }
        val report = "IVOL provider diagnostic\nМодель: тест\nHTTP status: 401\n[redacted]"

        handler.writeText(report)

        assertEquals(report, handler.readText())
    }

    @Test
    fun `an empty report clears text while null does not overwrite clipboard`() {
        val clipboard = Clipboard("isolated test clipboard")
        val handler = MainThreadClipboard { clipboard }
        handler.writeText("existing")
        handler.writeText(null)
        assertEquals("existing", handler.readText())
        handler.writeText("")
        assertEquals("", handler.readText())
    }

    @Test
    fun `copy failure reaches the caller without sensitive exception details`() {
        val handler = MainThreadClipboard { throw IllegalStateException("fixture-secret from clipboard provider") }

        val error = assertThrows(IllegalStateException::class.java) { handler.writeText("fixture-secret report") }

        assertEquals("Could not write to the clipboard", error.message)
        assertNull(error.cause)
    }

    @Test
    fun `platform cancellation remains cancellation`() {
        val cancelled = CancellationException("test cancellation")
        val handler = MainThreadClipboard { throw cancelled }

        assertSame(cancelled, assertThrows(CancellationException::class.java) { handler.writeText("report") })
    }
}
