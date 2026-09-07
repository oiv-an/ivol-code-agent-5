package ai.kilocode.jetbrains.core

import ai.kilocode.jetbrains.editor.EditorAndDocManager
import ai.kilocode.jetbrains.ipc.NodeSocket
import ai.kilocode.jetbrains.ipc.PersistentProtocol
import ai.kilocode.jetbrains.ipc.proxy.ResponsiveState
import ai.kilocode.jetbrains.util.MachineIdUtil
import ai.kilocode.jetbrains.util.PluginConstants
import ai.kilocode.jetbrains.util.PluginResourceUtil
import ai.kilocode.jetbrains.util.URI
import ai.kilocode.jetbrains.workspace.WorkspaceFileChangeManager
import com.google.gson.Gson
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.diagnostic.ControlFlowException
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import java.net.Socket
import java.nio.channels.SocketChannel
import java.nio.file.Paths
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Extension host manager, responsible for communication with extension processes.
 * Handles Ready and Initialized messages from extension processes.
 */
class ExtensionHostManager : Disposable {
    companion object {
        val LOG = Logger.getInstance(ExtensionHostManager::class.java)
        private const val INITIALIZATION_TIMEOUT_MS = 60000L // 60 seconds
        private const val MAX_QUEUED_MESSAGES = 256
    }

    private val project: Project
    private val coroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    // Communication protocol
    private var nodeSocket: NodeSocket
    @Volatile private var protocol: PersistentProtocol? = null

    // RPC manager
    @Volatile private var rpcManager: RPCManager? = null

    // Extension manager
    private var extensionManager: ExtensionManager? = null

    // Plugin identifier
    private var rooCodeIdentifier: String? = null

    // JSON serialization
    private val gson = Gson()

    // Last diagnostic log time
    private var lastDiagnosticLogTime = 0L

    private var projectPath: String? = null

    // Initialization state management with state machine
    val stateMachine = InitializationStateMachine()
    private val messageQueue = ConcurrentLinkedQueue<() -> Unit>()
    private val queueLock = ReentrantLock()
    private var completionCheckTimer: java.util.Timer? = null
    private val disposed = java.util.concurrent.atomic.AtomicBoolean(false)
    private var processingQueue = false

    private fun isUnavailable() = disposed.get() || project.isDisposed

    // Support Socket constructor
    constructor(clientSocket: Socket, projectPath: String, project: Project) {
        clientSocket.tcpNoDelay = true
        this.nodeSocket = NodeSocket(clientSocket, "extension-host")
        this.projectPath = projectPath
        this.project = project
    }

    // Support SocketChannel constructor
    constructor(clientChannel: SocketChannel, projectPath: String, project: Project) {
        this.nodeSocket = NodeSocket(clientChannel, "extension-host")
        this.projectPath = projectPath
        this.project = project
    }

    /**
     * Start communication with the extension process.
     */
    fun start() {
        if (isUnavailable()) return
        if (!stateMachine.transitionTo(InitializationState.SOCKET_CONNECTING, "start()")) return
        
        try {
            // Initialize extension manager
            extensionManager = ExtensionManager()
            val extensionPath = PluginResourceUtil.getResourcePath(PluginConstants.PLUGIN_ID, PluginConstants.PLUGIN_CODE_DIR)
            rooCodeIdentifier = extensionPath?.let { extensionManager!!.registerExtension(it).identifier.value }
            
            // Create protocol
            val createdProtocol = PersistentProtocol(
                PersistentProtocol.PersistentProtocolOptions(
                    socket = nodeSocket,
                    initialChunk = null,
                    loadEstimator = null,
                    sendKeepAlive = true,
                    startReceiving = false,
                ),
                this::handleMessage,
            )
            val accepted = queueLock.withLock {
                if (isUnavailable()) false else {
                    protocol = createdProtocol
                    true
                }
            }
            if (!accepted) {
                createdProtocol.dispose()
                return
            }
            createdProtocol.onDidDispose {
                stateMachine.transitionTo(InitializationState.FAILED, "Extension host IPC connection closed")
                dispose()
            }

            if (isUnavailable()) {
                dispose()
                return
            }

            stateMachine.transitionTo(InitializationState.SOCKET_CONNECTED, "Protocol created")
            // Ready can arrive synchronously. Publish the protocol and the connected
            // state before the receiver is allowed to invoke the handshake callbacks.
            createdProtocol.startReceiving()
            LOG.info("ExtensionHostManager started successfully")
        } catch (e: Exception) {
            if (e is ControlFlowException) throw e
            if (isUnavailable()) return
            LOG.error("Failed to start ExtensionHostManager", e)
            stateMachine.transitionTo(InitializationState.FAILED, "start() exception: ${e.message}")
            dispose()
        }
    }

