package ai.kilocode.jetbrains.webview

import com.intellij.openapi.diagnostic.ControlFlowException
import kotlinx.coroutines.CancellationException
import java.util.concurrent.atomic.AtomicBoolean

/** Deliver the VS Code view-lifecycle event once, without looking up a disposed project's host. */
internal class WebViewDisposalBridge(
    private val isProjectDisposed: () -> Boolean,
    private val sendDispose: () -> Unit,
    private val onUnavailable: () -> Unit,
) {
    private val disposed = AtomicBoolean(false)

    fun dispose() {
        if (!disposed.compareAndSet(false, true) || isProjectDisposed()) return
        try {
            sendDispose()
        } catch (error: Exception) {
            if (error is ControlFlowException || error is CancellationException) throw error
            // Disposal is never replayed into a replacement host; do not expose RPC exception data.
            onUnavailable()
        }
    }
}
