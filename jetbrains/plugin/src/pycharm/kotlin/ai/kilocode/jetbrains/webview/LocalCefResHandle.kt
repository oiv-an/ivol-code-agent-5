// SPDX-FileCopyrightText: 2025 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

package ai.kilocode.jetbrains.webview

import org.cef.network.CefRequest

/** CEF 251 supports processRequest/readResponse and has no newer callback types. */
class LocalCefResHandle(resourceBasePath: String, request: CefRequest?) : BaseLocalCefResHandle(resourceBasePath, request)
