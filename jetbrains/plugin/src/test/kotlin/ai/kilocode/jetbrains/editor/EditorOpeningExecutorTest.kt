package ai.kilocode.jetbrains.editor

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.ArrayDeque
import kotlin.coroutines.coroutineContext

@OptIn(ExperimentalCoroutinesApi::class)
class EditorOpeningExecutorTest {
    @Test
    fun `preparation is always queued and asynchronous opening does not block the event queue`() = withFixture { fixture ->
        val events = mutableListOf<String>()
        val editorReady = CompletableDeferred<String>()
        val result = fixture.launch {
            fixture.executor.open(
                prepareDocument = { events += "commit target document" },
                openEditor = {
                    events += "start opening"
                    editorReady.await().also { events += "editor ready" }
                },
            )
        }
        assertTrue(events.isEmpty())
        assertFalse(result.isCompleted)
        fixture.drain()
        assertEquals(listOf("commit target document", "start opening"), events)
        assertFalse(result.isCompleted)

        fixture.queue.add(Runnable { events += "unrelated UI event" })
        fixture.drain()
        assertEquals("unrelated UI event", events.last())
        editorReady.complete("editor")
        assertEquals("editor", result.getCompleted())
        assertEquals("editor ready", events.last())
    }

    @Test
    fun `opening retains explicit context across suspension`() = withFixture { fixture ->
        val editorReady = CompletableDeferred<Unit>()
        val result = fixture.launch {
            fixture.executor.open({}, {
                assertEquals("nonmodal opening", coroutineContext[CoroutineName]?.name)
                editorReady.await()
                assertEquals("nonmodal opening", coroutineContext[CoroutineName]?.name)
                "ready"
            })
        }
        fixture.drain()
        editorReady.complete(Unit)
        assertEquals("ready", result.getCompleted())
    }

    @Test
    fun `caller cancellation before queued callback prevents document and editor changes`() = withFixture { fixture ->
        var changed = false
        val result = fixture.launch { fixture.executor.open({ changed = true }, { changed = true }) }
        result.cancel()
        fixture.drain()
        assertTrue(result.isCancelled)
        assertFalse(changed)
        assertTrue(fixture.owner.isActive)
    }

    @Test
    fun `owner disposal cancels queued operation without waiting for UI callback`() = withFixture { fixture ->
        var changed = false
        val result = fixture.launch { fixture.executor.open({ changed = true }, { changed = true }) }
        fixture.owner.cancel()
        assertTrue(result.isCompleted)
        assertTrue(result.isCancelled)
        fixture.drain()
        assertFalse(changed)
    }

    @Test
    fun `disposed project cannot execute already queued preparation`() = withFixture { fixture ->
        var changed = false
        val result = fixture.launch { fixture.executor.open({ changed = true }, { changed = true }) }
        fixture.disposed = true
        fixture.drain()
        assertTrue(result.isCancelled)
        assertFalse(changed)
    }

    @Test
    fun `disposal during asynchronous loading cancels waiting and prevents completion`() = withFixture { fixture ->
        val editorReady = CompletableDeferred<Unit>()
        var attached = false
        val result = fixture.launch {
            fixture.executor.open({}, { editorReady.await() })
            attached = true
        }
        fixture.drain()
        fixture.owner.cancel()
        assertTrue(result.isCompleted)
        assertTrue(result.isCancelled)
        editorReady.complete(Unit)
        assertFalse(attached)
    }

    @Test
    fun `disposal between preparation and opening prevents opening`() = withFixture { fixture ->
        var opened = false
        val result = fixture.launch { fixture.executor.open({ fixture.disposed = true }, { opened = true }) }
        fixture.drain()
        assertTrue(result.isCancelled)
        assertFalse(opened)
    }

    @Test
    fun `failed preparation is propagated and never opens editor`() = withFixture { fixture ->
        val failure = IllegalStateException("target commit failed")
        var opened = false
        val result = fixture.launch { fixture.executor.open({ throw failure }, { opened = true }) }
        fixture.drain()
        assertPropagatedFailure(failure, result.getCompletionExceptionOrNull())
        assertFalse(opened)
        assertTrue(fixture.owner.isActive)
    }

    @Test
    fun `platform opening failure is propagated and later operation still works`() = withFixture { fixture ->
        val failure = IllegalStateException("provider failed to open")
        val first = fixture.launch { fixture.executor.open({}, { throw failure }) }
        fixture.drain()
        assertPropagatedFailure(failure, first.getCompletionExceptionOrNull())
        assertTrue(fixture.owner.isActive)
        val second = fixture.launch { fixture.executor.open({}, { "next editor" }) }
        fixture.drain()
        assertEquals("next editor", second.getCompleted())
    }

    @Test
    fun `queue rejection completes operation with failure`() = withFixture { fixture ->
        val failure = IllegalStateException("application shutting down")
        fixture.queueFailure = failure
        val result = fixture.launch { fixture.executor.open({}, { "unexpected" }) }
        assertTrue(result.isCompleted)
        assertPropagatedFailure(failure, result.getCompletionExceptionOrNull())
    }

    @Test
    fun `completed owner does not queue an editor operation`() = withFixture { fixture ->
        fixture.owner.cancel()
        val result = fixture.launch { fixture.executor.open({}, { "unexpected" }) }
        assertTrue(result.isCancelled)
        assertTrue(fixture.queue.isEmpty())
    }

    @Test
    fun `nonmodal EDT helper queues and cancels without affecting another project`() = withFixture { first ->
        withFixture { second ->
            var firstRan = false
            val firstResult = first.launch { first.executor.onEdt { firstRan = true } }
            val secondResult = second.launch { second.executor.onEdt { "second project" } }
            assertFalse(firstRan)
            first.owner.cancel()
            first.drain()
            second.drain()
            assertTrue(firstResult.isCancelled)
            assertFalse(firstRan)
            assertEquals("second project", secondResult.getCompleted())
        }
    }

    private fun assertPropagatedFailure(expected: Throwable, actual: Throwable?) {
        assertEquals(expected.javaClass, actual?.javaClass)
        assertEquals(expected.message, actual?.message)
        // The IDE's coroutine stack-trace recovery may copy an exception while
        // retaining the original as its cause. Preserve that failure provenance
        // without requiring the outer wrapper to have the same object identity.
        val seen = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Throwable, Boolean>())
        var current = actual
        while (current != null && seen.add(current)) {
            if (current === expected) return
            current = current.cause
        }
        throw AssertionError("Original failure is missing from the propagated exception cause chain")
    }

    private class Fixture {
        val owner: Job = SupervisorJob()
        private val callerScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val queue = ArrayDeque<Runnable>()
        var disposed = false
        var queueFailure: Throwable? = null
        val executor = EditorOpeningExecutor(
            ownerJob = owner,
            isDisposed = { disposed },
            enqueueNonModal = { callback ->
                queueFailure?.let { throw it }
                queue.add(callback)
            },
            modalityContext = CoroutineName("nonmodal opening"),
        )

        fun <T> launch(block: suspend () -> T): Deferred<T> = callerScope.async { block() }

        fun drain() {
            while (queue.isNotEmpty()) queue.removeFirst().run()
        }

        fun close() {
            owner.cancel()
            callerScope.cancel()
            drain()
        }
    }

    private fun withFixture(block: (Fixture) -> Unit) {
        val fixture = Fixture()
        try {
            block(fixture)
        } finally {
            fixture.close()
        }
    }
}
