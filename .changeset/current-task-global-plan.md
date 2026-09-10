---
"ivol-code-agent-5": minor
---

Rename the experimental task-memory mode to Current Task and its file to CURRENT_TASK.md, without legacy-file migration. Maintain a global block plan from the first task response, update it before compaction, and reload the verified plan for continuation without duplicating it in compacted history. Applies to the shared VS Code and JetBrains core and interface; the original context handoff mode is unchanged.
