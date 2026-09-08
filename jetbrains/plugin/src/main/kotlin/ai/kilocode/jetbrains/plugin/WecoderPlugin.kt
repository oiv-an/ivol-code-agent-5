package ai.kilocode.jetbrains.plugin

import ai.kilocode.jetbrains.core.ExtensionProcessManager
import ai.kilocode.jetbrains.core.ExtensionSocketServer
import ai.kilocode.jetbrains.core.ExtensionUnixDomainSocketServer
import ai.kilocode.jetbrains.core.ISocketServer
import ai.kilocode.jetbrains.core.ServiceProxyRegistry
import ai.kilocode.jetbrains.monitoring.ScopeRegistry
import ai.kilocode.jetbrains.monitoring.ThreadMonitor
import ai.kilocode.jetbrains.monitoring.DisposableTracker
import ai.kilocode.jetbrains.util.ExtensionUtils
import ai.kilocode.jetbrains.util.PluginConstants
import ai.kilocode.jetbrains.util.PluginResourceUtil
import ai.kilocode.jetbrains.webview.WebViewManager
import ai.kilocode.jetbrains.workspace.WorkspaceFileChangeManager
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.ControlFlowException
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.project.ProjectManagerListener
import com.intellij.openapi.startup.StartupActivity
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.SystemInfo
import com.intellij.ui.jcef.JBCefApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import java.io.File
import java.io.InputStream
import java.util.Properties
import java.util.concurrent.Executors

/**
 * WeCode IDEA plugin entry class
 * Responsible for plugin initialization and lifecycle management
 */
class WecoderPlugin : StartupActivity.DumbAware {
    companion object {
        private val LOG = Logger.getInstance(WecoderPlugin::class.java)

        // Project manager listener for handling project lifecycle events
        private val projectManagerListener = object : ProjectManagerListener {
            override fun projectOpened(project: Project) {
                LOG.info("Project opened: ${project.name}")
                // Initialize plugin service for newly opened project
                try {
                    val pluginService = getInstance(project)
                    pluginService.initialize(project)
                } catch (e: Exception) {
                    if (e is ControlFlowException || e is CancellationException) throw e
                    LOG.error("Failed to initialize plugin for opened project: ${project.name}", e)
                }
            }

            override fun projectClosed(project: Project) {
                LOG.info("Project closed: ${project.name}")
                // Clean up resources for closed project
                try {
                    // Use getServiceIfCreated to avoid initializing service during disposal
                    val pluginService = project.getServiceIfCreated(WecoderPluginService::class.java)
                    pluginService?.dispose()
                } catch (e: Exception) {
                    if (e is ControlFlowException || e is CancellationException) throw e
                    LOG.error("Failed to dispose plugin for closed project: ${project.name}", e)
                }
            }

            override fun projectClosing(project: Project) {
                LOG.info("Project closing: ${project.name}")
                // Perform any pre-close cleanup
                try {
                    // Notify WebViewManager about impending project close
                    project.getServiceIfCreated(WebViewManager::class.java)?.onProjectSwitch()
                } catch (e: Exception) {
                    if (e is ControlFlowException || e is CancellationException) throw e
                    LOG.error("Failed to handle project closing for: ${project.name}", e)
                }
            }
        }

        init {
            // Register the project manager listener
            try {
                val messageBus = ApplicationManager.getApplication().messageBus
                messageBus.connect().subscribe(ProjectManager.TOPIC, projectManagerListener)
                LOG.info("Project manager listener registered successfully")
            } catch (e: Exception) {
                LOG.error("Failed to register project manager listener", e)
            }
        }

        /**
         * Get plugin service instance
         */
        fun getInstance(project: Project): WecoderPluginService {
            return project.getService(WecoderPluginService::class.java)
                ?: error("WecoderPluginService not found")
        }

        /**
         * Get the basePath of the current project
         */
        @JvmStatic
        fun getProjectBasePath(project: Project): String? {
            return project.basePath
        }
    }

