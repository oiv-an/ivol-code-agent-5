package ai.kilocode.jetbrains.editor

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext

/**
 * Keeps editor preparation and asynchronous opening inside the same cancellable,
 * write-safe operation. Scheduling and modality are supplied by the IDE adapter
 * so the ordering/lifecycle contract can be tested without starting an IDE.
 */
internal class EditorOpeningExecutor(
    private val ownerJob: Job,
    private val isDisposed: () -> Boolean,
    private val enqueueNonModal: (Runnable) -> Unit,
    private val modalityContext: CoroutineContext,
) {
    suspend fun <T> open(prepareDocument: () -> Unit, openEditor: suspend () -> T): T = ownedOperation {
        enqueueAndAwait(prepareDocument)
        ensureLive()
        // Do not wrap this in invokeLater + synchronous openFile. The platform's
        // suspend API waits for the editor without pumping a nested EDT event loop.
        openEditor().also { ensureLive() }
    }

    suspend fun <T> onEdt(block: () -> T): T = ownedOperation { enqueueAndAwait(block) }

    private suspend fun <T> ownedOperation(block: suspend () -> T): T = coroutineScope {
        val operationJob = coroutineContext[Job]!!
        val ownerRegistration = ownerJob.invokeOnCompletion {
            operationJob.cancel(CancellationException("Editor manager disposed"))
        }
        try {
            withContext(modalityContext) {
                ensureLive()
                block()
            }
        } finally {
            ownerRegistration.dispose()
        }
    }

    private suspend fun ensureLive() {
        kotlin.coroutines.coroutineContext.ensureActive()
        if (!ownerJob.isActive || isDisposed()) throw CancellationException("Editor manager disposed")
    }

    private suspend fun <T> enqueueAndAwait(block: () -> T): T = suspendCancellableCoroutine { continuation ->
        // Even an EDT caller may be in a write-unsafe or modal callback. Always
        // cross the explicit non-modal queue rather than taking an inline shortcut.
        try {
            enqueueNonModal(Runnable {
                if (!continuation.isActive) return@Runnable
                if (!ownerJob.isActive || isDisposed()) {
                    continuation.cancel(CancellationException("Editor manager disposed"))
                } else {
                    continuation.resumeWith(runCatching(block))
                }
            })
        } catch (error: Throwable) {
            continuation.resumeWith(Result.failure(error))
        }
    }
}
