// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

package ai.kilocode.jetbrains.service

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.util.xmlb.XmlSerializerUtil
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicLong

data class ExtensionStorageValueChange(
    val key: String,
    val previousValueExists: Boolean,
    val previousValue: JsonElement? = null,
)

data class ExtensionStorageSubscription(
    val id: Long,
    val value: String?,
)

@Service
@State(
    name = "ai.kilocode.jetbrains.service.ExtensionStorageService",
    storages = [Storage("kilocode-extension-storage.xml")],
)
class ExtensionStorageService : PersistentStateComponent<ExtensionStorageService> {
    private val gson = Gson()
    private val updateLock = Any()
    private val storageLock = Any()
    private val nextListenerId = AtomicLong()
    private val listeners = mutableMapOf<String, MutableMap<Long, WeakReference<(String) -> Unit>>>()
    var storageMap: MutableMap<String, String> = mutableMapOf()

    override fun getState(): ExtensionStorageService {
        return synchronized(storageLock) {
            ExtensionStorageService().also { snapshot ->
                snapshot.storageMap = storageMap.toMutableMap()
            }
        }
    }

    override fun loadState(state: ExtensionStorageService) {
        synchronized(storageLock) {
            XmlSerializerUtil.copyBean(state, this)
            storageMap = storageMap.toMutableMap()
        }
    }

    fun setValue(key: String, value: Any) {
        val serializedValue = when (value) {
            is String -> value
            else -> gson.toJson(value)
        }
        synchronized(updateLock) {
            val callbacks = synchronized(storageLock) {
                storageMap[key] = serializedValue
                liveListenersLocked(key)
            }
            notifyListeners(callbacks, serializedValue)
        }
    }

    fun getValue(key: String): String? {
        return synchronized(storageLock) { storageMap[key] }
    }

    fun removeValue(key: String) {
        synchronized(updateLock) {
            synchronized(storageLock) {
                storageMap.remove(key)
            }
        }
    }

    fun clear() {
        synchronized(updateLock) {
            synchronized(storageLock) {
                storageMap.clear()
            }
        }
    }

    /**
     * Registers one extension host for canonical storage updates and returns the
     * current value in the same critical section, avoiding an initialize/subscribe gap.
     */
    fun subscribe(
        key: String,
        legacyFallbackKey: String? = null,
        listener: (String) -> Unit,
    ): ExtensionStorageSubscription {
        synchronized(storageLock) {
            if (!storageMap.containsKey(key) && legacyFallbackKey != null) {
                storageMap[legacyFallbackKey]?.let { storageMap[key] = it }
            }

            val id = nextListenerId.incrementAndGet()
            listeners.getOrPut(key) { mutableMapOf() }[id] = WeakReference(listener)
            return ExtensionStorageSubscription(id, storageMap[key])
        }
    }

    fun unsubscribe(key: String, subscriptionId: Long) {
        synchronized(storageLock) {
            listeners[key]?.let { scopedListeners ->
                scopedListeners.remove(subscriptionId)
                if (scopedListeners.isEmpty()) {
                    listeners.remove(key)
                }
            }
        }
    }

    /**
     * Applies only the keys changed by one extension host to the latest shared
     * snapshot. `taskHistory` is merged by task id, so stale project snapshots
     * cannot erase tasks created or updated by another open project.
     */
    fun mergeValue(
        key: String,
        incomingValue: Any,
        changes: List<ExtensionStorageValueChange>,
    ): String {
        val incoming = asJsonObject(incomingValue)
        return synchronized(updateLock) {
            val update = synchronized(storageLock) {
                val current = parseStoredObject(storageMap[key])
                for (change in changes) {
                    applyChange(current, incoming, change)
                }

                val serialized = gson.toJson(current)
                storageMap[key] = serialized
                serialized to liveListenersLocked(key)
            }

            notifyListeners(update.second, update.first)
            update.first
        }
    }

