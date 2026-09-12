# Current Task (experimental)

As of 5.16.257, Current Task uses ordinary file tools to maintain a readable task record in the project root. It combines a standing system instruction with an enforced file update before ordinary context condensation. It is not a lossless memory system.

## Enable the feature

In the provider profile settings, enable **Current Task (experimental)** and save the profile. The checkbox is in the main provider options, before provider-specific configuration; it is not shown in the welcome view. The same profile setting is also available under **Prompts → Support Prompts → Context Condensing**. Profile edits remain drafts until saved.

Decision override dated 2026-09-12, effective in 5.16.258: the setting is on by default for provider profiles without a saved choice. Explicit saved `false` remains off; only an absent value or `true` enables the preference. Invalid imported values do not enable it. Profiles are not migrated or overwritten, and clearing or switching profiles uses the new default rather than inheriting a previous profile's opt-out. Draft profile settings use their own choice, independently of the active profile. The old intelligent context reset control has been removed; there are no longer two mutually exclusive modes. The English and Russian scope help reflects this decision.

The feature requires an open local project and a supported host: VS Code (including Insiders), PhpStorm, IntelliJ IDEA, or PyCharm. Spawned standalone agents and unsupported hosts use standard condensation. Enabling the setting or opening a project does not itself start a model request or create a file.

## Ordinary task notes

The fixed working file is [`CURRENT_TASK.md`](../CURRENT_TASK.md) in the project root. The model reads, creates, and edits it with the same file tools used for other project files, subject to normal permissions, approval, and ignore/protection rules.

When enabled, a short instruction near the top of each system prompt asks the model to:

- Write the task record on its first response, before project work, and update it when something real changes.
- Describe the request, intended result, constraints, completed and verified work, outstanding work, and where it stopped.
- Use medium-detail prose in the user's language rather than a transcript or a bare checklist.
- Read the file again if it loses track of the task.

The instruction is rebuilt with the system prompt and survives conversation condensation. This is an instruction to the model, not an automatic disk snapshot: file contents are not injected into every request. There is no dedicated document writer, ownership section, revision protocol, or summary pointer replacing the normal conversation summary.

The visible TODO list is independent. Updating or completing TODO items does not write the working file and cannot satisfy the pre-condensation requirement. A recorded plan is not permission to perform work the user has not authorized.

## Before condensation

Manual condensation, automatic condensation, context-overflow recovery, extended-thinking recovery, and the condensation tool use the same preparation path when Current Task is enabled.

1. The existing request loop asks the active model to read the root working file, create it if missing, and update the actual task state with ordinary file tools. It asks the model to preserve unrelated user content and not to continue project work during preparation.
2. This task instance must observe a successful file-tool write to that exact root file during this preparation. A previous save, an external editor change, a shell command, a read, a TODO update, or a statement that the file was saved does not count.
3. The assistant turn must finish, and tool results must be saved before the write can authorize condensation. Outstanding native tool calls block condensation; a partial response or transport retry cannot authorize it.
4. The plugin then performs a **separate ordinary conversation summary**, using the normal summary prompt and configured condensation customization/provider. Recent retained messages, signed thinking requirements, and user-frozen history remain subject to the existing condensation rules.
5. The resulting summary and actual context capacity are validated before condensed history is committed. A successful commit clears the pending preparation intent.

Manual condensation can run on a short valid history after an assistant response without waiting for the automatic threshold. The resulting context still has to fit the selected model's window; manual condensation is not a promise of token savings. Automatic condensation must still free space. A mode mismatch is reported rather than silently selecting a different algorithm.

A manual request made during active work queues preparation. It does not approve an outstanding file tool or command on the user's behalf.

## Failure, explicit choice, and restart

Rejected, cancelled, or failed writes do not satisfy preparation and do not authorize history compression. Empty responses, provider failures, incompatible configuration changes, or **four completed preparation turns without a successful write** stop preparation and leave it waiting for a user decision. Transport retries are not completed preparation turns.

The explicit choices are **Retry update** and **Continue without updating**:

