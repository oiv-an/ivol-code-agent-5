// Copyright 2009-2025 Weibo, Inc.
// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

package ai.kilocode.jetbrains.core

import ai.kilocode.jetbrains.ipc.proxy.IRPCProtocol
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Lifecycle of the extension host process behind this project.
 *
 * The UI has to tell apart a host that is not ready yet from one that has gone
 * away, because only the second case is worth interrupting the user for.
 */
enum class ExtensionHostState {
    /** No host has ever been connected, or one is being started right now. */
    STARTING,

    /** A host is connected and its RPC protocol can be used. */
    READY,

    /** A host was connected and is now gone. */
    STOPPED,
}

/**
 * Plugin global context
 * Used for managing globally accessible resources and objects
 */
@Service(Service.Level.PROJECT)
class PluginContext {
    private val logger = Logger.getInstance(PluginContext::class.java)

    // RPC protocol instance
    @Volatile
    private var rpcProtocol: IRPCProtocol? = null
    
    // Extension host manager instance
    @Volatile
    private var extensionHostManager: ExtensionHostManager? = null

    @Volatile
    private var hostState: ExtensionHostState = ExtensionHostState.STARTING

    private val hostStoppedListeners = CopyOnWriteArrayList<() -> Unit>()

    /**
     * Current lifecycle state of the extension host.
     */
    fun getExtensionHostState(): ExtensionHostState = hostState

    /**
     * Set RPC protocol instance
     * @param protocol RPC protocol instance
     */
    fun setRPCProtocol(protocol: IRPCProtocol) {
        logger.info("Setting RPC protocol instance")
        rpcProtocol = protocol
        hostState = ExtensionHostState.READY
    }

    /**
     * Get RPC protocol instance
     * @return RPC protocol instance, or null if not set
     */
    fun getRPCProtocol(): IRPCProtocol? {
        return rpcProtocol
    }
    
    /**
     * Set extension host manager instance
     * @param manager Extension host manager instance
     */
    fun setExtensionHostManager(manager: ExtensionHostManager) {
        logger.info("Setting extension host manager instance")
        extensionHostManager = manager
    }
    
    /**
     * Get extension host manager instance
     * @return Extension host manager instance, or null if not set
     */
    fun getExtensionHostManager(): ExtensionHostManager? {
        return extensionHostManager
    }

    /**
     * Register a listener that runs once the extension host has stopped.
     *
     * Listeners let views release themselves instead of outliving the host and
     * failing on every later command.
     */
    fun addHostStoppedListener(listener: () -> Unit) {
        hostStoppedListeners.add(listener)
    }

    fun removeHostStoppedListener(listener: () -> Unit) {
        hostStoppedListeners.remove(listener)
    }

    /**
     * Clear all resources
     */
    fun clear() {
        logger.info("Clearing resources in PluginContext")
        val hadHost = rpcProtocol != null || extensionHostManager != null
        rpcProtocol = null
        extensionHostManager = null
        if (!hadHost) return

        hostState = ExtensionHostState.STOPPED
        for (listener in hostStoppedListeners) {
            try {
                listener()
            } catch (e: Exception) {
                logger.warn("An extension host listener failed while the host was stopping", e)
            }
        }
    }

    companion object {
        // Singleton instance
//        @Volatile
//        private var instance: PluginContext? = null

        /**
         * Get PluginContext singleton instance
         * @return PluginContext instance
         */
        fun getInstance(project: Project): PluginContext {
            return project.getService(PluginContext::class.java)
        }
    }
}