    override fun runActivity(project: Project) {
        val appInfo = ApplicationInfo.getInstance()
        val plugin = PluginManagerCore.getPlugin(PluginId.getId(PluginConstants.PLUGIN_ID))
        val pluginVersion = plugin?.version ?: "unknown"
        val osName = System.getProperty("os.name")
        val osVersion = System.getProperty("os.version")
        val osArch = System.getProperty("os.arch")

        LOG.info(
            "Initializing IVOL Code plugin for project: ${project.name}, " +
                "OS: $osName $osVersion ($osArch), " +
                "IDE: ${appInfo.fullApplicationName} (build ${appInfo.build}), " +
                "Plugin version: $pluginVersion, " +
                "JCEF supported: ${JBCefApp.isSupported()}",
        )

        try {
            // Initialize plugin service
            val pluginService = getInstance(project)
            pluginService.initialize(project)

            // Initialize WebViewManager and register to project Disposer
            val webViewManager = project.getService(WebViewManager::class.java)
            Disposer.register(project, webViewManager)

            // Register project-level resource disposal
            Disposer.register(
                project,
                Disposable {
                    LOG.info("Disposing IVOL Code plugin for project: ${project.name}")
                    pluginService.dispose()
                    // SystemObjectProvider is now project-scoped and will be disposed automatically
                },
            )

            LOG.info("IVOL Code plugin initialized successfully for project: ${project.name}")
        } catch (e: Exception) {
            if (e is ControlFlowException || e is CancellationException) throw e
            LOG.error("Failed to initialize IVOL Code plugin", e)
        }
    }
}

/**
 * Debug mode enum
 */
enum class DebugMode {
    ALL, // All debug modes
    IDEA, // Only IDEA plugin debug
    NONE, // Debug not enabled
    ;

    companion object {
        /**
         * Parse debug mode from string
         * @param value String value
         * @return Corresponding debug mode
         */
        fun fromString(value: String): DebugMode {
            return when (value.lowercase()) {
                "all" -> ALL
                "idea" -> IDEA
                "true" -> ALL // backward compatibility
                "none", "" -> NONE
                else -> NONE
            }
        }
    }
}

/**
 * Plugin service class, provides global access point and core functionality
 */
@Service(Service.Level.PROJECT)
class WecoderPluginService(private val currentProject: Project) : Disposable {
    private val LOG = Logger.getInstance(WecoderPluginService::class.java)

    private val initializationGate = PluginInitializationGate()
    
    // Disposal state
    @Volatile
    private var isDisposing = false
    
    @Volatile
    private var isDisposed = false

    private val boundedIODispatcher = Executors.newFixedThreadPool(
        Runtime.getRuntime().availableProcessors() * 2,
        { r -> Thread(r, "KiloCode-IO").apply { isDaemon = true } }
    ).asCoroutineDispatcher()

    // Coroutine scope
    private val coroutineScope = CoroutineScope(boundedIODispatcher + SupervisorJob())
    private val threadMonitor = ThreadMonitor()

    // Service instances
    private val socketServer = ExtensionSocketServer()
    private val udsSocketServer = ExtensionUnixDomainSocketServer()
    private val processManager = ExtensionProcessManager()

    companion object {
        // Debug mode switch
        @Volatile
        private var DEBUG_TYPE: DebugMode = DebugMode.NONE

        @Volatile
        private var DEBUG_RESOURCE: String? = null

        // Debug mode connection address
        private const val DEBUG_HOST = "127.0.0.1"

        // Debug mode connection port
        private const val DEBUG_PORT = 51234

        // Initialize configuration at class load
        init {
            try {
                // Read debug mode setting from config file
                val properties = Properties()
                val configStream: InputStream? = WecoderPluginService::class.java.getResourceAsStream("/ai/kilocode/jetbrains/plugin/config/plugin.properties")

                if (configStream != null) {
                    properties.load(configStream)
                    configStream.close()

                    // Read debug mode config
                    val debugModeStr = properties.getProperty("debug.mode", "none").lowercase()
                    DEBUG_TYPE = DebugMode.fromString(debugModeStr)
                    DEBUG_RESOURCE = properties.getProperty("debug.resource", null)

                    Logger.getInstance(WecoderPluginService::class.java).info("Read debug mode from config file: $DEBUG_TYPE")
                } else {
                    Logger.getInstance(WecoderPluginService::class.java).warn("Cannot load config file, use default debug mode: $DEBUG_TYPE")
                }
            } catch (e: Exception) {
                Logger.getInstance(WecoderPluginService::class.java).warn("Error reading config file, use default debug mode: $DEBUG_TYPE", e)
            }
        }

        /**
         * Get current debug mode
         * @return Debug mode
         */
        @JvmStatic
        fun getDebugMode(): DebugMode {
            return DEBUG_TYPE
        }

        /**
         * Get debug resource path
         * @return Debug resource path
         */
        @JvmStatic
        fun getDebugResource(): String? {
            return DEBUG_RESOURCE
        }
    }

