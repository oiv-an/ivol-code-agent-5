// SPDX-FileCopyrightText: 2025 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.kilocode.jetbrains.ipc

import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
import java.io.IOException
import java.util.ArrayDeque
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.CompletableFuture
import java.util.concurrent.atomic.AtomicBoolean

/** Persistent IPC for a local extension host. A dead host cannot retain an unbounded replay log. */
class PersistentProtocol(opts: PersistentProtocolOptions, msgListener: ((ByteArray) -> Unit)? = null) : IMessagePassingProtocol {
    companion object {
        private val LOG = Logger.getInstance(PersistentProtocol::class.java)
    }

    class PersistentProtocolOptions(
        val socket: ISocket,
        val initialChunk: ByteArray? = null,
        val loadEstimator: ILoadEstimator? = null,
        val sendKeepAlive: Boolean = true,
        val maxUnacknowledgedBytes: Long = 64L * 1024 * 1024,
        val maxUnacknowledgedMessages: Int = 2048,
        val timeoutMillis: Long = ProtocolConstants.TIMEOUT_TIME.toLong(),
        val startReceiving: Boolean = true,
    )

    private val maxBytes = opts.maxUnacknowledgedBytes
    private val maxMessages = opts.maxUnacknowledgedMessages
    private val timeoutMillis = opts.timeoutMillis
    private val loadEstimator = opts.loadEstimator ?: LoadEstimator.getInstance()
    private val outgoing = ArrayDeque<ProtocolMessage>()
    private var outgoingBytes = 0L
    private var outgoingId = 0
    private var outgoingAckId = 0
    private var incomingId = 0
    private var incomingAckId = 0
    private var lastReplayRequestTime = 0L
    private var isReconnecting = false
    private var didSendDisconnect = false
    @Volatile private var disposed = false
    private val failureRequested = AtomicBoolean(false)
    private val receivingStarted = AtomicBoolean(false)
    private var initialChunk = opts.initialChunk
    private val timer = Timer("IVOL-IPC", true)
    private var outgoingAckTask: TimerTask? = null
    private var incomingAckTask: TimerTask? = null
    private var socket = opts.socket
    private var writer = createWriter(socket)
    private var reader = ProtocolReader(socket)
    private val socketDisposables = mutableListOf<Disposable>()
    private val onControl = BufferedEmitter<ByteArray>()
    private val onData = BufferedEmitter<ByteArray>()
    private val onDispose = BufferedEmitter<Unit>()
    private val onClose = BufferedEmitter<SocketCloseEvent>()
    private val onTimeout = BufferedEmitter<SocketTimeoutEvent>()

    val unacknowledgedCount: Int get() = synchronized(this) { outgoing.size }
    internal val unacknowledgedBytes: Long get() = synchronized(this) { outgoingBytes }
    fun isDisposed(): Boolean = disposed || failureRequested.get()

    init {
        require(maxBytes > 0 && maxMessages > 0 && timeoutMillis > 0)
        attachSocket()
        if (msgListener != null) onData.event(msgListener)
        if (opts.sendKeepAlive && !disposed) {
            timer.scheduleAtFixedRate(object : TimerTask() {
                override fun run() = synchronized(this@PersistentProtocol) {
                    if (!disposed) {
                        incomingAckId = incomingId
                        writeControl(ProtocolMessageType.KEEP_ALIVE, incomingId)
                    }
                }
            }, ProtocolConstants.KEEP_ALIVE_SEND_TIME.toLong(), ProtocolConstants.KEEP_ALIVE_SEND_TIME.toLong())
        }
        if (opts.startReceiving) startReceiving()
    }

    /** The owner may assign its protocol field before a peer's Ready message is delivered. */
    fun startReceiving() {
        if (isDisposed() || !receivingStarted.compareAndSet(false, true)) return
        initialChunk?.let { reader.acceptChunk(it) }
        initialChunk = null
        if (!isDisposed()) socket.startReceiving()
    }

    private fun createWriter(socket: ISocket, initialId: Int = 1) = ProtocolWriter(
        socket, onError = { failConnection(it) }, initialExpectedId = initialId,
    )

    private fun attachSocket() {
        val attachedSocket = socket
        socketDisposables.add(reader.onMessage(this::receiveMessage))
        socketDisposables.add(socket.onClose { event ->
            if (!isDisposed() && socket === attachedSocket) {
                try {
                    onClose.fire(event)
                } finally {
                    dispose()
                }
            }
        })
    }