    /**
     * Wait for extension host to be ready.
     * @return CompletableFuture that completes when extension host is initialized.
     */
    fun waitForReady(): CompletableFuture<Boolean> {
        if (isUnavailable()) return CompletableFuture.completedFuture(false)
        return stateMachine.waitForState(InitializationState.EXTENSION_ACTIVATED)
            .thenApply { !isUnavailable() }
            .orTimeout(INITIALIZATION_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .exceptionally { ex ->
                if (!isUnavailable()) LOG.warn("Extension host initialization timeout or failure", ex)
                false
            }
    }

    /**
     * Queue a message to be sent after initialization.
     * If already initialized, executes immediately.
     * Uses lock to prevent race condition between checking state and adding to queue.
     * @param message The message function to execute.
     */
    fun queueMessage(message: () -> Unit) {
        var overflow = false
        val ready = queueLock.withLock {
            val currentState = stateMachine.getCurrentState()
            if (isUnavailable() || currentState == InitializationState.FAILED) {
                messageQueue.clear()
                return
            }
            if (messageQueue.size >= MAX_QUEUED_MESSAGES) {
                overflow = true
                false
            } else {
                messageQueue.offer(message)
                currentState.ordinal >= InitializationState.EXTENSION_ACTIVATED.ordinal
            }
        }
        if (overflow) {
            LOG.warn("Extension host initialization message queue exceeded its safe limit; closing failed host")
            dispose()
        } else if (ready) {
            processQueuedMessages()
        }
    }

    /**
     * Get RPC responsive state.
     * @return Responsive state, or null if RPC manager is not initialized.
     */
    fun getResponsiveState(): ResponsiveState? {
        val currentTime = System.currentTimeMillis()
        // Limit diagnostic log frequency, at most once every 60 seconds
        val shouldLogDiagnostics = currentTime - lastDiagnosticLogTime > 60000
        if (rpcManager == null) {
            if (shouldLogDiagnostics) {
                LOG.debug("Unable to get responsive state: RPC manager is not initialized")
                lastDiagnosticLogTime = currentTime
            }
            return null
        }
        // Log connection diagnostic information
        if (shouldLogDiagnostics) {
            val socketInfo = buildString {
                append("NodeSocket: ")
                append(if (nodeSocket.isClosed()) "closed" else "active")
                append(", input stream: ")
                append(if (nodeSocket.isInputClosed()) "closed" else "normal")
                append(", output stream: ")
                append(if (nodeSocket.isOutputClosed()) "closed" else "normal")
                append(", disposed=")
                append(nodeSocket.isDisposed())
            }

            val protocolInfo = protocol?.let { proto ->
                "Protocol: ${if (proto.isDisposed()) "disposed" else "active"}"
            } ?: "Protocol is null"
            LOG.debug("Connection diagnostics: $socketInfo, $protocolInfo")
            lastDiagnosticLogTime = currentTime
        }
        return rpcManager?.getRPCProtocol()?.responsiveState
    }

    /**
     * Handle messages from the extension process.
     */
    private fun handleMessage(data: ByteArray) {
        if (isUnavailable()) return
        // Check if data is a single-byte message (extension host protocol message)
        if (data.size == 1) {
            // Try to parse as extension host message type

            when (ExtensionHostMessageType.fromData(data)) {
                ExtensionHostMessageType.Ready -> handleReadyMessage()
                ExtensionHostMessageType.Initialized -> handleInitializedMessage()
                ExtensionHostMessageType.Terminate -> LOG.info("Received Terminate message")
                null -> LOG.debug("Received unknown message type: ${data.contentToString()}")
            }
        } else {
            LOG.debug("Received message with length ${data.size}, not handling as extension host message")
        }
    }

    /**
     * Handle Ready message, send initialization data.
     */
    private fun handleReadyMessage() {
        if (isUnavailable()) return
        if (!stateMachine.transitionTo(InitializationState.READY_RECEIVED, "handleReadyMessage()")) {
            return
        }
        
        LOG.info("Received Ready message from extension host")

        try {
            // Build initialization data
            val initData = createInitData()

            // Send initialization data
            val jsonData = gson.toJson(initData).toByteArray()

            if (isUnavailable()) return
            (protocol ?: throw IllegalStateException("Protocol is not initialized")).send(jsonData)
            
            stateMachine.transitionTo(InitializationState.INIT_DATA_SENT, "Init data sent")
            LOG.info("Sent initialization data to extension host")
        } catch (e: Exception) {
            if (e is ControlFlowException) throw e
            if (isUnavailable()) return
            LOG.error("Failed to handle Ready message", e)
            stateMachine.transitionTo(InitializationState.FAILED, "handleReadyMessage() exception: ${e.message}")
            dispose()
        }
    }

    /**
     * Handle Initialized message, create RPC manager and activate plugin.
     */
    private fun handleInitializedMessage() {
        if (isUnavailable()) return
        if (!stateMachine.transitionTo(InitializationState.INITIALIZED_RECEIVED, "handleInitializedMessage()")) {
            return
        }
        
        LOG.info("Received Initialized message from extension host")

        try {
            val protocol = this.protocol ?: throw IllegalStateException("Protocol is not initialized")
            val extensionManager = this.extensionManager ?: throw IllegalStateException("ExtensionManager is not initialized")

            stateMachine.transitionTo(InitializationState.RPC_CREATING, "Creating RPC manager")
            
            // Create RPC manager
            val createdManager = RPCManager(protocol, extensionManager, null, project)
            val accepted = queueLock.withLock {
                if (isUnavailable()) false else {
                    rpcManager = createdManager
                    true
                }
            }
            if (!accepted) {
                createdManager.getRPCProtocol().dispose()
                return
            }

            stateMachine.transitionTo(InitializationState.RPC_CREATED, "RPC manager created")
            
            // Start initialization process
            createdManager.startInitialize()

            // Start file monitoring
            if (isUnavailable()) return
            project.getService(WorkspaceFileChangeManager::class.java)

            stateMachine.transitionTo(InitializationState.EXTENSION_ACTIVATING, "Activating extension")
            
            // Activate RooCode plugin
            val rooCodeId = rooCodeIdentifier ?: throw IllegalStateException("RooCode identifier is not initialized")
            extensionManager.activateExtension(rooCodeId, createdManager.getRPCProtocol())
                .whenComplete { _, error ->
                    if (isUnavailable()) return@whenComplete
                    if (error != null) {
                        LOG.error("Failed to activate RooCode plugin", error)
                        stateMachine.transitionTo(InitializationState.FAILED, "Extension activation failed: ${error.message}")
                        dispose()
                    } else {
                        LOG.info("RooCode plugin activated successfully")
                        stateMachine.transitionTo(InitializationState.EXTENSION_ACTIVATED, "Extension activated")
                        
                        // Process queued messages atomically
                        processQueuedMessages()
                        
                        // Now safe to initialize editors
                        if (isUnavailable()) return@whenComplete
                        project.getService(EditorAndDocManager::class.java).initCurrentIdeaEditor()
                        
                        // Schedule a check to transition to COMPLETE if webview isn't registered
                        // This handles cases where the extension doesn't use webviews
                        scheduleCompletionCheck()
                    }
                }

            LOG.info("Initialized extension host")
        } catch (e: Exception) {
            if (e is ControlFlowException) throw e
            if (isUnavailable()) return
            LOG.error("Failed to handle Initialized message", e)
            stateMachine.transitionTo(InitializationState.FAILED, "handleInitializedMessage() exception: ${e.message}")
            dispose()
        }
    }
    
    /**
     * Process all queued messages atomically.
     * This method is called after extension activation to ensure no messages are lost.
     */
    private fun processQueuedMessages() {
        queueLock.withLock {
            if (isUnavailable() || processingQueue) return
            processingQueue = true
        }
        try {
            while (true) {
                val message = queueLock.withLock {
                    if (isUnavailable()) {
                        messageQueue.clear()
                        processingQueue = false
                        return
                    }
                    messageQueue.poll() ?: run {
                        processingQueue = false
                        return
                    }
                }
                // Never hold queueLock while invoking RPC/user callbacks. A reply may
                // synchronously complete activation and need this same queue.
                try {
                    if (!isUnavailable()) message()
                } catch (e: Exception) {
                    if (e is ControlFlowException) throw e
                    if (!isUnavailable()) LOG.warn("Error processing queued message", e)
                }
            }
        } catch (error: Throwable) {
            queueLock.withLock { processingQueue = false }
            dispose()
            throw error
        }
    }
    
    /**
     * Schedule a check to transition to COMPLETE state if webview registration doesn't happen.
     * This handles cases where the extension doesn't require webviews.
     */
    private fun scheduleCompletionCheck() {
        queueLock.withLock {
            if (isUnavailable()) return
            completionCheckTimer?.cancel()
            completionCheckTimer = java.util.Timer("IVOL-Host-Completion", true).apply {
                schedule(object : java.util.TimerTask() {
                    override fun run() {
                        if (isUnavailable()) return
                        if (stateMachine.getCurrentState() == InitializationState.EXTENSION_ACTIVATED) {
                            stateMachine.transitionTo(InitializationState.COMPLETE, "Extension activated without webview")
                        }
                    }
                }, 10000)
            }
        }
    }

    /**
     * Create initialization data.
     * Corresponds to the initData object in main.js.
     */
    private fun createInitData(): Map<String, Any?> {
        val pluginDir = getPluginDir()
        val basePath = projectPath

        return mapOf(
            "commit" to "development",
            "version" to getIDEVersion(),
            "quality" to null,
            "parentPid" to ProcessHandle.current().pid(),
            "environment" to mapOf(
                "isExtensionDevelopmentDebug" to false,
                "appName" to getCurrentIDEName(),
                "appHost" to "node",
                "appLanguage" to "en",
                "appUriScheme" to "vscode",
                "appRoot" to uriFromPath(pluginDir),
                "globalStorageHome" to uriFromPath(Paths.get(System.getProperty("user.home"), ".kilocode", "globalStorage").toString()),
                "workspaceStorageHome" to uriFromPath(Paths.get(System.getProperty("user.home"), ".kilocode", "workspaceStorage").toString()),
                "extensionDevelopmentLocationURI" to null,
                "extensionTestsLocationURI" to null,
                "useHostProxy" to false,
                "skipWorkspaceStorageLock" to false,
                "isExtensionTelemetryLoggingOnly" to false,
            ),
            "workspace" to mapOf(
                "id" to "intellij-workspace",
                "name" to "IntelliJ Workspace",
                "transient" to false,
                "configuration" to null,
                "isUntitled" to false,
            ),
            "remote" to mapOf(
                "authority" to null,
                "connectionData" to null,
                "isRemote" to false,
            ),
            "extensions" to mapOf<String, Any>(
                "versionId" to 1,
                "allExtensions" to (extensionManager?.getAllExtensionDescriptions() ?: emptyList<Any>()),
                "myExtensions" to (extensionManager?.getAllExtensionDescriptions()?.map { it.identifier } ?: emptyList<Any>()),
                "activationEvents" to (
                    extensionManager?.getAllExtensionDescriptions()?.associate { ext ->
                        ext.identifier.value to (ext.activationEvents ?: emptyList<String>())
                    } ?: emptyMap()
                    ),
            ),
            "telemetryInfo" to mapOf(
                "sessionId" to "intellij-session",
                "machineId" to MachineIdUtil.getMachineId(),
                "sqmId" to "",
                "devDeviceId" to "",
                "firstSessionDate" to java.time.Instant.now().toString(),
                "msftInternal" to false,
            ),
            "logLevel" to 0, // Info level
            "loggers" to emptyList<Any>(),
            "logsLocation" to uriFromPath(Paths.get(pluginDir, "logs").toString()),
            "autoStart" to true,
            "consoleForward" to mapOf(
                "includeStack" to false,
                "logNative" to false,
            ),
            "uiKind" to 1, // Desktop
        )
    }

    /**
     * Get current IDE name.
     */
    private fun getCurrentIDEName(): String {
        val applicationInfo = ApplicationInfo.getInstance()
        val productCode = applicationInfo.build.productCode
        val version = applicationInfo.shortVersion ?: "1.0.0"

        // Return in the format: wrapper|jetbrains|productCode
        val result = "wrapper|jetbrains|$productCode|$version"
        return result
    }

    /**
     * Get current IDE version.
     */
    private fun getIDEVersion(): String {
        val applicationInfo = ApplicationInfo.getInstance()
        val version = applicationInfo.shortVersion ?: "1.0.0"
        LOG.info("Get IDE version: $version")

        val pluginVersion = PluginManagerCore.getPlugin(PluginId.getId(PluginConstants.PLUGIN_ID))?.version
        if (pluginVersion != null) {
            val fullVersion = "$version, $pluginVersion"
            LOG.info("Get IDE version and plugin version: $fullVersion")
            return fullVersion
        }

        return version
    }

    /**
     * Get plugin directory.
     */
    private fun getPluginDir(): String {
        return PluginResourceUtil.getResourcePath(PluginConstants.PLUGIN_ID, "")
            ?: throw IllegalStateException("Unable to get plugin directory")
    }

    /**
     * Create URI object.
     */
    private fun uriFromPath(path: String): URI {
        return URI.file(path)
    }

    /**
     * Get initialization report for diagnostics.
     * @return String containing initialization state machine report.
     */
    fun getInitializationReport(): String {
        return stateMachine.generateReport()
    }
    
    /**
     * Restart initialization if stuck or failed.
     * This method resets the state machine and clears the message queue,
     * then restarts the initialization process.
     */
    fun restartInitialization() {
        if (isUnavailable()) return
        LOG.warn("Restarting initialization")
        
        // Reset state machine
        stateMachine.transitionTo(InitializationState.NOT_STARTED, "Manual restart")
        
        // Clear message queue
        queueLock.withLock {
            val queueSize = messageQueue.size
            if (queueSize > 0) {
                LOG.info("Clearing $queueSize queued messages")
                messageQueue.clear()
            }
        }
        
        // Restart
        start()
    }

    /**
     * Resource disposal.
     */
    override fun dispose() {
        val resources = queueLock.withLock {
            if (!disposed.compareAndSet(false, true)) return
            messageQueue.clear()
            completionCheckTimer?.cancel()
            completionCheckTimer?.purge()
            completionCheckTimer = null
            val ownedResources = rpcManager to protocol
            rpcManager = null
            protocol = null
            extensionManager = null
            ownedResources
        }
        LOG.info("Disposing ExtensionHostManager")
        stateMachine.transitionTo(InitializationState.FAILED, "Extension host disposed")
        
        // Log final state before disposal
        LOG.info("Final initialization state: ${stateMachine.getCurrentState()}")
        if (LOG.isDebugEnabled) {
            LOG.debug(getInitializationReport())
        }

        // Cancel coroutines
        coroutineScope.cancel()

        // Release RPC manager
        resources.first?.getRPCProtocol()?.dispose()

        // Release protocol
        resources.second?.dispose()

        // Release socket
        nodeSocket.dispose()

        LOG.info("ExtensionHostManager disposed")
    }
}
