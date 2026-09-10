package ai.kilocode.jetbrains.webview

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class WebViewMessageDispatcherTest {
    @Test
    fun `diagnostic start and immediate cancel reach the same host in order`() =
        runBlocking {
            val dispatcher = createWebViewMessageDispatcher()
            val scope = CoroutineScope(SupervisorJob() + dispatcher)
            val received = Collections.synchronizedList(mutableListOf<String>())
            val firstEntered = CountDownLatch(1)
            val releaseFirst = CountDownLatch(1)
            val start = """{"type":"testProviderConnection","requestId":"check-1","apiConfiguration":{"openAiApiKey":"fixture-secret"}}"""
            val cancel = """{"type":"cancelProviderConnectionTest","requestId":"check-1"}"""
            val bridge =
                WebViewMessageBridge({ false }, { message ->
                    if (message == start) {
                        firstEntered.countDown()
                        check(releaseFirst.await(5, TimeUnit.SECONDS))
                    }
                    received.add(message)
                    true
                }, { error("host is connected") })
            try {
                val first = scope.launch { bridge.forward(start) }
                assertTrue(firstEntered.await(5, TimeUnit.SECONDS))
                val second = scope.launch { bridge.forward(cancel) }
                releaseFirst.countDown()
                joinAll(first, second)
                assertEquals(listOf(start, cancel), received)
            } finally {
                releaseFirst.countDown()
                scope.cancel()
                dispatcher.close()
            }
        }

    @Test
    fun `disposing one view discards its queued draft without affecting another project`() =
        runBlocking {
            val dispatcherA = createWebViewMessageDispatcher()
            val dispatcherB = createWebViewMessageDispatcher()
            val scopeA = CoroutineScope(SupervisorJob() + dispatcherA)
            val scopeB = CoroutineScope(SupervisorJob() + dispatcherB)
            val disposedA = AtomicBoolean(false)
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            val receivedA = mutableListOf<String>()
            val receivedB = mutableListOf<String>()
            val bridgeA =
                WebViewMessageBridge(disposedA::get, {
                    receivedA.add(it)
                    true
                }, { error("connected") })
            val bridgeB =
                WebViewMessageBridge({ false }, {
                    receivedB.add(it)
                    true
                }, { error("connected") })
            try {
                val blocker =
                    scopeA.launch {
                        entered.countDown()
                        check(release.await(5, TimeUnit.SECONDS))
                    }
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                val draft = scopeA.launch { bridgeA.forward("private draft A") }
                val other = scopeB.launch { bridgeB.forward("diagnostic B") }
                other.join()
                assertEquals(listOf("diagnostic B"), receivedB)
                disposedA.set(true)
                scopeA.cancel()
                release.countDown()
                joinAll(blocker, draft)
                assertTrue(receivedA.isEmpty())
            } finally {
                release.countDown()
                scopeA.cancel()
                scopeB.cancel()
                dispatcherA.close()
                dispatcherB.close()
            }
        }
}
