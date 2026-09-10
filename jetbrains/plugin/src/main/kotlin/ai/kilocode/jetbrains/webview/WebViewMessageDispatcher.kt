package ai.kilocode.jetbrains.webview

import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.asCoroutineDispatcher
import java.util.concurrent.Executors

/**
 * Each view owns one FIFO worker for its synchronous RPC sends. In particular,
 * an immediate cancel must never overtake the diagnostic start it belongs to.
 * Independent views keep independent workers and extension-host connections.
 */
internal fun createWebViewMessageDispatcher(): ExecutorCoroutineDispatcher =
    Executors
        .newSingleThreadExecutor { runnable ->
            Thread(runnable, "KiloCode-WebView-IO").apply { isDaemon = true }
        }.asCoroutineDispatcher()
