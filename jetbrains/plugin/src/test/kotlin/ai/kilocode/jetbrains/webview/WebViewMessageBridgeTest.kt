package ai.kilocode.jetbrains.webview

import com.intellij.openapi.diagnostic.ControlFlowException
import kotlinx.coroutines.CancellationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.UndeclaredThrowableException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class WebViewMessageBridgeTest {
    @Test
    fun `connected bridge forwards the original command exactly once`() {
        val sent = mutableListOf<String>()
        var warnings = 0
        val bridge = WebViewMessageBridge({ false }, { sent.add(it); true }, { warnings++ })

        bridge.forward("{\"type\":\"cancelTask\"}")

        assertEquals(listOf("{\"type\":\"cancelTask\"}"), sent)
        assertEquals(0, warnings)
    }

    @Test
    fun `disconnected bridge warns once without retaining or replaying commands`() {
        var connected = false
        var warnings = 0
        val sent = mutableListOf<String>()
        val bridge = WebViewMessageBridge({ false }, {
            if (connected) { sent.add(it); true } else false
        }, { warnings++ })

        repeat(20) { bridge.forward("{\"type\":\"cancelTask\",\"secret\":\"fixture-only\"}") }
        assertEquals(1, warnings)
        assertTrue(sent.isEmpty())

        connected = true
        bridge.forward("fresh command")
        assertEquals(listOf("fresh command"), sent)

        connected = false
        bridge.forward("next disconnected command")
        assertEquals(2, warnings)
    }

    @Test
    fun `disposed view never looks up the project service or warns`() {
        val bridge = WebViewMessageBridge(
            { true },
            { error("must not access a disposed project's service") },
            { error("must not notify a disposed project") },
        )
        bridge.forward("cancelTask")
    }

    @Test
    fun `project disposed during lookup does not show a stale warning`() {
        var disposed = false
        val bridge = WebViewMessageBridge(
            { disposed },
            { disposed = true; throw IllegalStateException("service already closed") },
            { error("must not notify a disposed project") },
        )
        bridge.forward("cancelTask")
    }

    @Test
    fun `send failure is reported without retrying or forwarding exception payload`() {
        var sends = 0
        var warnings = 0
        val bridge = WebViewMessageBridge({ false }, {
            sends++
            throw IllegalStateException("request could contain a fixture-secret")
        }, { warnings++ })

        bridge.forward("user data")

        assertEquals(1, sends)
        assertEquals(1, warnings)
    }

    @Test
    fun `coroutine cancellation escapes without disconnected notification`() {
        assertControlFlowEscapes(CancellationException("cancelled"))
    }

    @Test
    fun `platform control flow escapes without disconnected notification`() {
        assertControlFlowEscapes(TestControlFlowException())
    }

    @Test
    fun `RPC proxy wrapped control flow is rethrown rather than logged`() {
        val cause = TestControlFlowException()
        assertControlFlowEscapes(UndeclaredThrowableException(InvocationTargetException(cause)), cause)
    }

    @Test
    fun `a host that is still starting fails quietly`() {
        var warnings = 0
        val bridge = WebViewMessageBridge({ false }, { false }, { warnings++ }, isHostStopped = { false })

        repeat(5) { bridge.forward("cancelTask") }

        assertEquals(0, warnings)
    }

    @Test
    fun `the warning appears once the host that was running has stopped`() {
        var stopped = false
        var warnings = 0
        val bridge = WebViewMessageBridge({ false }, { false }, { warnings++ }, isHostStopped = { stopped })

        bridge.forward("cancelTask")
        assertEquals(0, warnings)

        stopped = true
        bridge.forward("cancelTask")
        assertEquals(1, warnings)
    }

    @Test
    fun `concurrent disconnected commands produce one warning`() {
        val warnings = AtomicInteger()
        val ready = CountDownLatch(20)
        val start = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(20)
        val bridge = WebViewMessageBridge({ false }, { false }, { warnings.incrementAndGet() })
        try {
            val results = List(20) {
                executor.submit {
                    ready.countDown()
                    check(start.await(5, TimeUnit.SECONDS))
                    bridge.forward("cancelTask")
                }
            }
            assertTrue(ready.await(5, TimeUnit.SECONDS))
            start.countDown()
            results.forEach { it.get(5, TimeUnit.SECONDS) }
            assertEquals(1, warnings.get())
        } finally {
            start.countDown()
            executor.shutdownNow()
        }
    }

    private fun assertControlFlowEscapes(error: Exception, expected: Throwable = error) {
        val bridge = WebViewMessageBridge({ false }, { throw error }, { kotlin.error("must not notify") })
        try {
            bridge.forward("cancelTask")
            throw AssertionError("expected control-flow exception")
        } catch (actual: Throwable) {
            assertSame(expected, actual)
        }
    }

    private class TestControlFlowException : RuntimeException(), ControlFlowException
}