    /**
     * Initialize plugin service
     */
    fun initialize(project: Project) {
        if (isDisposing || isDisposed || project.isDisposed) {
            LOG.warn("Cannot initialize: service is disposing or disposed")
            return
        }
        // This is a project service. Never transfer its sockets/scope to another project.
        if (project !== currentProject) {
            LOG.warn("Cannot initialize a project service for a different project")
            return
        }
        // StartupActivity, projectOpened and the tool window can all arrive before
        // asynchronous initialization finishes. Claim the attempt before any work.
        val attempt = initializationGate.tryBegin() ?: run {
            LOG.info("WecoderPluginService already starting or initialized for project: ${project.name}")
            return
        }
        LOG.info("Initializing WecoderPluginService for project: ${project.name}, debug mode: $DEBUG_TYPE")
        try {
            ensureInitializationActive(attempt)
            val systemObjectProvider = project.getService(SystemObjectProvider::class.java)
            systemObjectProvider.initialize(project)
            socketServer.project = project
            udsSocketServer.project = project
            systemObjectProvider.register("pluginService", this)
            threadMonitor.startMonitoring()
            ScopeRegistry.register("WecoderPluginService", coroutineScope)

            val job = coroutineScope.launch {
                var succeeded = false
                try {
                    coroutineContext.ensureActive()
                    ensureInitializationActive(attempt)
                    initPlatformFiles()
                    coroutineContext.ensureActive()
                    ensureInitializationActive(attempt)
                    project.getService(ServiceProxyRegistry::class.java).initialize()
                    ensureInitializationActive(attempt)

                    if (DEBUG_TYPE == DebugMode.ALL) {
                        socketServer.connectToDebugHost(DEBUG_HOST, DEBUG_PORT)
                    } else {
                        val server: ISocketServer = if (SystemInfo.isWindows) socketServer else udsSocketServer
                        val portOrPath = server.start(project.basePath ?: "")
                        check(ExtensionUtils.isValidPortOrPath(portOrPath)) {
                            "Failed to start socket server for project: ${project.name}"
                        }
                        coroutineContext.ensureActive()
                        ensureInitializationActive(attempt)
                        check(processManager.start(portOrPath)) {
                            "Failed to start extension process for project: ${project.name}"
                        }
                    }
                    coroutineContext.ensureActive()
                    ensureInitializationActive(attempt)
                    succeeded = initializationGate.complete(attempt)
                    if (!succeeded) throw CancellationException("Plugin initialization was closed")
                    LOG.info("WecoderPluginService initialization completed for project: ${project.name}")
                } catch (e: Exception) {
                    if (e is CancellationException || e is ControlFlowException) throw e
                    LOG.error("Error during WecoderPluginService initialization for project: ${project.name}", e)
                } finally {
                    if (!succeeded) {
                        // Keep the attempt claimed until resources from it are stopped.
                        finishFailedInitialization(attempt)
                    }
                }
            }
            // A cancelled scope may prevent the coroutine body/finally from starting.
            job.invokeOnCompletion { initializationGate.fail(attempt) }
        } catch (e: Exception) {
            finishFailedInitialization(attempt)
            if (e is CancellationException || e is ControlFlowException) throw e
            LOG.error("Error preparing WecoderPluginService for project: ${project.name}", e)
        }
    }

