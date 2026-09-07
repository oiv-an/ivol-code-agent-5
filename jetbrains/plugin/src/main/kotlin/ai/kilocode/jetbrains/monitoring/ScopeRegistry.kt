package ai.kilocode.jetbrains.monitoring

import com.intellij.openapi.diagnostic.Logger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.isActive
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap

object ScopeRegistry {
    private val logger = Logger.getInstance(ScopeRegistry::class.java)
    // Monitoring must never become the owner of a project and its editor graph.
    // Owners still have to cancel their scopes when disposed.
    private val scopes = ConcurrentHashMap<String, WeakReference<CoroutineScope>>()
    
    fun register(name: String, scope: CoroutineScope) {
        scopes[name] = WeakReference(scope)
        logger.info("Registered coroutine scope: $name")
    }
    
    fun unregister(name: String) {
        scopes.remove(name)
        logger.info("Unregistered coroutine scope: $name")
    }

    fun unregister(name: String, scope: CoroutineScope) {
        scopes.computeIfPresent(name) { _, reference ->
            if (reference.get() === scope) null else reference
        }
    }
    
    fun getActiveScopes(): Map<String, Boolean> {
        return buildMap {
            scopes.forEach { (name, reference) ->
                val scope = reference.get()
                if (scope == null) {
                    scopes.remove(name, reference)
                } else {
                    put(name, scope.isActive)
                }
            }
        }
    }
    
    fun logScopeStatus() {
        val activeScopes = getActiveScopes()
        logger.info("Coroutine scope status (${activeScopes.size} total):")
        activeScopes.forEach { (name, isActive) ->
            logger.info("  $name: ${if (isActive) "ACTIVE" else "INACTIVE"}")
        }
    }
}
