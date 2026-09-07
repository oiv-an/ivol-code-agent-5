package ai.kilocode.jetbrains.core

import com.intellij.openapi.project.Project
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.lang.reflect.Proxy
import java.net.Socket
import java.util.Queue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.ReentrantLock

class ExtensionHostLifecycleTest {
    @Test
    fun `disposed host clears pending closures and never accepts new messages`() {
        withHost { host, _ ->
            var executed = false
            host.queueMessage { executed = true }
            assertEquals(1, queue(host).size)
            host.dispose()
            repeat(100) { host.queueMessage { executed = true } }
            assertTrue(queue(host).isEmpty())
            assertFalse(executed)
            assertFalse(host.waitForReady().get())
        }
    }

    @Test
    fun `active message callbacks execute outside the lifecycle queue lock in serial order`() {
        withHost { host, _ ->
            setState(host, InitializationState.EXTENSION_ACTIVATED)
            val order = mutableListOf<Int>()
            val lock = field<ReentrantLock>(host, "queueLock")
            host.queueMessage {
                assertFalse(lock.isHeldByCurrentThread)
                order.add(1)
                host.queueMessage {
                    assertFalse(lock.isHeldByCurrentThread)
                    order.add(3)
                }
                order.add(2)
            }
            assertEquals(listOf(1, 2, 3), order)
            assertTrue(queue(host).isEmpty())
        }
    }

    @Test
    fun `failed initialization discards stale queued messages instead of growing the queue`() {
        withHost { host, _ ->
            host.queueMessage { error("must not execute") }
            setState(host, InitializationState.FAILED)
            repeat(100) { host.queueMessage { error("must not execute") } }
            assertTrue(queue(host).isEmpty())
        }
    }

    @Test
    fun `unresponsive initialization has a bounded queue and closes the host on overflow`() {
        withHost { host, _ ->
            repeat(300) { host.queueMessage { error("must not execute") } }
            assertTrue(field<AtomicBoolean>(host, "disposed").get())
            assertTrue(queue(host).isEmpty())
            assertFalse(host.waitForReady().get())
        }
    }

    @Test
    fun `disposed project cannot enqueue or restart host work`() {
        withHost { host, projectDisposed ->
            host.queueMessage { error("must not execute") }
            projectDisposed.set(true)
            host.queueMessage { error("must not execute") }
            host.start()
            host.restartInitialization()
            assertTrue(queue(host).isEmpty())
            assertEquals(InitializationState.NOT_STARTED, host.stateMachine.getCurrentState())
            assertFalse(host.waitForReady().get())
        }
    }

    private fun withHost(block: (ExtensionHostManager, AtomicBoolean) -> Unit) {
        val projectDisposed = AtomicBoolean(false)
        val project = Proxy.newProxyInstance(Project::class.java.classLoader, arrayOf(Project::class.java)) { _, method, _ ->
            when (method.name) {
                "isDisposed" -> projectDisposed.get()
                "toString" -> "HostLifecycleTestProject"
                else -> if (method.returnType == Boolean::class.javaPrimitiveType) false else null
            }
        } as Project
        val host = ExtensionHostManager(TestSocket(), "/test/project", project)
        try {
            block(host, projectDisposed)
        } finally {
            host.dispose()
        }
    }

    private fun setState(host: ExtensionHostManager, state: InitializationState) {
        field<AtomicReference<InitializationState>>(host.stateMachine, "state").set(state)
    }

    private fun queue(host: ExtensionHostManager): Queue<*> = field(host, "messageQueue")

    @Suppress("UNCHECKED_CAST")
    private fun <T> field(instance: Any, name: String): T = instance.javaClass.getDeclaredField(name).let {
        it.isAccessible = true
        it.get(instance) as T
    }

    private class TestSocket : Socket() {
        private var closed = false
        private val input = ByteArrayInputStream(byteArrayOf())
        private val output = ByteArrayOutputStream()
        override fun getInputStream() = input
        override fun getOutputStream() = output
        override fun setTcpNoDelay(on: Boolean) = Unit
        override fun isClosed() = closed
        override fun close() { closed = true }
    }
}