- **Retry update** starts fresh write observation and another preparation attempt.
- **Continue without updating** authorizes ordinary condensation without the write for this operation only. Summary validation and context-capacity checks still apply.

There is no automatic bypass. YOLO/auto-approval and queued messages cannot make this decision for the user. If the task was cancelled or stopped, resume it or request condensation again to reach the decision.

Only pending intent is persisted per task: a format version and the preparation trigger. Provider configuration, credentials, write evidence, and bypass authorization are not stored in that intent. Resuming after a restart or crash restores an unfinished operation as **waiting**, not as approved or already written. Existing plugin identities and task-storage locations are unchanged.

Failure or cancellation does not compress the prior history; completed tool outcomes may still be recorded. If a write succeeded but a subsequent summary or history transaction failed, the file edit remains on disk while history is not committed as condensed. This is not a rollback of ordinary file edits.

## Cost and limits

Preparation costs the actual model turns needed to read and write the file, followed by the separate ordinary summary request. Reading and writing can require multiple turns; there is **no promise of exactly one extra request**. Retries and later re-reading add cost too. Ordinary file contents and tool results are sent to the selected provider as conversation context and consume tokens.

There are no feature-specific managed-section byte budgets or compact-document retry protocol. Ordinary file-tool limits and the model's context window still apply. If the model cannot perform a valid update within the available context and four completed turns, preparation waits for the user rather than silently truncating the task record.

The plugin checks that a write occurred, not that the prose is complete or correct. The model may omit an important requirement, preserve stale information, or fail to follow the standing instruction. Review the record on important tasks. **There is no completeness guarantee.**

The root file is shared by tasks in the same project. This feature adds **no concurrent-write protection beyond ordinary tools**: no ownership markers, per-task sections, or project-wide locks. The instruction to preserve unrelated content is not isolation. Coordinate concurrent agents and review their changes.

Do not put secrets, private reasoning, copied logs, or credentials in task notes. The preparation instruction asks the model not to copy them, but ordinary file writes have **no feature-specific secret-redaction guarantee**. Review file contents and Git changes before sharing or committing them.

## Disabled mode and old files

With the setting disabled, the standing instruction and enforced update are absent and standard condensation applies. Disabling does not delete the working file or task history. A pending unfinished operation still requires an explicit decision; disabling is not an implicit bypass.

The plugin does not migrate, read for handoff, rewrite, or delete old [`CONTEXT_RESTART.md`](../CONTEXT_RESTART.md) or [`CURRENT_WORK.md`](../CURRENT_WORK.md) files. Obsolete handoff metadata in saved histories is ignored. Existing project rules remain ordinary project rules; this feature does not create or rewrite them automatically.

## Supported packages and verification

The shared core and webview implement this behavior for all supported editions. JetBrains packages retain their separate platform and Java targets:

| Edition                  | Platform target                 | Java target         |
| ------------------------ | ------------------------------- | ------------------- |
| VS Code                  | Existing extension engine range | Node extension host |
| PhpStorm 2026.2          | PS 262                          | 25                  |
| IntelliJ IDEA 2026.2     | IU 262                          | 25                  |
| IntelliJ IDEA 2025.3.6.1 | IU-253.33813.55; 253 range      | 21                  |
| PyCharm 2025.1.1.1       | PY-251.25410.159; 251 range     | 21                  |

A 262 package is not an older IDEA or PyCharm package. Building archives neither installs them nor restarts an IDE.

Automated tests cover the ordinary request loop, real file-tool execution with temporary storage, write observation, explicit decisions, persisted intent, native result pairing, and condensation boundaries. Package checks can verify version, identity, bytecode target, archive structure, and fresh shared bundles. Neither unit tests nor static plugin verification constitute a real IDE smoke test.

After separately authorized installation, manually check each edition: save an opted-in profile; start a task; review its ordinary file edits; condense a short valid history; reject a write and exercise each explicit choice; resume an interrupted preparation; and disable the setting to compare standard behavior. Also review the semantic quality of the saved record and resumed work. Do not treat concurrent edits as protected by this feature.
