package ai.kilocode.jetbrains.ipc

import ai.kilocode.jetbrains.ipc.proxy.CanceledException
import ai.kilocode.jetbrains.ipc.proxy.LazyPromise
import ai.kilocode.jetbrains.ipc.proxy.RPCProtocol
import ai.kilocode.jetbrains.ipc.proxy.MessageIO
import ai.kilocode.jetbrains.ipc.proxy.MessageType
import ai.kilocode.jetbrains.ipc.proxy.createProxyIdentifier
import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.ControlFlowException
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.nio.ByteBuffer
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean

class IpcMemoryLifecycleTest {
    private fun protocol(socket: FakeSocket, bytes: Long = 1024, messages: Int = 20, timeout: Long = 60000,
                         busy: Boolean = false): PersistentProtocol = PersistentProtocol(
        PersistentProtocol.PersistentProtocolOptions(socket, sendKeepAlive = false,
            loadEstimator = object : ILoadEstimator { override fun hasHighLoad() = busy },
            maxUnacknowledgedBytes = bytes, maxUnacknowledgedMessages = messages, timeoutMillis = timeout),
    )

    @Test fun disposeReleasesReplayQueueSocketSubscriptionsAndRejectsFutureSends() {
        val socket = FakeSocket()
        val protocol = protocol(socket)
        val disposedCount = AtomicInteger()
        protocol.onDidDispose { disposedCount.incrementAndGet() }
        protocol.pauseSocketWriting()
        protocol.send(ByteArray(400))
        assertEquals(400L, protocol.unacknowledgedBytes)
        protocol.dispose()
        protocol.dispose()
        assertEquals(0L, protocol.unacknowledgedBytes)
        assertEquals(0, protocol.unacknowledgedCount)
        assertEquals(1, disposedCount.get())
        assertEquals(1, socket.disposeCount)
        assertTrue(socket.dataListeners.isEmpty())
        assertTrue(socket.closeListeners.isEmpty())
        assertThrows(IOException::class.java) { protocol.send(ByteArray(1)) }
        protocol.onDidDispose { disposedCount.incrementAndGet() }
        assertEquals(2, disposedCount.get())
    }

    @Test fun byteLimitFailsConnectionInsteadOfSilentlyDroppingMessages() {
        val socket = FakeSocket()
        val protocol = protocol(socket, bytes = 600)
        protocol.send(ByteArray(400))
        assertThrows(IOException::class.java) { protocol.send(ByteArray(201)) }
        assertTrue(protocol.isDisposed())
        assertEquals(0L, protocol.unacknowledgedBytes)
        assertEquals(1, socket.disposeCount)
    }

    @Test fun countLimitAlsoBoundsTinyMessages() {
        val protocol = protocol(FakeSocket(), messages = 2)
        protocol.send(ByteArray(0))
        protocol.send(ByteArray(0))
        assertThrows(IOException::class.java) { protocol.send(ByteArray(0)) }
        assertTrue(protocol.isDisposed())
    }

    @Test fun acknowledgementReleasesExactlyAcknowledgedBytesAndPermitsMoreMessages() {
        val socket = FakeSocket()
        val protocol = protocol(socket, bytes = 600)
        try {
            protocol.send(ByteArray(200))
            protocol.send(ByteArray(300))
            socket.receive(frame(ProtocolMessageType.ACK, 0, 1))
            assertEquals(1, protocol.unacknowledgedCount)
            assertEquals(300L, protocol.unacknowledgedBytes)
            protocol.send(ByteArray(200))
            socket.receive(frame(ProtocolMessageType.ACK, 0, 3))
            assertEquals(0L, protocol.unacknowledgedBytes)
            assertFalse(protocol.isDisposed())
        } finally { protocol.dispose() }
    }

    @Test fun socketCloseAndPeerDisconnectAreFinalAndIdempotent() {
        for (disconnect in listOf(false, true)) {
            val socket = FakeSocket()
            val protocol = protocol(socket)
            protocol.send(ByteArray(300))
            if (disconnect) socket.receive(frame(ProtocolMessageType.DISCONNECT)) else socket.close()
            assertTrue(protocol.isDisposed())
            assertEquals(0L, protocol.unacknowledgedBytes)
            assertEquals(1, socket.disposeCount)
        }
    }

