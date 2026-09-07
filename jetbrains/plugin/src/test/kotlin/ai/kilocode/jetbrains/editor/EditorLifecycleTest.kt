package ai.kilocode.jetbrains.editor

import ai.kilocode.jetbrains.monitoring.ScopeRegistry
import ai.kilocode.jetbrains.util.URI
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.project.Project
import com.intellij.util.messages.MessageBus
import com.intellij.util.messages.MessageBusConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Proxy
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class EditorLifecycleTest {
    @Test
    fun `closing an editor cancels collectors and releases IDE references`() {
        withManager { manager ->
            val holder = addHolder(manager, "closed")
            val scope = field<CoroutineScope>(holder, "editorOperationScope")
            val editor = proxy(FileEditor::class.java)
            holder.ideaEditor = editor
            holder.updateVisibleRanges(emptyList())
            holder.updateDocumentLanguage("php")

            manager.removeEditor(holder.id)
            awaitCancelled(scope)

            assertTrue(holder.isDisposed)
            assertNull(holder.ideaEditor)
            assertNull(manager.getEditorHandleById(holder.id))
            assertTrue(field<DocumentsAndEditorsState>(manager, "state").documents.isEmpty())
            assertFalse(ScopeRegistry.getActiveScopes().containsKey(scopeName(holder)))
            // A file-open callback that arrives after closure cannot reattach an IDE editor.
            holder.ideaEditor = editor
            assertNull(holder.ideaEditor)
            holder.dispose() // Idempotent.
        }
    }

    @Test
    fun `closing one view preserves the document used by another view`() {
        withManager { manager ->
            val text = addHolder(manager, "text")
            val diff = addHolder(manager, "diff", diff = true, document = text.document)

            manager.removeEditor(text.id)

            assertTrue(text.isDisposed)
            assertFalse(diff.isDisposed)
            assertSame(diff, manager.getEditorHandleById(diff.id))
            assertSame(diff.document, field<DocumentsAndEditorsState>(manager, "state").documents[diff.document.uri])
            manager.removeEditor(diff.id)
            assertTrue(field<DocumentsAndEditorsState>(manager, "state").documents.isEmpty())
        }
    }

    @Test
    fun `project disposal cancels all holder jobs and clears current and previous snapshots`() {
        withManager { manager ->
            val holders = (1..5).map { addHolder(manager, "project-$it") }
            val scopes = holders.map { field<CoroutineScope>(it, "editorOperationScope") }
            val previous = field<DocumentsAndEditorsState>(manager, "lastNotifiedState")
            previous.documents[holders.first().document.uri] = holders.first().document
            previous.editors[holders.first().id] = holders.first().state
            manager.onIdeaDiffEditorCreated(holders.first().document.uri, proxy(Editor::class.java))

            manager.dispose()
            scopes.forEach(::awaitCancelled)

            assertTrue(holders.all { it.isDisposed && it.ideaEditor == null })
            assertTrue(field<Map<*, *>>(manager, "editorHandles").isEmpty())
            assertTrue(field<Map<*, *>>(manager, "ideaOpenedEditor").isEmpty())
            for (name in listOf("state", "lastNotifiedState")) {
                val snapshot = field<DocumentsAndEditorsState>(manager, name)
                assertTrue(snapshot.documents.isEmpty())
                assertTrue(snapshot.editors.isEmpty())
            }
            assertTrue(holders.none { ScopeRegistry.getActiveScopes().containsKey(scopeName(it)) })
            // Later diff-editor callbacks cannot revive the disposed project state.
            manager.onIdeaDiffEditorCreated(holders.first().document.uri, proxy(Editor::class.java))
            assertTrue(field<Map<*, *>>(manager, "ideaOpenedEditor").isEmpty())
        }
    }

    @Test
    fun `repeated open close cycles do not retain any holder scopes`() {
        withManager { manager ->
            val initial = ScopeRegistry.getActiveScopes().keys
            repeat(100) { index ->
                val holder = addHolder(manager, "cycle-$index")
                manager.removeEditor(holder.id)
                assertTrue(holder.isDisposed)
            }
            assertEquals(initial, ScopeRegistry.getActiveScopes().keys)
            assertTrue(field<Map<*, *>>(manager, "editorHandles").isEmpty())
        }
    }

    @Test
    fun `disposing one project does not unregister another project scope`() {
        withManager { first ->
            withManager { second ->
                val firstName = field<String>(first, "scopeName")
                val secondName = field<String>(second, "scopeName")
                assertFalse(firstName == secondName)
                first.dispose()
                assertFalse(ScopeRegistry.getActiveScopes().containsKey(firstName))
                assertTrue(ScopeRegistry.getActiveScopes()[secondName] == true)
            }
        }
    }

    @Test
    fun `releasing an old diff editor does not remove its replacement`() {
        withManager { manager ->
            val uri = URI.file("/test/replacement.php")
            val older = proxy(Editor::class.java)
            val replacement = proxy(Editor::class.java)
            manager.onIdeaDiffEditorCreated(uri, older)
            manager.onIdeaDiffEditorCreated(uri, replacement)
            manager.onIdeaDiffEditorReleased(uri, older)
            assertSame(replacement, manager.getIdeaDiffEditor(uri)?.get())
            manager.onIdeaDiffEditorReleased(uri, replacement)
            assertNull(manager.getIdeaDiffEditor(uri))
        }
    }

    private fun withManager(block: (EditorAndDocManager) -> Unit) {
        val connection = proxy(MessageBusConnection::class.java)
        val bus = proxy(MessageBus::class.java) { name -> if (name == "connect") connection else null }
        // This test drives owner lifecycle directly, without an IDE or RPC host.
        // A disposed project makes asynchronous outbound notifications no-ops.
        val project = proxy(Project::class.java) { name ->
            when (name) {
                "getMessageBus" -> bus
                "isDisposed" -> true
                else -> null
            }
        }
        val manager = EditorAndDocManager(project)
        try {
            block(manager)
        } finally {
            manager.dispose()
        }
    }

    private fun addHolder(
        manager: EditorAndDocManager,
        id: String,
        diff: Boolean = false,
        document: ModelAddedData = ModelAddedData(URI.file("/test/$id.php"), 1, listOf("test"), "\n", "php", false, "utf8"),
    ): EditorHolder {
        val editorState = TextEditorAddData(id, document.uri, ResolvedTextEditorConfiguration(), emptyList(), emptyList(), null)
        val holder = EditorHolder(id, editorState, document, diff, manager)
        field<ConcurrentHashMap<String, EditorHolder>>(manager, "editorHandles")[id] = holder
        val state = field<DocumentsAndEditorsState>(manager, "state")
        state.documents[document.uri] = document
        state.editors[id] = editorState
        return holder
    }

    private fun awaitCancelled(scope: CoroutineScope) {
        val job = scope.coroutineContext[Job]!!
        val completed = CountDownLatch(1)
        val registration = job.invokeOnCompletion { completed.countDown() }
        try {
            // Avoid running an unrelated blocking-coroutine event loop inside the
            // IntelliJ test runner. The wall-clock timeout also bounds regressions
            // where a child job fails to finish cancellation.
            assertTrue("Editor scope failed to finish cancellation: $job", completed.await(5, TimeUnit.SECONDS))
            assertTrue(job.isCancelled)
            assertTrue(job.isCompleted)
            assertFalse(job.children.any())
        } finally {
            registration.dispose()
        }
    }

    private fun scopeName(holder: EditorHolder) = "EditorHolder.editorOperationScope-${holder.id}"

    @Suppress("UNCHECKED_CAST")
    private fun <T> field(instance: Any, name: String): T = instance.javaClass.getDeclaredField(name).let {
        it.isAccessible = true
        it.get(instance) as T
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T> proxy(type: Class<T>, value: (String) -> Any? = { null }): T {
        return Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { instance, method, args ->
            when (method.name) {
                "equals" -> instance === args?.firstOrNull()
                "hashCode" -> System.identityHashCode(instance)
                "toString" -> "Test${type.simpleName}"
                else -> value(method.name) ?: if (method.returnType == Boolean::class.javaPrimitiveType) false else null
            }
        } as T
    }
}