    override fun dispose() {
        val droppedCount = synchronized(this) {
            if (disposed) return
            disposed = true // First: racing producers/timers must not enqueue or resurrect this host.
            timer.cancel()
            timer.purge()
            outgoingAckTask = null
            incomingAckTask = null
            socketDisposables.forEach { it.dispose() }
            socketDisposables.clear()
            writer.dispose()
            reader.dispose()
            val count = outgoing.size
            outgoing.clear()
            outgoingBytes = 0
            initialChunk = null
            count
        }
        socket.dispose()
        // Propagate failure to pending RPC callers and unregister project listeners.
        try {
            onDispose.fire(Unit)
        } finally {
            onData.dispose()
            onControl.dispose()
            onClose.dispose()
            onTimeout.dispose()
            onDispose.dispose()
        }
        LOG.info("PersistentProtocol closed; released $droppedCount undelivered/unacknowledged messages")
    }

    override suspend fun drain() { writer.drain() }

    override fun send(buffer: ByteArray) {
        try {
            synchronized(this) {
                if (isDisposed()) throw IOException("Extension host IPC connection is closed")
                if (outgoingBytes + buffer.size > maxBytes || outgoing.size >= maxMessages) {
                    throw IOException("Extension host stopped acknowledging IPC messages; safe queue limit reached")
                }
                incomingAckId = incomingId
                val msg = ProtocolMessage(ProtocolMessageType.REGULAR, ++outgoingId, incomingId, buffer)
                msg.writtenTime = System.currentTimeMillis()
                outgoing.addLast(msg)
                outgoingBytes += buffer.size
                if (!isReconnecting) {
                    writer.write(msg)
                    scheduleAckCheck()
                }
            }
        } catch (error: IOException) {
            failConnection(error)
            throw error
        }
    }

    override fun onMessage(listener: MessageListener): Disposable = onData.event { listener.onMessage(it) }
    override fun onDidDispose(listener: () -> Unit): Disposable {
        synchronized(this) {
            if (!disposed) return onDispose.event { listener() }
        }
        listener()
        return Disposable { }
    }
    fun onControlMessage(listener: (ByteArray) -> Unit): Disposable = onControl.event(listener)
    fun onSocketClose(listener: (SocketCloseEvent) -> Unit): Disposable = onClose.event(listener)
    fun onSocketTimeout(listener: (SocketTimeoutEvent) -> Unit): Disposable = onTimeout.event(listener)

    fun sendDisconnect() {
        val currentWriter = synchronized(this) {
            if (disposed || didSendDisconnect) return
            didSendDisconnect = true
            writeControl(ProtocolMessageType.DISCONNECT)
            writer
        }
        // A socket error can call back into this protocol while a writer holds its I/O lock.
        // Never wait for that lock while holding the protocol monitor.
        currentWriter.flush()
    }
    @Synchronized fun sendPause() = writeControl(ProtocolMessageType.PAUSE)
    @Synchronized fun sendResume() = writeControl(ProtocolMessageType.RESUME)
    fun pauseSocketWriting() = writer.pause()
    fun getSocket(): ISocket = socket
    fun getMillisSinceLastIncomingData(): Long = System.currentTimeMillis() - reader.getLastReadTime()
    fun readEntireBuffer(): ByteArray = reader.readEntireBuffer()
    fun flush() = writer.flush()

    fun beginAcceptReconnection(newSocket: ISocket, initialDataChunk: ByteArray?) {
        val currentReader = synchronized(this) {
            check(!disposed) { "Cannot reconnect a disposed local extension host" }
            isReconnecting = true
            socketDisposables.forEach { it.dispose() }
            socketDisposables.clear()
            writer.dispose()
            reader.dispose()
            socket.dispose()
            socket = newSocket
            writer = createWriter(socket, outgoing.peekFirst()?.id ?: outgoingId + 1)
            reader = ProtocolReader(socket)
            attachSocket()
            lastReplayRequestTime = 0
            reader
        }
        if (initialDataChunk != null) currentReader.acceptChunk(initialDataChunk)
        if (!isDisposed()) newSocket.startReceiving()
    }

    @Synchronized fun endAcceptReconnection() {
        if (disposed) return
        isReconnecting = false
        incomingAckId = incomingId
        writeControl(ProtocolMessageType.ACK, incomingId)
        outgoing.toList().forEach { writer.write(it) }
        scheduleAckCheck()
    }
    fun acceptDisconnect() = dispose()

