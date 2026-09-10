package ai.kilocode.jetbrains.webview

import org.junit.Assert.assertEquals
import org.junit.Test

class WebViewDisposalBridgeTest {
    @Test
    fun `a closed view sends its host lifecycle event once`() {
        var sends = 0
        val bridge = WebViewDisposalBridge({ false }, { sends++ }, { error("connected") })

        repeat(3) { bridge.dispose() }

        assertEquals(1, sends)
    }

    @Test
    fun `a disposed project never resolves the host or sends an event`() {
        val bridge =
            WebViewDisposalBridge(
                { true },
                { error("must not resolve a disposed project's host") },
                { error("must not notify a disposed project") },
            )

        bridge.dispose()
    }

    @Test
    fun `failed disposal is not replayed into a replacement host or logged with payload`() {
        var sends = 0
        var warnings = 0
        val bridge =
            WebViewDisposalBridge(
                { false },
                {
                    sends++
                    throw IllegalStateException("fixture-secret RPC state")
                },
                { warnings++ },
            )

        repeat(3) { bridge.dispose() }

        assertEquals(1, sends)
        assertEquals(1, warnings)
    }
}