    private fun finishFailedInitialization(attempt: PluginInitializationGate.Attempt) {
        var cleaned = false
        try {
            cleaned = cleanup()
        } finally {
            // A failed cleanup must release waiters, but cannot authorize another
            // startup over resources whose state is unknown.
            initializationGate.fail(attempt, retryable = cleaned)
        }
    }

    private fun ensureInitializationActive(attempt: PluginInitializationGate.Attempt) {
        if (isDisposing || isDisposed || currentProject.isDisposed || !initializationGate.isCurrent(attempt)) {
            throw CancellationException("Plugin project was closed during initialization")
        }
    }

    private fun initPlatformFiles() {
        // Initialize platform related files
        val platformSuffix = when {
            SystemInfo.isWindows -> "windows-x64"
            SystemInfo.isMac -> when (System.getProperty("os.arch")) {
                "x86_64" -> "darwin-x64"
                "aarch64" -> "darwin-arm64"
                else -> ""
            }
            SystemInfo.isLinux -> "linux-x64"
            else -> ""
        }
        if (platformSuffix.isNotEmpty()) {
            val pluginDir = PluginResourceUtil.getResourcePath(PluginConstants.PLUGIN_ID, "")
                ?: throw IllegalStateException("Cannot get plugin directory")

            PlatformFileInitializer.initialize(File(pluginDir).toPath(), platformSuffix)
        }
    }

    /**
     * Wait for initialization to complete
     * @return Whether initialization was successful
     */
    fun waitForInitialization(): Boolean {
        return initializationGate.awaitInitialization()
    }

    /**
     * Clean up resources
     */
    @Synchronized
    private fun cleanup(): Boolean {
        var cleaned = true
        LOG.info("Starting cleanup for project: ${currentProject?.name}")

        // First, stop the extension process to prevent new connections
        try {
            if (DEBUG_TYPE == DebugMode.NONE) {
                LOG.info("Stopping extension process")
                processManager.stop()
            }
        } catch (e: Exception) {
            if (e is ControlFlowException) throw e
            cleaned = false
            LOG.warn("Error stopping process manager", e)
        }

        // Wait a bit for the process to fully stop
        try {
            Thread.sleep(500)
        } catch (e: InterruptedException) {
            cleaned = false
            Thread.currentThread().interrupt()
        }

        // Then stop socket servers - this will close all client connections
        try {
            LOG.info("Stopping socket servers")
            socketServer.stop()
            udsSocketServer.stop()
        } catch (e: Exception) {
            if (e is ControlFlowException) throw e
            cleaned = false
            LOG.warn("Error stopping socket server", e)
        }

        // Wait for socket connections to be fully closed
        try {
            Thread.sleep(1000)
        } catch (e: InterruptedException) {
            cleaned = false
            Thread.currentThread().interrupt()
        }

        LOG.info("Cleanup completed for project: ${currentProject?.name}")
        return cleaned
    }

    /**
     * Get whether initialized
     */
    fun isInitialized(): Boolean {
        return initializationGate.isInitialized
    }

    /**
     * Get Socket server
     */
    fun getSocketServer(): ExtensionSocketServer {
        return socketServer
    }

    /**
     * Get process manager
     */
    fun getProcessManager(): ExtensionProcessManager {
        return processManager
    }

    /**
     * Get current project
     */
    fun getCurrentProject(): Project? {
        return currentProject
    }

    /**
     * Close service
     */
    override fun dispose() {
        if (!initializationGate.close()) return
        isDisposing = true
        LOG.info("Disposing WecoderPluginService")

        threadMonitor.dispose()
        ScopeRegistry.unregister("WecoderPluginService")

        // Cancel even when startup has not finished. Never create project services
        // during disposal or permanently dispose them during a retryable failure.
        coroutineScope.cancel()
        try {
            currentProject.getServiceIfCreated(WebViewManager::class.java)?.dispose()
            currentProject.getServiceIfCreated(WorkspaceFileChangeManager::class.java)?.dispose()
        } finally {
            try {
                cleanup()
            } finally {
                boundedIODispatcher.close()
                isDisposed = true
                isDisposing = false
            }
        }
        LOG.info("WecoderPluginService disposed")
    }
}
