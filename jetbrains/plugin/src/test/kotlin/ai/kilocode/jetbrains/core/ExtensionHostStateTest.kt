package ai.kilocode.jetbrains.core

import ai.kilocode.jetbrains.ipc.proxy.IRPCProtocol
import org.junit.Assert.assertEquals
import org.junit.Test
import java.lang.reflect.Proxy

/**
 * A WebView must be able to tell "the host has not started yet" apart from
 * "the host is gone", because only the second case interrupts the user.
 */
class ExtensionHostStateTest {
    @Test
    fun `a context without a host reports that one is starting`() {
        assertEquals(ExtensionHostState.STARTING, PluginContext().getExtensionHostState())
    }

    @Test
    fun `a connected host is ready and a cleared one is stopped`() {
        val context = PluginContext()

        context.setRPCProtocol(stubProtocol())
        assertEquals(ExtensionHostState.READY, context.getExtensionHostState())

        context.clear()
        assertEquals(ExtensionHostState.STOPPED, context.getExtensionHostState())
    }

    @Test
    fun `clearing a context that never had a host keeps it starting`() {
        val context = PluginContext()
        var notifications = 0
        context.addHostStoppedListener { notifications++ }

        context.clear()

        assertEquals(ExtensionHostState.STARTING, context.getExtensionHostState())
        assertEquals(0, notifications)
    }

    @Test
    fun `every listener is notified once the host stops`() {
        val context = PluginContext()
        var first = 0
        var second = 0
        context.addHostStoppedListener { first++ }
        context.addHostStoppedListener { second++ }

        context.setRPCProtocol(stubProtocol())
        context.clear()

        assertEquals(1, first)
        assertEquals(1, second)
    }

    @Test
    fun `a failing listener does not stop the others`() {
        val context = PluginContext()
        var notified = 0
        context.addHostStoppedListener { throw IllegalStateException("view already released") }
        context.addHostStoppedListener { notified++ }

        context.setRPCProtocol(stubProtocol())
        context.clear()

        assertEquals(1, notified)
    }

    @Test
    fun `a removed listener is not notified`() {
        val context = PluginContext()
        var notified = 0
        val listener: () -> Unit = { notified++ }
        context.addHostStoppedListener(listener)
        context.removeHostStoppedListener(listener)

        context.setRPCProtocol(stubProtocol())
        context.clear()

        assertEquals(0, notified)
    }

    @Test
    fun `a restarted host becomes ready again`() {
        val context = PluginContext()
        context.setRPCProtocol(stubProtocol())
        context.clear()

        context.setRPCProtocol(stubProtocol())

        assertEquals(ExtensionHostState.READY, context.getExtensionHostState())
    }

    private fun stubProtocol(): IRPCProtocol =
        Proxy.newProxyInstance(
            IRPCProtocol::class.java.classLoader,
            arrayOf(IRPCProtocol::class.java),
        ) { _, _, _ -> null } as IRPCProtocol
}
