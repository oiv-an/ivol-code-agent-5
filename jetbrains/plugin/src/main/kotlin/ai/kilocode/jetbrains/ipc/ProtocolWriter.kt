// SPDX-FileCopyrightText: 2025 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.kilocode.jetbrains.ipc

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.IOException
import java.nio.ByteBuffer
import java.util.ArrayDeque
import java.util.TreeMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** Ordered, bounded transport queue. Failed writes terminate the connection, never claim delivery. */
class ProtocolWriter(
    private val socket: ISocket,
    @Suppress("UNUSED_PARAMETER") enableLogging: Boolean = false,
    private val onError: (Exception) -> Unit = {},
    private val maxQueuedBytes: Long = 64L * 1024 * 1024,
    private val maxQueuedMessages: Int = 4096,
    initialExpectedId: Int = 1,
) {
    private val isDisposed = AtomicBoolean(false)
    private val isPaused = AtomicBoolean(false)
    private val lastWriteTime = AtomicLong(0)
    private val queueLock = Any()
    private val writeLock = Any()
    private val messageQueue = TreeMap<Int, ByteArray>()
    private val priorityQueue = ArrayDeque<ByteArray>()
    private var nextExpectedId = initialExpectedId
    private var queuedBytes = 0L
    private val isWriteScheduled = AtomicBoolean(false)
    private val coroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    internal val bufferedBytes: Long get() = synchronized(queueLock) { queuedBytes }

    fun dispose() {
        if (!isDisposed.compareAndSet(false, true)) return
        coroutineScope.cancel()
        synchronized(queueLock) {
            messageQueue.clear()
            priorityQueue.clear()
            queuedBytes = 0
        }
    }

    suspend fun drain() {
        flush()
        socket.drain()
    }

    fun flush() = writeNow()
    fun pause() { isPaused.set(true) }
    fun resume() {
        isPaused.set(false)
        scheduleWriting()
    }

    fun write(msg: ProtocolMessage) {
        try {
            synchronized(queueLock) {
                if (isDisposed.get()) throw IOException("IPC writer is closed")
                val size = ProtocolConstants.HEADER_LENGTH.toLong() + msg.data.size
                val replacedSize = if (msg.id >= nextExpectedId) messageQueue[msg.id]?.size ?: 0 else 0
                if (queuedBytes - replacedSize + size > maxQueuedBytes ||
                    messageQueue.size + priorityQueue.size >= maxQueuedMessages
                ) throw IOException("IPC write queue exceeded its safe memory limit")

                // Allocate once, without boxing every byte or concatenating a whole backlog.
                val frame = ByteBuffer.allocate(size.toInt())
                    .put(msg.type.value.toByte()).putInt(msg.id).putInt(msg.ack)
                    .putInt(msg.data.size).put(msg.data).array()
                val now = System.currentTimeMillis()
                if (msg.writtenTime == 0L) msg.writtenTime = now
                lastWriteTime.set(now)
                if (msg.id <= 0 || msg.id < nextExpectedId) {
                    // Replays retain their original IDs and must not wait for an already sent ID.
                    priorityQueue.addLast(frame)
                } else {
                    messageQueue.put(msg.id, frame)?.let { queuedBytes -= it.size }
                }
                queuedBytes += frame.size
            }
            scheduleWriting()
        } catch (error: IOException) {
            fail(error)
            throw error
        }
    }

    private fun hasSendableData(): Boolean = synchronized(queueLock) {
        priorityQueue.isNotEmpty() || messageQueue.containsKey(nextExpectedId)
    }

    private fun scheduleWriting() {
        if (isPaused.get() || isDisposed.get() || !hasSendableData()) return
        if (!isWriteScheduled.compareAndSet(false, true)) return
        coroutineScope.launch {
            try {
                writeNow()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                fail(error)
            } finally {
                isWriteScheduled.set(false)
                // Do not spin if the queue is waiting for a missing message ID.
                if (!isDisposed.get() && hasSendableData()) scheduleWriting()
            }
        }
    }

    private fun writeNow() = synchronized(writeLock) {
        while (!isPaused.get() && !isDisposed.get()) {
            val frame = synchronized(queueLock) {
                val next = priorityQueue.pollFirst() ?: messageQueue.remove(nextExpectedId)?.also { nextExpectedId++ }
                next?.also { queuedBytes -= it.size }
            } ?: break
            if (isDisposed.get()) break
            try {
                socket.write(frame)
            } catch (error: Exception) {
                fail(error)
                throw error
            }
        }
    }

    private fun fail(error: Exception) {
        if (isDisposed.get()) return
        dispose()
        onError(error)
    }

    fun getLastWriteTime(): Long = lastWriteTime.get()
}
