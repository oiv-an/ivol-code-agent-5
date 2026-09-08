package ai.kilocode.jetbrains.plugin

import java.util.concurrent.CompletableFuture

/**
 * One project service can be requested by several startup entry points. Claim
 * initialization before doing any setup, not only when the background work ends.
 * Identity-based attempts also prevent a late callback from completing a retry.
 */
internal class PluginInitializationGate {
    internal class Attempt internal constructor()

    private enum class State { IDLE, INITIALIZING, INITIALIZED, FAILED, CLOSED }

    private val lock = Any()
    private var state = State.IDLE
    private var currentAttempt: Attempt? = null
    // Waiters registered before the first initialize call must see its outcome.
    private var initializationComplete = CompletableFuture<Boolean>()

    val isInitialized: Boolean
        get() = synchronized(lock) { state == State.INITIALIZED }

    fun tryBegin(): Attempt? = synchronized(lock) {
        if (state != State.IDLE) return@synchronized null
        if (initializationComplete.isDone) initializationComplete = CompletableFuture()
        Attempt().also {
            currentAttempt = it
            state = State.INITIALIZING
        }
    }

    fun isCurrent(attempt: Attempt): Boolean = synchronized(lock) {
        state == State.INITIALIZING && currentAttempt === attempt
    }

    fun complete(attempt: Attempt): Boolean = synchronized(lock) {
        if (state != State.INITIALIZING || currentAttempt !== attempt) return@synchronized false
        state = State.INITIALIZED
        currentAttempt = null
        initializationComplete.complete(true)
        true
    }

    /**
     * Release a failed attempt only after cleanup was attempted. A retry is safe
     * only when cleanup finished; otherwise fail closed while still allowing the
     * service owner to claim disposal. Either outcome releases existing waiters.
     * Until this call, other startup entry points cannot begin a competing retry.
     * A failure from an older attempt or a disposed service changes nothing.
     */
    fun fail(attempt: Attempt, retryable: Boolean = true): Boolean = synchronized(lock) {
        if (state != State.INITIALIZING || currentAttempt !== attempt) return@synchronized false
        state = if (retryable) State.IDLE else State.FAILED
        currentAttempt = null
        initializationComplete.complete(false)
        true
    }

    /** Permanently close this service, returning whether this caller claimed disposal. */
    fun close(): Boolean = synchronized(lock) {
        if (state == State.CLOSED) return@synchronized false
        state = State.CLOSED
        currentAttempt = null
        initializationComplete.complete(false)
        true
    }

    /** Wait without holding the gate lock; interruption propagates to the caller. */
    fun awaitInitialization(): Boolean {
        val completion = synchronized(lock) {
            if (state == State.CLOSED) return false
            initializationComplete
        }
        return completion.get()
    }
}
