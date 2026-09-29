# Bounded checkpoint previews

Checkpoint previews share the same implementation across VS Code and JetBrains editions. Snapshot creation, retention and restore are unchanged; existing snapshots do not need migration.

- Completion availability compares Git tree IDs rather than loading every changed file.
- Historical previews do not stage the working tree.
- Raw, NUL-delimited Git metadata avoids binary patch generation and preserves unusual filenames. Renames appear as a deletion and an addition.
- Each blob's size is checked before reading its content. Text previews allow at most 1 MiB per side and an 8 MiB combined read budget, with at most 500 file entries plus a truncation notice.
- Binary (NUL-containing), invalid UTF-8 and non-regular files receive explicit omission placeholders on both sides, never a misleading empty deletion. Oversized files are rejected before decoding.
- Git output is bounded (4 MiB metadata, exact bounded blob sizes), with a 15-second per-command timeout. User previews have a 30-second deadline and cancel superseded previews per service.
- VS Code progress notifications expose cancellation. JetBrains uses the shared extension-host API, but its native progress/cancel presentation has not been verified; the shared deadline and data limits still apply.
- Comparing to the working tree still stages files to include untracked files, as before. This operation is now bounded by the command timeout/cancellation. These limits do not limit snapshot size or snapshot creation costs.
- Preview failures and cancellation do not disable checkpoint creation or restore. Partial previews show a warning. New warning strings currently use the English fallback pending translation approval.

A bounded preview does not guarantee every file can be displayed, nor prevent unrelated extension-host performance problems. It prevents unbounded checkpoint content loading into editor memory.
