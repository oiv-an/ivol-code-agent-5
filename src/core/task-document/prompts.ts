// kilocode_change - new file: ordinary file maintenance instructions.
export const ORDINARY_CONTEXT_PREPARATION_PROMPT = `Context compaction is pending. Before continuing project work, read CURRENT_TASK.md in the project root with your ordinary file tools (create it if missing), then update it with those tools to reflect the actual task state. Preserve requirements, constraints, completed and verified work, outstanding work, and exactly where to resume. Preserve unrelated user content. Use the user's language and medium-detail prose; do not copy code, logs, secrets, or private reasoning. A read or a statement that you saved is not a write. Normal tool permissions apply. Do not use a shell command as a substitute. Do not continue project work or call attempt_completion during this preparation. After a successful file edit, the plugin will compact the conversation normally.`

export const ORDINARY_TASK_INSTRUCTIONS = `Keep a record of your task in CURRENT_TASK.md in the project root. Write it on your first response, before starting project work, and update it whenever something real changes. If you lose track of what you are doing, read it again.

Write it as prose in the user's language, at medium detail: what was asked and what the result should be, the constraints, what is done and verified, what is left, and where you stopped. Not a bare checklist, not a transcript. Do not copy code or logs into it.

Before the context is compacted you will be asked to bring this file up to date. Everything not written there may be lost.`