    @Test fun asynchronousWriteFailureClosesProtocolAndReleasesItsReplayQueue() {
        val socket = FakeSocket().apply { writeFailure = IOException("Broken pipe") }
        val protocol = protocol(socket)
        val disposed = CountDownLatch(1)
        protocol.onDidDispose { disposed.countDown() }
        protocol.send(ByteArray(100))
        assertTrue(disposed.await(3, TimeUnit.SECONDS))
        assertTrue(protocol.isDisposed())
        assertEquals(0L, protocol.unacknowledgedBytes)
    }

    @Test fun stalledPeerTimesOutEvenWhenLoadEstimatorStaysBusy() {
        val protocol = protocol(FakeSocket(), timeout = 20, busy = true)
        val closed = CountDownLatch(1)
        protocol.onDidDispose { closed.countDown() }
        protocol.send(ByteArray(100))
        try {
            assertTrue(closed.await(3, TimeUnit.SECONDS))
            assertEquals(0L, protocol.unacknowledgedBytes)
        } finally { protocol.dispose() }
    }

    @Test fun writerPreservesHeadersOrderingPauseResumeAndReplayWithoutBatchBoxing() {
        val socket = FakeSocket()
        val writer = ProtocolWriter(socket)
        try {
            writer.pause()
            writer.write(ProtocolMessage(ProtocolMessageType.REGULAR, 2, 7, byteArrayOf(22)))
            writer.write(ProtocolMessage(ProtocolMessageType.REGULAR, 1, 6, byteArrayOf(11)))
            writer.flush()
            assertTrue(socket.written.isEmpty())
            writer.resume()
            writer.flush()
            assertEquals(listOf(1, 2), socket.written.map { ByteBuffer.wrap(it).getInt(1) })
            assertArrayEquals(frame(ProtocolMessageType.REGULAR, 1, 6, byteArrayOf(11)), socket.written[0])
            writer.write(ProtocolMessage(ProtocolMessageType.REGULAR, 1, 6, byteArrayOf(11)))
            writer.flush()
            assertEquals(listOf(1, 2, 1), socket.written.map { ByteBuffer.wrap(it).getInt(1) })
            assertEquals(0L, writer.bufferedBytes)
        } finally { writer.dispose() }
    }

    @Test fun writerBoundsPausedQueueAndClearsItOnDispose() {
        val socket = FakeSocket()
        val errors = AtomicInteger()
        val writer = ProtocolWriter(socket, onError = { errors.incrementAndGet() }, maxQueuedBytes = 60)
        writer.pause()
        writer.write(ProtocolMessage(ProtocolMessageType.REGULAR, 1, 0, ByteArray(20)))
        assertThrows(IOException::class.java) {
            writer.write(ProtocolMessage(ProtocolMessageType.REGULAR, 2, 0, ByteArray(20)))
        }
        assertEquals(1, errors.get())
        assertEquals(0L, writer.bufferedBytes)
        writer.dispose()
        assertThrows(IOException::class.java) {
            writer.write(ProtocolMessage(ProtocolMessageType.REGULAR, 3, 0, ByteArray(1)))
        }
    }

    @Test fun reconnectionRetiresOldReaderWriterAndReplaysOnlyUnacknowledgedMessages() {
        val oldSocket = FakeSocket()
        val protocol = protocol(oldSocket)
        val newSocket = FakeSocket()
        try {
            protocol.send(byteArrayOf(1))
            protocol.send(byteArrayOf(2))
            protocol.flush()
            oldSocket.receive(frame(ProtocolMessageType.ACK, 0, 1))
            protocol.beginAcceptReconnection(newSocket, null)
            protocol.endAcceptReconnection()
            protocol.flush()
            assertTrue(oldSocket.dataListeners.isEmpty())
            assertEquals(1, oldSocket.disposeCount)
            assertEquals(listOf(0, 2), newSocket.written.map { ByteBuffer.wrap(it).getInt(1) })
            newSocket.receive(frame(ProtocolMessageType.ACK, 0, 2))
            assertEquals(0L, protocol.unacknowledgedBytes)
        } finally { protocol.dispose() }
    }

    @Test fun transportDisposalRejectsPendingRpcAndReleasesRegisteredActors() {
        val identifier = createProxyIdentifier<TestRemote>(TestRemote::class.java.name)
        val actorIdentifier = createProxyIdentifier<Disposable>("MemoryTestActor")
        val socket = FakeSocket()
        val transport = protocol(socket)
        val rpc = RPCProtocol(transport)
        val actorDisposals = AtomicInteger()
        rpc.set(actorIdentifier, Disposable { actorDisposals.incrementAndGet() })
        val remote = rpc.getProxy(identifier)
        val pending = remote.call("request")
        assertFalse(pending.isCompleted)
        transport.dispose()
        assertTrue(pending.isCancelled)
        assertEquals(1, actorDisposals.get())
        rpc.dispose()
        assertEquals(1, actorDisposals.get())
        assertThrows(CanceledException::class.java) { remote.call("closed") }
    }