    private fun applyChange(
        current: JsonObject,
        incoming: JsonObject,
        change: ExtensionStorageValueChange,
    ) {
        val incomingHasValue = incoming.has(change.key)
        if (!incomingHasValue) {
            current.remove(change.key)
            return
        }

        val incomingValue = incoming.get(change.key)
        if (
            change.key == TASK_HISTORY_KEY &&
            incomingValue.isJsonArray &&
            current.get(change.key)?.isJsonArray == true &&
            (
                !change.previousValueExists ||
                    change.previousValue?.isJsonArray == true
                )
        ) {
            val previous = if (change.previousValueExists) {
                change.previousValue!!.asJsonArray
            } else {
                JsonArray()
            }
            current.add(
                change.key,
                mergeTaskHistory(
                    current.getAsJsonArray(change.key),
                    previous,
                    incomingValue.asJsonArray,
                ),
            )
            return
        }

        current.add(change.key, incomingValue.deepCopy())
    }

    private fun mergeTaskHistory(
        current: JsonArray,
        previous: JsonArray,
        incoming: JsonArray,
    ): JsonArray {
        val previousById = taskItemsById(previous) ?: return incoming.deepCopy()
        val incomingById = taskItemsById(incoming) ?: return incoming.deepCopy()
        val removedIds = previousById.keys - incomingById.keys
        val changedItems = incomingById.filter { (id, item) -> previousById[id] != item }

        val merged = JsonArray()
        val emittedIds = mutableSetOf<String>()
        for (item in current) {
            val id = taskId(item)
            if (id == null) {
                merged.add(item.deepCopy())
                continue
            }
            if (id in removedIds) {
                continue
            }
            if (!emittedIds.add(id)) {
                continue
            }

            val replacement = changedItems[id]
            merged.add((replacement ?: item).deepCopy())
        }

        for ((id, item) in changedItems) {
            if (id !in emittedIds) {
                merged.add(item.deepCopy())
            }
        }
        return merged
    }

    private fun taskItemsById(items: JsonArray): LinkedHashMap<String, JsonElement>? {
        val byId = linkedMapOf<String, JsonElement>()
        for (item in items) {
            val id = taskId(item) ?: return null
            byId[id] = item
        }
        return byId
    }

    private fun taskId(item: JsonElement): String? {
        if (!item.isJsonObject) {
            return null
        }
        val id = item.asJsonObject.get("id") ?: return null
        return if (id.isJsonPrimitive && id.asJsonPrimitive.isString) id.asString else null
    }

    private fun asJsonObject(value: Any): JsonObject {
        val element = when (value) {
            is String -> JsonParser.parseString(value)
            else -> gson.toJsonTree(value)
        }
        require(element.isJsonObject) { "Extension memento must be a JSON object" }
        return element.asJsonObject
    }

    private fun parseStoredObject(value: String?): JsonObject {
        if (value.isNullOrBlank()) {
            return JsonObject()
        }
        val parsed = JsonParser.parseString(value)
        require(parsed.isJsonObject) { "Stored extension memento must be a JSON object" }
        return parsed.asJsonObject
    }

    private fun liveListenersLocked(key: String): List<(String) -> Unit> {
        val scopedListeners = listeners[key] ?: return emptyList()
        val live = mutableListOf<(String) -> Unit>()
        val iterator = scopedListeners.iterator()
        while (iterator.hasNext()) {
            val callback = iterator.next().value.get()
            if (callback == null) {
                iterator.remove()
            } else {
                live.add(callback)
            }
        }
        if (scopedListeners.isEmpty()) {
            listeners.remove(key)
        }
        return live
    }

    private fun notifyListeners(listeners: List<(String) -> Unit>, value: String) {
        for (listener in listeners) {
            runCatching { listener(value) }
        }
    }

    companion object {
        private const val TASK_HISTORY_KEY = "taskHistory"
    }
}
