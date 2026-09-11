package ai.kilocode.jetbrains.webview

import com.intellij.openapi.diagnostic.ControlFlowException
import kotlinx.coroutines.CancellationException
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.UndeclaredThrowableException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A WebView can outlive its extension host. Reject commands visibly, without
 * replaying them into a different task or logging their potentially secret body.
 *
 * Only a host that was running and then stopped is worth interrupting the user
 * for. While a host is still starting, or when the project is being closed, a
 * failed command is expected and is only written to the log.
 */
internal class WebViewMessageBridge(
    private val isDisposed: () -> Boolean,
    private val sendMessage: (String) -> Boolean,
    private val onUnavailable: () -> Unit,
    private val isHostStopped: () -> Boolean = { true },
) {
    private val unavailableReported = AtomicBoolean(false)

    fun forward(message: String) {
        if (isDisposed()) return
        try {
            if (sendMessage(message)) {
                unavailableReported.set(false)
                return
            }
        } catch (error: Exception) {
            // Dynamic RPC proxies may wrap a platform cancellation exception.
            // These must escape, never become an IDE error notification.
            var cause: Throwable = error
            while (true) {
                cause = when (cause) {
                    is UndeclaredThrowableException -> cause.undeclaredThrowable ?: break
                    is InvocationTargetException -> cause.targetException ?: break
                    else -> break
                }
            }
            if (cause is ControlFlowException || cause is CancellationException) throw cause
            // No automatic retry: even a failed send may have reached the host.
        }
        if (isDisposed() || !isHostStopped()) return
        if (unavailableReported.compareAndSet(false, true)) {
            onUnavailable()
        }
    }
}
