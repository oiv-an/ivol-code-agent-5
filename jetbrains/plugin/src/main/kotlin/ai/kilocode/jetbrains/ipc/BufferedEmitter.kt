// SPDX-FileCopyrightText: 2025 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.kilocode.jetbrains.ipc

import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.diagnostic.ControlFlowException
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/** Serial delivery without an unowned coroutine that can retain a retired connection. */
class BufferedEmitter<T> : Disposable {
    private val listeners = CopyOnWriteArrayList<(T) -> Unit>()
    private val bufferedMessages = ConcurrentLinkedQueue<T>()
    private val disposed = AtomicBoolean(false)
    private val delivering = AtomicBoolean(false)
    val event: EventListener<T> = this::onEvent

    companion object {
        private val LOG = Logger.getInstance(BufferedEmitter::class.java)
    }

    fun onEvent(listener: (T) -> Unit): Disposable {
        if (disposed.get()) return Disposable { }
        listeners.add(listener)
        if (disposed.get()) listeners.remove(listener) else deliverMessages()
        return Disposable { listeners.remove(listener) }
    }

    fun fire(event: T) {
        if (disposed.get()) return
        bufferedMessages.add(event)
        if (disposed.get()) bufferedMessages.clear() else deliverMessages()
    }

    fun flushBuffer() = bufferedMessages.clear()

    private fun deliverMessages() {
        if (disposed.get() || listeners.isEmpty() || !delivering.compareAndSet(false, true)) return
        try {
            while (!disposed.get() && listeners.isNotEmpty()) {
                val event = bufferedMessages.poll() ?: break
                listeners.forEach { listener ->
                    if (!disposed.get()) {
                        try {
                            listener(event)
                        } catch (error: Exception) {
                            if (error is ControlFlowException) throw error
                            LOG.warn("Error in event listener: ${error.message}", error)
                        }
                    }
                }
            }
        } finally {
            delivering.set(false)
            if (!disposed.get() && listeners.isNotEmpty() && bufferedMessages.isNotEmpty()) deliverMessages()
        }
    }

    override fun dispose() {
        disposed.set(true)
        listeners.clear()
        bufferedMessages.clear()
    }
}

typealias EventListener<T> = ((T) -> Unit) -> Disposable