    @Test fun disposeDuringFailedWriteDoesNotDeadlockSendDisconnect() {
        val writeEntered = CountDownLatch(1)
        val releaseWrite = CountDownLatch(1)
        val socket = FakeSocket().apply {
            beforeWrite = {
                writeEntered.countDown()
                assertTrue(releaseWrite.await(3, TimeUnit.SECONDS))
                close()
                throw IOException("Socket closed")
            }
        }
        val protocol = protocol(socket)
        protocol.send(byteArrayOf(1))
        assertTrue(writeEntered.await(3, TimeUnit.SECONDS))
        val disconnected = CountDownLatch(1)
        val thread = Thread {
            try { protocol.sendDisconnect() } finally { disconnected.countDown() }
        }.apply { isDaemon = true; start() }
        releaseWrite.countDown()
        assertTrue(disconnected.await(3, TimeUnit.SECONDS))
        thread.join(1000)
        protocol.dispose()
    }

    @Test fun disposedEmitterAndReaderStopRetainingEventsAndListeners() {
        val emitter = BufferedEmitter<ByteArray>()
        emitter.fire(ByteArray(500))
        emitter.dispose()
        var delivered = false
        emitter.onEvent { delivered = true }
        emitter.fire(ByteArray(500))
        assertFalse(delivered)
        val socket = FakeSocket()
        val reader = ProtocolReader(socket)
        socket.receive(frame(ProtocolMessageType.REGULAR, 1, 0, ByteArray(500)).copyOf(50))
        reader.dispose()
        reader.acceptChunk(ByteArray(500))
        assertTrue(reader.readEntireBuffer().isEmpty())
        assertTrue(socket.dataListeners.isEmpty())
    }

    @Test fun ownerCanPublishProtocolBeforeSynchronousReadyDelivery() {
        val socket = FakeSocket().apply { messageOnStart = frame(ProtocolMessageType.REGULAR, 1, 0, byteArrayOf(1)) }
        var ownerProtocol: PersistentProtocol? = null
        var callbackSawOwner = false
        val protocol = PersistentProtocol(PersistentProtocol.PersistentProtocolOptions(
            socket, startReceiving = false, sendKeepAlive = false,
            loadEstimator = object : ILoadEstimator { override fun hasHighLoad() = false },
        )) { callbackSawOwner = ownerProtocol != null }
        ownerProtocol = protocol
        assertFalse(callbackSawOwner)
        protocol.startReceiving()
        assertTrue(callbackSawOwner)
        protocol.dispose()
    }

    @Test fun applicationCallbacksNeverRunUnderTransportStateMonitor() {
        val socket = FakeSocket()
        val protocol = protocol(socket, bytes = 10)
        val lockHeld = AtomicBoolean(false)
        val received = AtomicInteger()
        protocol.onMessage { lockHeld.set(Thread.holdsLock(protocol)); received.incrementAndGet() }
        protocol.onDidDispose { if (Thread.holdsLock(protocol)) lockHeld.set(true); received.incrementAndGet() }
        socket.receive(frame(ProtocolMessageType.REGULAR, 1, 0, byteArrayOf(1)))
        assertThrows(IOException::class.java) { protocol.send(ByteArray(11)) }
        assertEquals(2, received.get())
        assertFalse(lockHeld.get())
    }

    @Test fun failedStorageHandlerReturnsRpcErrorInsteadOfFalseSuccess() {
        val actorId = createProxyIdentifier<ThrowingStorageActor>("ThrowingStorageActor")
        val socket = FakeSocket()
        val transport = protocol(socket, bytes = 10000)
        val rpc = RPCProtocol(transport)
        rpc.set(actorId, ThrowingStorageActor())
        val replySent = CountDownLatch(1)
        socket.afterWrite = { bytes ->
            if (bytes.size > ProtocolConstants.HEADER_LENGTH &&
                bytes[ProtocolConstants.HEADER_LENGTH].toInt() == MessageType.ReplyErrError.value
            ) replySent.countDown()
        }
        val request = MessageIO.serializeRequest(1, actorId.nid, "\$store",
            MessageIO.serializeRequestArguments(emptyList()), false)
        try {
            socket.receive(frame(ProtocolMessageType.REGULAR, 1, 0, request))
            assertTrue(replySent.await(3, TimeUnit.SECONDS))
            assertFalse(socket.written.any {
                it.size > ProtocolConstants.HEADER_LENGTH &&
                    it[ProtocolConstants.HEADER_LENGTH].toInt() == MessageType.ReplyOKEmpty.value
            })
        } finally { transport.dispose() }
    }

