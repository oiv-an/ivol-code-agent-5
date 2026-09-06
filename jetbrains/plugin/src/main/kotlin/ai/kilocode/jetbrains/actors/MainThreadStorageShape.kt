// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

package ai.kilocode.jetbrains.actors

import ai.kilocode.jetbrains.service.ExtensionStorageService
import ai.kilocode.jetbrains.service.ExtensionStorageValueChange
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger

/**
 * Main thread storage service interface.
 */
interface MainThreadStorageShape : Disposable {
    /**
     * Initializes extension storage.
     * @param shared Whether shared
     * @param extensionId Extension ID
     * @return Initialization result
     */
    fun initializeExtensionStorage(shared: Boolean, extensionId: String): Any?

    /**
     * Sets value.
     * @param shared Whether shared
     * @param extensionId Extension ID
     * @param value Value object
     * @return Set result
     */
    fun setValue(
        shared: Boolean,
        extensionId: String,
        value: Any,
        changes: List<Map<String, Any?>>?,
    )

    /**
     * Registers extension storage keys for synchronization.
     * @param extension Extension ID and version
     * @param keys List of keys
     */
    fun registerExtensionStorageKeysToSync(extension: Any, keys: List<String>)
}

/**
 * Implementation of the main thread storage service.
 */
class MainThreadStorage(
    private val storage: ExtensionStorageService = service(),
    private val workspaceId: String = "default",
    private val acceptValue: (shared: Boolean, extensionId: String, value: String) -> Unit = { _, _, _ -> },
) : MainThreadStorageShape {
    private val logger = Logger.getInstance(MainThreadStorage::class.java)
    private val gson = Gson()
    private val bridgeLock = Any()
    private val subscriptions = mutableMapOf<StorageScope, StorageSubscription>()
    private val clientSnapshots = mutableMapOf<StorageScope, String?>()
    private var disposed = false

    override fun initializeExtensionStorage(shared: Boolean, extensionId: String): Any? {
        logger.info("Initializing extension storage: shared=$shared, extensionId=$extensionId")
        val scope = StorageScope(shared, extensionId)
        synchronized(bridgeLock) {
            subscriptions[scope]?.let { return storage.getValue(it.storageKey) }

            val storageKey = storageKey(scope)
            val callback: (String) -> Unit = { value ->
                val shouldBroadcast = synchronized(bridgeLock) { !disposed }
                if (shouldBroadcast) {
                    runCatching { acceptValue(shared, extensionId, value) }
                        .onFailure { error -> logger.warn("Failed to broadcast extension storage update", error) }
                }
            }
            val subscription = storage.subscribe(
                key = storageKey,
                legacyFallbackKey = if (shared) null else extensionId,
                listener = callback,
            )
            subscriptions[scope] = StorageSubscription(storageKey, subscription.id, callback)
            clientSnapshots[scope] = subscription.value
            return subscription.value
        }
    }

    override fun setValue(
        shared: Boolean,
        extensionId: String,
        value: Any,
        changes: List<Map<String, Any?>>?,
    ) {
        val scope = StorageScope(shared, extensionId)
        val (storageKey, normalizedChanges) = synchronized(bridgeLock) {
            val activeSubscription = subscriptions[scope]
            val resolvedStorageKey = activeSubscription?.storageKey ?: storageKey(scope)
            val resolvedChanges = normalizeChanges(changes, clientSnapshots[scope], value)
            clientSnapshots[scope] = serializeObject(value)
            resolvedStorageKey to resolvedChanges
        }

        storage.mergeValue(storageKey, value, normalizedChanges)
    }

    override fun registerExtensionStorageKeysToSync(extension: Any, keys: List<String>) {
        val extensionId = if (extension is Map<*, *>) {
            "${extension["id"]}_${extension["version"]}"
        } else {
            "$extension"
        }
        logger.info("Registering extension storage keys for sync: extension=$extensionId, keys=$keys")
    }

    override fun dispose() {
        synchronized(bridgeLock) {
            disposed = true
            for (subscription in subscriptions.values) {
                storage.unsubscribe(subscription.storageKey, subscription.id)
            }
            subscriptions.clear()
            clientSnapshots.clear()
        }
        logger.info("Dispose MainThreadStorage")
    }

    private fun normalizeChanges(
        changes: List<Map<String, Any?>>?,
        previousSnapshot: String?,
        incomingValue: Any,
    ): List<ExtensionStorageValueChange> {
        if (changes != null) {
            val parsedChanges = changes.mapNotNull(::parseChange)
            if (parsedChanges.size == changes.size) {
                return parsedChanges
            }
            logger.warn("Received malformed extension storage change metadata; deriving a safe fallback delta")
        }

        // Compatibility with an older bundled host: derive the top-level delta
        // from the last snapshot this client sent or initialized with.
        val previous = parseObject(previousSnapshot)
        val incoming = parseObject(serializeObject(incomingValue))
        return (previous.keySet() + incoming.keySet()).mapNotNull { key ->
            val previousValue = previous.get(key)
            val incomingValueForKey = incoming.get(key)
            if (previousValue == incomingValueForKey) {
                null
            } else {
                ExtensionStorageValueChange(
                    key = key,
                    previousValueExists = previous.has(key),
                    previousValue = previousValue?.deepCopy(),
                )
            }
        }
    }

    private fun parseChange(change: Map<String, Any?>): ExtensionStorageValueChange? {
        val key = change["key"] as? String ?: return null
        val previousValueExists = change["previousValueExists"] as? Boolean ?: false
        val previousValue = if (previousValueExists && change.containsKey("previousValue")) {
            gson.toJsonTree(change["previousValue"])
        } else {
            null
        }
        return ExtensionStorageValueChange(key, previousValueExists, previousValue)
    }

    private fun serializeObject(value: Any): String {
        return if (value is String) value else gson.toJson(value)
    }

    private fun parseObject(value: String?): JsonObject {
        if (value.isNullOrBlank()) {
            return JsonObject()
        }
        val parsed = JsonParser.parseString(value)
        require(parsed.isJsonObject) { "Extension memento snapshot must be a JSON object" }
        return parsed.asJsonObject
    }

    private fun storageKey(scope: StorageScope): String {
        return if (scope.shared) {
            scope.extensionId
        } else {
            "${scope.extensionId}$WORKSPACE_KEY_SEPARATOR$workspaceId"
        }
    }

    private data class StorageScope(
        val shared: Boolean,
        val extensionId: String,
    )

    private data class StorageSubscription(
        val storageKey: String,
        val id: Long,
        @Suppress("unused") val callback: (String) -> Unit,
    )

    companion object {
        private const val WORKSPACE_KEY_SEPARATOR = "::workspace::"
    }
}
