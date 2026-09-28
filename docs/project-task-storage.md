# Project-local task history

**Store tasks inside this project** and **Hide .ivol in the IDE project tree**
are enabled by default for new tasks in local, trusted workspace folders. Storage
is initialized on the first task write, not by viewing settings. Explicit opt-outs
are respected. Change these options in **Settings → IVOL → Task storage** after
closing the current task. Existing global tasks are never moved automatically.

## What moves with the project

- `.ivol/project.json`: storage preference, visibility preference and project identity.
- `.ivol/task-history.json`: portable task index, including deletion markers.
- `.ivol/tasks/<task-id>/`: conversation files, task metadata and local checkpoints.

The index stores a relative workspace marker. Opening the moved project rebuilds
its visible task history using the new workspace path. Include hidden files when
copying the project. A Git clone intentionally does not contain this history.

Provider credentials and global configuration are not copied into this folder.
Conversation text itself can contain private data or credentials: the folder is
not encrypted.

## Existing history

Enabling the setting affects new tasks only. **Copy existing project tasks** copies
global tasks whose saved workspace path matches the current folder. It verifies
file contents, skips existing local tasks and retains global originals. Close
those tasks in other IDE windows before copying. The copy button appears only
when this project has global tasks not yet copied locally, and disappears when
none remain. Retained backup originals do not make the button reappear.

During copying, settings show a progress bar for verified and indexed tasks
(completed tasks / total tasks), with a spinner for preparation, copying or
verification. This is not a byte counter or a time estimate: a large task can
remain at the same count while its files are copied and checked. Returning to
settings restores the active operation, or its final result and any error,
including the number successfully copied before a failure. Controls stay locked
until the operation ends. This state lives in the extension host for its current
session; it is not shared between IDE processes or restored after a host restart.

Tasks saved under an old, already moved workspace path are not automatically
matched by folder name. This avoids copying another project's conversations.
They require a separately reviewed migration.

Disabling the setting directs new tasks to global storage. Existing project-local
tasks remain available and continue using their original local files. No files
are deleted by the settings toggle.

## Git and visibility

Before writing project history, the extension adds `/.ivol/` to the root
`.gitignore`. Already tracked history causes an error rather than a silent privacy
failure. Git exclusions do not prevent deliberate force-add operations.

**Hide .ivol in the IDE project tree** uses a workspace-folder file exclusion in
VS Code and a project tree provider in JetBrains. Hiding does not delete files or
encrypt them. Checkpoint snapshots exclude `.ivol/` independently of Git rules.

## Concurrency and limits

Index writes use a cross-process lock and merge changed task fields. Deletion
markers prevent an outdated index snapshot or a retained global original from
bringing a deleted local task back into the same project's history. Copy operations
are serialized per project.

This is not collaborative editing: do not run the same conversation simultaneously
in multiple IDEs. Separate tasks can update the shared project index independently.
Only open local workspace folders are discovered; closed projects are not scanned.