    @Test fun controlFlowDuringActorDisposalDoesNotStopOtherActorsCleanup() {
        val cancelledActor = createProxyIdentifier<Disposable>("CancelledActor")
        val nextActor = createProxyIdentifier<Disposable>("NextActor")
        val transport = protocol(FakeSocket())
        val rpc = RPCProtocol(transport)
        val nextDisposed = AtomicInteger()
        rpc.set(cancelledActor, Disposable { throw TestControlFlowException() })
        rpc.set(nextActor, Disposable { nextDisposed.incrementAndGet() })
        transport.dispose()
        assertEquals(1, nextDisposed.get())
    }

    @Test fun emitterRethrowsControlFlowInsteadOfReportingItAsAnError() {
        val emitter = BufferedEmitter<Unit>()
        emitter.onEvent { throw TestControlFlowException() }
        try {
            assertThrows(TestControlFlowException::class.java) { emitter.fire(Unit) }
        } finally { emitter.dispose() }
    }

    @Test fun rpcCreatedAgainstDisposedTransportDoesNotRetainSubscriptions() {
        val identifier = createProxyIdentifier<Disposable>("LateActor")
        val transport = protocol(FakeSocket())
        transport.dispose()
        val rpc = RPCProtocol(transport)
        val disposed = AtomicInteger()
        assertThrows(CanceledException::class.java) { rpc.set(identifier, Disposable { disposed.incrementAndGet() }) }
        assertEquals(1, disposed.get())
        val subscriptions = RPCProtocol::class.java.getDeclaredField("protocolSubscriptions").apply { isAccessible = true }
        assertTrue((subscriptions.get(rpc) as Collection<*>).isEmpty())
        rpc.dispose()
    }

    class TestControlFlowException : RuntimeException(), ControlFlowException

    class ThrowingStorageActor {
        fun store(): Unit = throw IOException("Storage write failed")
    }

    interface TestRemote {
        @Throws(CanceledException::class)
        fun call(value: String): LazyPromise
    }

    private class FakeSocket : ISocket {
        val dataListeners = CopyOnWriteArrayList<ISocket.DataListener>()
        val closeListeners = CopyOnWriteArrayList<ISocket.CloseListener>()
        val written = CopyOnWriteArrayList<ByteArray>()
        @Volatile var disposeCount = 0
        var writeFailure: IOException? = null
        var beforeWrite: (() -> Unit)? = null
        var afterWrite: ((ByteArray) -> Unit)? = null
        var messageOnStart: ByteArray? = null
        override fun onData(listener: ISocket.DataListener): Disposable {
            dataListeners.add(listener)
            return Disposable { dataListeners.remove(listener) }
        }
        override fun onClose(listener: ISocket.CloseListener): Disposable {
            closeListeners.add(listener)
            return Disposable { closeListeners.remove(listener) }
        }
        override fun onEnd(listener: () -> Unit): Disposable = Disposable { }
        override fun write(buffer: ByteArray) {
            beforeWrite?.invoke()
            writeFailure?.let { throw it }
            if (disposeCount > 0) throw IOException("Socket disposed")
            written.add(buffer)
            afterWrite?.invoke(buffer)
        }
        override fun end() = close()
        override suspend fun drain() = Unit
        override fun traceSocketEvent(type: SocketDiagnosticsEventType, data: Any?) = Unit
        override fun startReceiving() { messageOnStart?.let { receive(it) } }
        override fun dispose() { disposeCount++; dataListeners.clear(); closeListeners.clear() }
        fun close() = closeListeners.forEach { it.onClose(SocketCloseEvent.NodeSocketCloseEvent(false, null)) }
        fun receive(data: ByteArray) = dataListeners.forEach { it.onData(data) }
    }

    private fun frame(type: ProtocolMessageType, id: Int = 0, ack: Int = 0, data: ByteArray = ByteArray(0)): ByteArray =
        ByteBuffer.allocate(ProtocolConstants.HEADER_LENGTH + data.size)
            .put(type.value.toByte()).putInt(id).putInt(ack).putInt(data.size).put(data).array()
}
