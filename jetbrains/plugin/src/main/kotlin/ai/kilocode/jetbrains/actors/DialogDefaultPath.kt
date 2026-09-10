package ai.kilocode.jetbrains.actors

import ai.kilocode.jetbrains.util.URI
import ai.kilocode.jetbrains.util.URIComponents

/** Preserve drive letters, UNC authorities and decoded characters in native file dialogs. */
internal fun resolveDialogDefaultPath(components: Map<String, String?>?): String? {
    val uriScheme = components?.get("scheme") ?: return null
    val uriPath = components["path"]?.takeIf { it.isNotEmpty() } ?: return null
    if (uriScheme != "file") return null

    return URI
        .from(
            object : URIComponents {
                override val scheme = uriScheme
                override val authority = components["authority"]
                override val path = uriPath
                override val query = components["query"]
                override val fragment = components["fragment"]
            },
        ).fsPath
}