    private fun receiveMessage(msg: ProtocolMessage) {
        val notify = synchronized(this) {
            if (isDisposed()) return
            if (msg.ack > outgoingAckId && msg.ack <= outgoingId) {
                outgoingAckId = msg.ack
                while (outgoing.isNotEmpty() && outgoing.peekFirst().id <= msg.ack) {
                    outgoingBytes -= outgoing.removeFirst().data.size
                }
                if (outgoing.isEmpty()) {
                    outgoingAckTask?.cancel()
                    outgoingAckTask = null
                    timer.purge()
                }
            }
            when (msg.type) {
                ProtocolMessageType.REGULAR -> if (msg.id > incomingId) {
                    if (msg.id != incomingId + 1) {
                        val now = System.currentTimeMillis()
                        if (now - lastReplayRequestTime > 10000) {
                            lastReplayRequestTime = now
                            writeControl(ProtocolMessageType.REPLAY_REQUEST)
                        }
                    } else {
                        incomingId = msg.id
                        scheduleIncomingAck()
                        return@synchronized { onData.fire(msg.data) }
                    }
                }
                ProtocolMessageType.CONTROL -> return@synchronized { onControl.fire(msg.data) }
                ProtocolMessageType.DISCONNECT -> return@synchronized { dispose() }
                ProtocolMessageType.REPLAY_REQUEST -> {
                    outgoing.toList().forEach { writer.write(it) }
                    scheduleAckCheck()
                }
                ProtocolMessageType.PAUSE -> writer.pause()
                ProtocolMessageType.RESUME -> writer.resume()
                else -> Unit
            }
            null
        }
        // RPC completions may synchronously run application code that sends more messages.
        // Never run those callbacks while holding the transport state lock.
        notify?.invoke()
    }

    private fun scheduleIncomingAck() {
        if (disposed || incomingAckTask != null || incomingId <= incomingAckId) return
        incomingAckTask = object : TimerTask() {
            override fun run() = synchronized(this@PersistentProtocol) {
                incomingAckTask = null
                if (!disposed && incomingId > incomingAckId) {
                    incomingAckId = incomingId
                    writeControl(ProtocolMessageType.ACK, incomingId)
                }
            }
        }.also { timer.schedule(it, ProtocolConstants.ACKNOWLEDGE_TIME.toLong()) }
    }

    private fun scheduleAckCheck() {
        if (disposed || isReconnecting || outgoing.isEmpty() || outgoingAckTask != null) return
        outgoingAckTask = object : TimerTask() {
            override fun run() {
                val timeout = synchronized(this@PersistentProtocol) {
                    outgoingAckTask = null
                    if (isDisposed() || isReconnecting) return
                    val oldest = outgoing.peekFirst() ?: return
                    val age = System.currentTimeMillis() - oldest.writtenTime
                    val silence = getMillisSinceLastIncomingData()
                    // Keepalives must not preserve an unacknowledged queue forever. Give a busy peer
                    // a bounded grace period, then fail explicitly (disk-backed task state is untouched).
                    if ((age >= timeoutMillis && silence >= timeoutMillis && !loadEstimator.hasHighLoad()) ||
                        age >= timeoutMillis * 5
                    ) {
                        SocketTimeoutEvent(outgoing.size, age, silence)
                    } else {
                        scheduleAckCheck()
                        null
                    }
                }
                if (timeout != null) {
                    onTimeout.fire(timeout)
                    failConnection(IOException("Extension host IPC acknowledgement timed out"))
                }
            }
        }.also { timer.schedule(it, timeoutMillis) }
    }

    private fun writeControl(type: ProtocolMessageType, ack: Int = 0) {
        if (disposed) return
        try {
            writer.write(ProtocolMessage(type, 0, ack, ByteArray(0)))
        } catch (error: IOException) {
            failConnection(error)
        }
    }

    private fun failConnection(error: Exception) {
        if (disposed || !failureRequested.compareAndSet(false, true)) return
        LOG.warn("Closing failed extension host IPC: ${error.message}")
        if (Thread.holdsLock(this)) {
            // A synchronous enqueue failure occurs under the state lock. Stop accepting sends
            // immediately, then release actors/callbacks after that lock has been released.
            CompletableFuture.runAsync { dispose() }
        } else {
            dispose()
        }
    }
}
