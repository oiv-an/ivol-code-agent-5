package ai.kilocode.jetbrains.plugin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class PluginInitializationGateTest {
    @Test
    fun `simultaneous startup entry points claim exactly one attempt`() {
        val gate = PluginInitializationGate()
        val count = 16
        val executor = Executors.newFixedThreadPool(count)
        val ready = CountDownLatch(count)
        val start = CountDownLatch(1)
        try {
            val attempts = List(count) {
                executor.submit<PluginInitializationGate.Attempt?> {
                    ready.countDown()
                    check(start.await(5, TimeUnit.SECONDS))
                    gate.tryBegin()
                }
            }
            assertTrue(ready.await(5, TimeUnit.SECONDS))
            start.countDown()
            val claimed = attempts.mapNotNull { it.get(5, TimeUnit.SECONDS) }
            assertEquals(1, claimed.size)
            assertTrue(gate.isCurrent(claimed.single()))
            assertFalse(gate.isInitialized)
        } finally {
            start.countDown()
            executor.shutdownNow()
            assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
        }
    }

    @Test
    fun `successful initialization cannot start or complete again`() {
        val gate = PluginInitializationGate()
        val attempt = gate.tryBegin()!!
        assertTrue(gate.complete(attempt))
        assertTrue(gate.isInitialized)
        assertTrue(gate.awaitInitialization())
        assertNull(gate.tryBegin())
        assertFalse(gate.isCurrent(attempt))
        assertFalse(gate.complete(attempt))
        assertFalse(gate.fail(attempt))
        assertTrue(gate.isInitialized)
    }

    @Test
    fun `retry is blocked during cleanup and enabled only after failure release`() {
        val gate = PluginInitializationGate()
        val attempt = gate.tryBegin()!!
        // The owner performs cleanup while retaining its initialization claim.
        assertTrue(gate.isCurrent(attempt))
        assertNull(gate.tryBegin())
        assertTrue(gate.fail(attempt))
        assertFalse(gate.awaitInitialization())
        assertFalse(gate.isInitialized)

        val retry = gate.tryBegin()!!
        assertNotSame(attempt, retry)
        assertTrue(gate.isCurrent(retry))
        assertTrue(gate.complete(retry))
        assertTrue(gate.awaitInitialization())
    }

    @Test
    fun `late completion and failure from a previous attempt do not affect retry`() {
        val gate = PluginInitializationGate()
        val first = gate.tryBegin()!!
        assertTrue(gate.fail(first))
        val retry = gate.tryBegin()!!
        assertFalse(gate.complete(first))
        assertFalse(gate.fail(first))
        assertFalse(gate.isCurrent(first))
        assertTrue(gate.isCurrent(retry))
        assertFalse(gate.isInitialized)
        assertNull(gate.tryBegin())
        assertTrue(gate.complete(retry))
    }

    @Test
    fun `failed cleanup releases waiters but blocks retry and still permits disposal`() {
        val gate = PluginInitializationGate()
        val attempt = gate.tryBegin()!!
        assertTrue(gate.fail(attempt, retryable = false))
        assertFalse(gate.awaitInitialization())
        assertFalse(gate.isInitialized)
        assertFalse(gate.isCurrent(attempt))
        assertNull(gate.tryBegin())
        // A late completion handler cannot reopen a failed cleanup for retry.
        assertFalse(gate.fail(attempt))
        assertFalse(gate.complete(attempt))
        assertNull(gate.tryBegin())
        assertTrue(gate.close())
        assertFalse(gate.close())
        assertFalse(gate.awaitInitialization())
        assertNull(gate.tryBegin())
    }

    @Test
    fun `closing during initialization rejects late completion and retry`() {
        val gate = PluginInitializationGate()
        val attempt = gate.tryBegin()!!
        assertTrue(gate.close())
        assertFalse(gate.close())
        assertFalse(gate.isCurrent(attempt))
        assertFalse(gate.complete(attempt))
        assertFalse(gate.fail(attempt))
        assertFalse(gate.isInitialized)
        assertFalse(gate.awaitInitialization())
        assertNull(gate.tryBegin())
    }

    @Test
    fun `closing an unused service is permanent`() {
        val gate = PluginInitializationGate()
        assertTrue(gate.close())
        assertNull(gate.tryBegin())
        assertFalse(gate.awaitInitialization())
        assertFalse(gate.isInitialized)
    }

    @Test
    fun `closing an initialized service clears readiness`() {
        val gate = PluginInitializationGate()
        assertTrue(gate.complete(gate.tryBegin()!!))
        assertTrue(gate.close())
        assertFalse(gate.isInitialized)
        assertFalse(gate.awaitInitialization())
        assertNull(gate.tryBegin())
    }

    @Test
    fun `only one caller claims concurrent disposal`() {
        val gate = PluginInitializationGate()
        assertNotNull(gate.tryBegin())
        val executor = Executors.newFixedThreadPool(8)
        try {
            val results = List(32) { executor.submit<Boolean> { gate.close() } }
            assertEquals(1, results.count { it.get(5, TimeUnit.SECONDS) })
            assertFalse(gate.isInitialized)
            assertNull(gate.tryBegin())
        } finally {
            executor.shutdownNow()
            assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
        }
    }

    @Test
    fun `waiter before first startup receives that startup result`() {
        val gate = PluginInitializationGate()
        val executor = Executors.newSingleThreadExecutor()
        val entered = CountDownLatch(1)
        try {
            val waiter = executor.submit<Boolean> {
                entered.countDown()
                gate.awaitInitialization()
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            assertFalse(waiter.isDone)
            assertTrue(gate.complete(gate.tryBegin()!!))
            assertTrue(waiter.get(5, TimeUnit.SECONDS))
        } finally {
            gate.close()
            executor.shutdownNow()
            assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
        }
    }

    @Test
    fun `disposal releases a waiter even before startup is requested`() {
        val gate = PluginInitializationGate()
        val executor = Executors.newSingleThreadExecutor()
        try {
            val waiter = executor.submit<Boolean> { gate.awaitInitialization() }
            assertTrue(gate.close())
            assertFalse(waiter.get(5, TimeUnit.SECONDS))
        } finally {
            gate.close()
            executor.shutdownNow()
            assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
        }
    }

    @Test
    fun `interrupted waiter propagates interruption without cancelling initialization`() {
        val gate = PluginInitializationGate()
        val attempt = gate.tryBegin()!!
        val interrupted = AtomicBoolean()
        val entered = CountDownLatch(1)
        val waiter = Thread {
            try {
                entered.countDown()
                gate.awaitInitialization()
            } catch (expected: InterruptedException) {
                interrupted.set(true)
            }
        }
        try {
            waiter.start()
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            waiter.interrupt()
            waiter.join(5_000)
            assertFalse(waiter.isAlive)
            assertTrue(interrupted.get())
            assertTrue(gate.isCurrent(attempt))
            assertTrue(gate.complete(attempt))
            assertTrue(gate.awaitInitialization())
        } finally {
            gate.close()
            waiter.interrupt()
            waiter.join(5_000)
        }
    }

    @Test
    fun `attempts from another project cannot complete or release this service`() {
        val first = PluginInitializationGate()
        val second = PluginInitializationGate()
        val firstAttempt = first.tryBegin()!!
        val secondAttempt = second.tryBegin()!!
        assertFalse(first.complete(secondAttempt))
        assertFalse(first.fail(secondAttempt))
        assertFalse(first.isCurrent(secondAttempt))
        assertTrue(first.isCurrent(firstAttempt))
        assertTrue(second.isCurrent(secondAttempt))
        assertTrue(first.complete(firstAttempt))
        assertTrue(second.complete(secondAttempt))
    }
}
