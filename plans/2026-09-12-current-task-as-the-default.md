# CURRENT_TASK.md: a prompt block plus one forced update before compaction

Supersedes every earlier note from this day. Self-compression, model routing and the prompt
rewrites are all dropped.

## The shape of it

Two pieces, nothing else.

**1. A short block in the system prompt.** It tells the model to keep `CURRENT_TASK.md` current and
to re-read it when it has lost the thread. The system prompt is rebuilt on every request and
survives compaction untouched, so the instruction is always in front of the model. No injection of
file contents, no managed argument, no revision protocol.

**2. One forced update immediately before compaction.** When the history is about to shrink, the
model must read `CURRENT_TASK.md`, bring it in line with what it has actually done and where it
stands, and only then continue. After that edit lands, ordinary condensing runs with the stock
`SUMMARY_PROMPT`.

The guarantee survives; the machinery that used to provide it does not need to.

## Decided

| Question                         | Decision                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| How the requirement is satisfied | The plugin observes a successful write to `CURRENT_TASK.md` during that turn. Nothing else counts, no new protocol.              |
| If the model fails or refuses    | Block compaction, show the error, and let the **user** choose: retry the update, or continue without it. Never decided silently. |
| Manual compaction                | Same path as automatic. Pressing the button starts the update first, then compacts.                                              |
| Cost                             | One full request, as today. Accepted.                                                                                            |

## Why this is cheap

Today the pre-compaction step is entangled with `CONTEXT_RESTART.md`: the model's answer is captured
as a body, written through a managed writer with ownership markers and revision checks, verified by
re-reading, retried when oversize, and the summary message carries a SHA-256 so a later read can be
proven. On top of that, a proof-of-read protocol forces the model's first post-compaction action to
be a verified read of that exact file.

The new version is one ordinary turn: the model edits the file with its normal tools, the plugin
confirms the write, compaction proceeds.

## What gets deleted

**The whole `context-handoff` module.** Two files, ~80 KB with its test, plus its callers:

- [`src/core/context-management/context-handoff.ts`](src/core/context-management/context-handoff.ts:1) and its test
- read-proof tracking, consumption, un-consumption and file deletion in [`Task.ts`](src/core/task/Task.ts:1)
- handoff re-arming on rewind in [`message-manager/index.ts`](src/core/message-manager/index.ts:1)
- six `contextHandoff*` fields on `ApiMessage`
- the special snapshot handling in [`ReadFileTool.ts`](src/core/tools/ReadFileTool.ts:1)
- settings `intelligentContextResetEnabled` / `intelligentContextResetPrompt`, their migration and UI

**Most of `task-document`.** [`document.ts`](src/core/task-document/document.ts:1) (ownership markers,
revisions, locking), [`limits.ts`](src/core/task-document/limits.ts:1) (byte budgets, serialization),
[`session.ts`](src/core/task-document/session.ts:1) (verified snapshots) and their tests. The model
writes the file itself now.

Also: the `task_document` argument on `update_todo_list` — protocol, native declaration, XML parsing,
parameter description — and the oversize-retry path in [`condense/index.ts`](src/core/condense/index.ts:1).

## What survives

- Decision override dated 2026-09-12 for 5.16.258: the checkbox defaults on for profiles without a saved choice on supported hosts. Explicit opt-outs remain off; invalid imports do not enable it. No profile migration or persisted schema default is introduced. Unknown host support remains unsupported until state arrives. On means the prompt block is present and the pre-compaction update is enforced. This supersedes the original off-by-default decision; publication of the new version is authorized, but IDE installation and restart are not.
- The gate in [`context-management/index.ts`](src/core/context-management/index.ts:1), simplified: it
  still blocks compaction until the requirement is met, but the requirement is now "the file was
  written", not "a verified handoff record exists".
- `SUMMARY_PROMPT` — ordinary condensing, unchanged, running after the update.
- Freezing — untouched, no setting, always on.
- The TODO list, independent again.

## The prompt block

Injected near the top of the system prompt when the setting is on:

> Keep a record of your task in `CURRENT_TASK.md` in the project root. Write it on your first
> response, before starting project work, and update it whenever something real changes. If you
> lose track of what you are doing, read it again.
>
> Write it as prose in the user's language, at medium detail: what was asked and what the result
> should be, the constraints, what is done and verified, what is left, and where you stopped. Not a
> bare checklist, not a transcript. Do not copy code or logs into it.
>
> Before the context is compacted you will be asked to bring this file up to date. Everything not
> written there may be lost.

## The failure dialogue

When the update turn ends without a write to `CURRENT_TASK.md`, the chat shows what went wrong and
offers two actions:

- **Retry** — run the update turn again.
- **Continue without updating** — compact anyway, accepting the loss.

Until the user picks, the history is not touched. This covers the genuinely stuck case — a context
so full that the update itself cannot run — without ever silently discarding work.

Points to settle during implementation:

- The same waiting state must survive an IDE restart, or the task will sit blocked with no visible
  dialogue.
- Cancelling the update (existing abort signal) should land in the same state rather than failing
  the whole compaction.

## Order

1. Delete `context-handoff` and everything referencing it; verify ordinary condensing still works.
2. Replace the managed pre-compaction preparation with the forced ordinary edit plus the write
   check.
3. Add the failure dialogue with its two buttons.
4. Delete the now-unused parts of `task-document` and the `task_document` protocol argument.
5. Wire the prompt block in behind the existing checkbox.
6. Docs, changelog, version, build.
