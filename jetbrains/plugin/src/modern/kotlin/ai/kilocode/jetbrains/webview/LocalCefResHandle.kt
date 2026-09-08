// SPDX-FileCopyrightText: 2025 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

package ai.kilocode.jetbrains.webview

import org.cef.callback.CefCallback
import org.cef.callback.CefResourceReadCallback
import org.cef.callback.CefResourceSkipCallback
import org.cef.misc.BoolRef
import org.cef.misc.IntRef
import org.cef.misc.LongRef
import org.cef.network.CefRequest

/** CEF 262 exposes the new open/read/skip API in addition to legacy callbacks. */
class LocalCefResHandle(resourceBasePath: String, request: CefRequest?) : BaseLocalCefResHandle(resourceBasePath, request) {
    override fun open(p0: CefRequest?, handleRequest: BoolRef?, callback: CefCallback?): Boolean {
        handleRequest?.set(true)
        return true
    }

    override fun read(dataOut: ByteArray?, bytesToRead: Int, bytesRead: IntRef?, callback: CefResourceReadCallback?): Boolean {
        return readContent(dataOut, bytesToRead, bytesRead)
    }

    override fun skip(bytesToSkip: Long, bytesSkipped: LongRef?, callback: CefResourceSkipCallback?): Boolean {
        if (bytesSkipped == null) return false
        val skipped = skipContent(bytesToSkip)
        bytesSkipped.set(skipped)
        return skipped >= 0
    }
}
