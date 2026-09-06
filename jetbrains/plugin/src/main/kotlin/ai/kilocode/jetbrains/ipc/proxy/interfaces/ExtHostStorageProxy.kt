// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

package ai.kilocode.jetbrains.ipc.proxy.interfaces

/**
 * Invalidates the cached extension memento after another open project updates
 * the application-level storage value.
 */
interface ExtHostStorageProxy {
    fun acceptValue(shared: Boolean, extensionId: String, value: String)
}
