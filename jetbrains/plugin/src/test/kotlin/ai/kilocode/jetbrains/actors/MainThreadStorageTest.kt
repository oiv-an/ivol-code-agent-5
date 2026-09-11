// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

package ai.kilocode.jetbrains.actors

import ai.kilocode.jetbrains.service.ExtensionStorageService
import ai.kilocode.jetbrains.service.ExtensionStorageValueChange
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class MainThreadStorageTest {
    @Test
    fun `stale global snapshots merge changed keys and broadcast the canonical value`() {
        val storage = ExtensionStorageService()
        storage.setValue(EXTENSION_ID, """{"alpha":0,"beta":0}""")
        val acceptedA = mutableListOf<JsonObject>()
        val acceptedB = mutableListOf<JsonObject>()
        val bridgeA = bridge(storage, "project-a", acceptedA)
        val bridgeB = bridge(storage, "project-b", acceptedB)

        val staleA = parse(bridgeA.initializeExtensionStorage(true, EXTENSION_ID) as String)
        val staleB = parse(bridgeB.initializeExtensionStorage(true, EXTENSION_ID) as String)

        bridgeA.setValue(
            true,
            EXTENSION_ID,
            mapOf("alpha" to 1, "beta" to staleA.get("beta").asInt),
            listOf(change("alpha", true, 0)),
        )
        bridgeB.setValue(
            true,
            EXTENSION_ID,
            mapOf("alpha" to staleB.get("alpha").asInt, "beta" to 2),
            listOf(change("beta", true, 0)),
        )

        val canonical = parse(storage.getValue(EXTENSION_ID)!!)
        assertEquals(1, canonical.get("alpha").asInt)
        assertEquals(2, canonical.get("beta").asInt)
        assertEquals(canonical, acceptedA.last())
        assertEquals(canonical, acceptedB.last())
    }

    @Test
    fun `stale task history additions and unrelated updates do not lose or resurrect tasks`() {
        val storage = ExtensionStorageService()
        storage.setValue(EXTENSION_ID, "{}")
        val bridgeA = bridge(storage, "project-a")
        val bridgeB = bridge(storage, "project-b")
        bridgeA.initializeExtensionStorage(true, EXTENSION_ID)
        bridgeB.initializeExtensionStorage(true, EXTENSION_ID)

        val taskA = task("a", "A")
        val taskB = task("b", "B")
        bridgeA.setValue(
            true,
            EXTENSION_ID,
            mapOf("taskHistory" to listOf(taskA)),
            listOf(change("taskHistory", false)),
        )
        bridgeB.setValue(
            true,
            EXTENSION_ID,
            mapOf("taskHistory" to listOf(taskB)),
            listOf(change("taskHistory", false)),
        )

        assertEquals(listOf("a", "b"), taskIds(storage))

        val previous = listOf(taskA, taskB)
        bridgeA.setValue(
            true,
            EXTENSION_ID,
            mapOf("taskHistory" to listOf(taskB)),
            listOf(change("taskHistory", true, previous)),
        )
        bridgeB.setValue(
            true,
            EXTENSION_ID,
            mapOf("taskHistory" to listOf(taskA, task("b", "B updated"))),
            listOf(change("taskHistory", true, previous)),
        )

        val history = parse(storage.getValue(EXTENSION_ID)!!).getAsJsonArray("taskHistory")
        assertEquals(listOf("b"), history.map { it.asJsonObject.get("id").asString })
        assertEquals("B updated", history.single().asJsonObject.get("task").asString)
    }

    @Test
    fun `a client that never saw a task must not delete it while adding its own`() {
        val storage = ExtensionStorageService()
        storage.setValue(EXTENSION_ID, "{}")
        val bridgeA = bridge(storage, "project-a")
        val bridgeB = bridge(storage, "project-b")
        bridgeA.initializeExtensionStorage(true, EXTENSION_ID)
        bridgeB.initializeExtensionStorage(true, EXTENSION_ID)

        // Project A records its task while project B still has an empty snapshot.
        val taskA = task("a", "A")
        bridgeA.setValue(
            true,
            EXTENSION_ID,
            mapOf("taskHistory" to listOf(taskA)),
            listOf(change("taskHistory", false)),
        )

        // Project B saves its own task from that stale, empty snapshot. Because B never
        // observed task "a", its delta must be treated as an addition, not a deletion.
        val taskB = task("b", "B")
        bridgeB.setValue(
            true,
            EXTENSION_ID,
            mapOf("taskHistory" to listOf(taskB)),
            listOf(change("taskHistory", false)),
        )

        assertEquals(listOf("a", "b"), taskIds(storage))
    }

    @Test
    fun `long running history keeps every task across many interleaved stale writes`() {
        val storage = ExtensionStorageService()
        storage.setValue(EXTENSION_ID, "{}")
        val bridges = (1..4).map { index ->
            bridge(storage, "project-$index").also { it.initializeExtensionStorage(true, EXTENSION_ID) }
        }

        val expected = mutableListOf<String>()
        repeat(40) { round ->
            val bridge = bridges[round % bridges.size]
            val id = "task-$round"
            expected.add(id)
            // Every client writes only the task it just created, based on whatever
            // snapshot it holds; nothing may be dropped from the canonical history.
            bridge.setValue(
                true,
                EXTENSION_ID,
                mapOf("taskHistory" to listOf(task(id, "Task $round"))),
                listOf(change("taskHistory", false)),
            )
        }

        assertEquals(expected, taskIds(storage))
    }

    @Test
    fun `global storage stays shared while workspace storage is isolated and seeded from legacy data`() {
        val storage = ExtensionStorageService()
        storage.setValue(EXTENSION_ID, """{"legacy":true}""")
        val workspaceAEvents = mutableListOf<JsonObject>()
        val workspaceBEvents = mutableListOf<JsonObject>()
        val workspaceA = bridge(storage, "project-a", workspaceAEvents)
        val workspaceB = bridge(storage, "project-b", workspaceBEvents)

        assertTrue(parse(workspaceA.initializeExtensionStorage(false, EXTENSION_ID) as String).get("legacy").asBoolean)
        assertTrue(parse(workspaceB.initializeExtensionStorage(false, EXTENSION_ID) as String).get("legacy").asBoolean)

        workspaceA.setValue(
            false,
            EXTENSION_ID,
            mapOf("legacy" to true, "workspaceOnly" to "a"),
            listOf(change("workspaceOnly", false)),
        )

        val workspaceBValue = parse(workspaceB.initializeExtensionStorage(false, EXTENSION_ID) as String)
        assertFalse(workspaceBValue.has("workspaceOnly"))
        assertFalse(parse(storage.getValue(EXTENSION_ID)!!).has("workspaceOnly"))
        assertTrue(workspaceAEvents.isNotEmpty())
        assertTrue(workspaceBEvents.isEmpty())
    }

    @Test
    fun `disposed bridge stops receiving broadcasts and malformed stored data is preserved`() {
        val storage = ExtensionStorageService()
        storage.setValue(EXTENSION_ID, "{}")
        val acceptedA = mutableListOf<JsonObject>()
        val bridgeA = bridge(storage, "project-a", acceptedA)
        val bridgeB = bridge(storage, "project-b")
        bridgeA.initializeExtensionStorage(true, EXTENSION_ID)
        bridgeB.initializeExtensionStorage(true, EXTENSION_ID)
        bridgeA.dispose()

        bridgeB.setValue(
            true,
            EXTENSION_ID,
            mapOf("afterDispose" to true),
            listOf(change("afterDispose", false)),
        )
        assertTrue(acceptedA.isEmpty())

        storage.setValue(EXTENSION_ID, "not-json")
        assertThrows(IllegalArgumentException::class.java) {
            storage.mergeValue(
                EXTENSION_ID,
                mapOf("safe" to true),
                listOf(ExtensionStorageValueChange("safe", false)),
            )
        }
        assertEquals("not-json", storage.getValue(EXTENSION_ID))
    }

    private fun bridge(
        storage: ExtensionStorageService,
        workspaceId: String,
        accepted: MutableList<JsonObject> = mutableListOf(),
    ): MainThreadStorage {
        return MainThreadStorage(storage, workspaceId) { _, _, value -> accepted.add(parse(value)) }
    }

    private fun change(
        key: String,
        previousValueExists: Boolean,
        previousValue: Any? = null,
    ): Map<String, Any?> {
        return buildMap {
            put("key", key)
            put("previousValueExists", previousValueExists)
            if (previousValueExists) {
                put("previousValue", previousValue)
            }
        }
    }

    private fun task(id: String, text: String): Map<String, Any> {
        return mapOf("id" to id, "task" to text, "ts" to 1)
    }

    private fun taskIds(storage: ExtensionStorageService): List<String> {
        return parse(storage.getValue(EXTENSION_ID)!!)
            .getAsJsonArray("taskHistory")
            .map { it.asJsonObject.get("id").asString }
    }

    private fun parse(value: String): JsonObject = JsonParser.parseString(value).asJsonObject

    companion object {
        private const val EXTENSION_ID = "Kilo Code.kilo-code"
    }
}
