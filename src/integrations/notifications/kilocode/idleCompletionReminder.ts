// kilocode_change - new file

import * as vscode from "vscode"

import { showSystemNotification } from "../index"

/**
 * Reminds the user that a task has finished while they were away.
 *
 * Nothing is shown right after the task completes: the user is very often still
 * sitting in front of the editor and does not need to be told what they just saw
 * happen. Instead a timer is started, and only when it expires - and the window
 * is still unfocused - a notification is raised so the operating system can draw
 * attention to the editor (a bouncing dock icon on macOS, a flashing taskbar
 * button on Windows).
 *
 * The window is never forced to the foreground and focus is never stolen.
 */
export const IDLE_COMPLETION_REMINDER_DELAY_MS = 5 * 60 * 1000

const NO_OP_DISPOSABLE: vscode.Disposable = { dispose: () => {} }

/**
 * Not every host implements the whole window API - the JetBrains bridge, for
 * one, only mirrors the parts it needs. A missing focus API must never take the
 * editor down, so we fall back to assuming the user is present, which at worst
 * means one reminder is skipped.
 */
function defaultIsWindowFocused(): boolean {
	return vscode.window?.state?.focused ?? true
}

function defaultOnWindowStateChange(listener: (focused: boolean) => void): vscode.Disposable {
	if (typeof vscode.window?.onDidChangeWindowState !== "function") {
		return NO_OP_DISPOSABLE
	}

	return vscode.window.onDidChangeWindowState((state) => listener(state.focused))
}

export interface IdleCompletionReminderOptions {
	/** How long to wait after completion before reminding the user. */
	delayMs?: number
	/** Tells whether the editor window currently has focus. */
	isWindowFocused?: () => boolean
	/** Subscribes to focus changes so a returning user cancels the reminder. */
	onWindowStateChange?: (listener: (focused: boolean) => void) => vscode.Disposable
	/** Delivers the reminder. Overridable for tests. */
	notify?: (options: { title: string; subtitle?: string; message: string }) => Promise<void> | void
}

export class IdleCompletionReminder {
	private timer: ReturnType<typeof setTimeout> | undefined
	private windowStateListener: vscode.Disposable | undefined
	private pendingMessage: string | undefined

	private readonly delayMs: number
	private readonly isWindowFocused: () => boolean
	private readonly onWindowStateChange: (listener: (focused: boolean) => void) => vscode.Disposable
	private readonly notify: (options: { title: string; subtitle?: string; message: string }) => Promise<void> | void

	constructor(options: IdleCompletionReminderOptions = {}) {
		this.delayMs = options.delayMs ?? IDLE_COMPLETION_REMINDER_DELAY_MS
		this.isWindowFocused = options.isWindowFocused ?? defaultIsWindowFocused
		this.onWindowStateChange = options.onWindowStateChange ?? defaultOnWindowStateChange
		this.notify = options.notify ?? showSystemNotification
	}

	/**
	 * Starts the countdown for a finished task. A newer completion replaces an
	 * older pending reminder, so the user is never told about stale results.
	 */
	public scheduleReminder(message: string): void {
		this.cancel()
		this.pendingMessage = message

		this.windowStateListener = this.onWindowStateChange((focused) => {
			// The user came back on their own, so there is nothing left to announce.
			if (focused) {
				this.cancel()
			}
		})

		this.timer = setTimeout(() => {
			this.timer = undefined
			void this.fire()
		}, this.delayMs)
	}

	/** Drops a pending reminder, for example when the task continues. */
	public cancel(): void {
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = undefined
		}

		this.windowStateListener?.dispose()
		this.windowStateListener = undefined
		this.pendingMessage = undefined
	}

	public dispose(): void {
		this.cancel()
	}

	private async fire(): Promise<void> {
		const message = this.pendingMessage
		this.cancel()

		if (!message) {
			return
		}

		// Last check: the user may have returned without a focus event reaching us.
		if (this.isWindowFocused()) {
			return
		}

		try {
			await this.notify({ title: "IVOL Code", message })
		} catch (error) {
			console.error("Could not show idle completion reminder", error)
		}
	}
}
