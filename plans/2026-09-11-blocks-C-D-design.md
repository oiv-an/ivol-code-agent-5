# Message freezing: design and implementation snapshot

> Historical snapshot from September 11, 2026, translated for publication on October 24.
> This is not a current task list or an instruction to resume implementation. Decisions,
> source line references and test results below describe that snapshot, not fresh verification.
> Current product behavior is documented in [README](../README.md). Later maintainer decisions
> supersede historical model-selection and multi-IDE delivery restrictions.

## 1. Goal

Let a model work on a long task without losing important requirements and decisions when
recency-based compression removes old context. The user and model can mark a message as
**freeze**. It then participates in every subsequent request until unfrozen. Messages are
addressed by permanent visible numbers such as `[#42]`.

## 2. Agreed mechanics

1. Normal compression summarizes the entire history, including frozen messages. Removing frozen
   input from the summary would deprive the summarizing model of essential context.
2. After compression, requests contain the summary, the latest N messages and all frozen messages
   in full.
3. A frozen message remains included until unfrozen, then behaves like an ordinary message.
4. Do not change the ordinary compression algorithm or threshold for this feature.

## 3. Decisions recorded at the time

| #   | Decision                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Delegation to a cheaper model was cancelled.                                                                        |
| 2   | Freezing is a keep mark, not a block-compression tool.                                                              |
| 3   | The mark is visible in the UI; users toggle it themselves; the model can mark its own and user messages.            |
| 4   | Frozen-message budget defaults to 50%, adjustable; automatic collapsing of repeated reads was cancelled.            |
| 5   | Provide an only-frozen filter; the model may remove user marks when asked.                                          |
| 6   | Task-based model routing was excluded from this feature. This is not the current policy for manual model selection. |
| 7   | Numbers are permanent and sequential; gaps are allowed.                                                             |
| 8   | Only freezing was requested, not model-operated compression tools.                                                  |
| 9   | Keep the English term "freeze", including in Russian UI.                                                            |
| 10  | Frozen messages participate in summarization and return to context afterwards.                                      |
| 11  | Numbers must also be visible to the user, who can request "unfreeze #20".                                           |
| 12  | Build artifacts for user testing; do not manipulate or restart IDEs.                                                |

The original handoff recorded implementation approval and said no further design decision was
required at that time. It used the ignored root task-memory document as the live working state.
That historical approval does not authorize new work today.

## 4. Rejected approaches

Automatic importance detection; automatic collapsing of repeated file reads; background
summarization by a cheaper model; addressing through a `list_context` table or descriptions;
renumbering on every request; separate LLM summary calls; model-operated `compact_messages` or
line-range compression; changing ordinary compression thresholds; work-type model routing;
translating freeze terminology; excluding frozen messages from summary input.

## 5. Implementation recorded as complete

### A1 — Freeze mechanics

- [API messages](../src/core/task-persistence/apiMessages.ts): added `seq`, `pinned`, `pinnedBy`,
  `pinnedNote`, `pinnedAt` and `pinRestored` to `ApiMessage`.
- [Message schema](../packages/types/src/message.ts): corresponding fields in `clineMessageSchema`.
- [Condense](../src/core/condense/index.ts): removed the pinned-message skip when assigning summary
  ancestry, so frozen messages are included in the summary input.
- `getEffectiveApiHistory()` builds `keepFrozen` through `collectToolPairIndices()` and retains
  frozen messages even with `condenseParent` or `truncationParent`. Whole tool-use/result pairs
  must be restored to avoid invalid API requests.
- [Context management](../src/core/context-management/index.ts): `visibleIndices` no longer
  excludes pinned messages; that exclusion displaced the truncation window and marker boundary.

### A2 — Core

[Context pinning](../src/core/kilocode/context-pinning/index.ts) provides `pinMessages()`,
`unpinMessages()`, `collectToolPairIndices()`, `checkPinnedBudget()`,
`normalizePinnedBudgetPercent()`, `getPinnedMessages()` and `isHidden()`;
`DEFAULT_PINNED_BUDGET_PERCENT = 50`, `MAX_PINNED_MESSAGES = 100`.

### A-num — Numbering

[Numbering](../src/core/kilocode/context-pinning/numbering.ts):

- `ensureSequenceNumbers()` assigns a number once, continuing from `max(seq) + 1`; existing
  numbers survive new messages, IDE restarts and migration of old tasks.
- `applyNumberPrefixToContent()` changes only the first text block. It does not add, reorder or
  delete blocks, because providers require valid block ordering.
- `assignNumbersToChatMessages()` maps API numbers to chat rows.

Integration points in [Task](../src/core/task/Task.ts) were history loading, message insertion,
chat saving and request assembly. The `[#N]` prefix exists only in outgoing requests, not stored
message text. Chat and API timestamps are not identical: each chat row takes the nearest unused
API message with a timestamp greater than or equal to its own. One API message has one number.

### A3 — UI and locale entries

- Added the `contextPinning` block to all 23 chat locale files, with English values: 275 insertions,
  no deletions in that snapshot.
- [PinMessageButton](../webview-ui/src/components/chat/kilocode/PinMessageButton.tsx) shows the
  button and `#N` number.
- [ChatRow](../webview-ui/src/components/chat/ChatRow.tsx) integrates the button for every row type;
  visible on hover, always visible when frozen.
- `setMessagePinned()` in Task and `togglePinnedMessage` in the
  [webview handler](../src/core/webview/webviewMessageHandler.ts) apply changes.

### A5 — Model tool

[freezeMessagesTool](../src/core/tools/kilocode/freezeMessagesTool.ts) accepts `messages` and
`action` (`freeze` / `unfreeze`), understands `42`, `#42`, `[#42]` and lists, and reports frozen,
already-frozen and missing numbers. Registered in seven places, including XML documentation and
the native tool schema.

## 6. Historical verification

Commands ran from their owning workspace, not the repository root.

| Check                                                                                | Recorded result                  |
| ------------------------------------------------------------------------------------ | -------------------------------- |
| `npx vitest run core/kilocode/context-pinning`                                       | 53 passed                        |
| `npx vitest run core/kilocode/context-pinning core/condense core/context-management` | 285 passed, 3 skipped            |
| `npx vitest run core/tools/kilocode/__tests__/freezeMessagesTool.spec.ts`            | 13 passed                        |
| `npx vitest run core/prompts -u`                                                     | 13 snapshots updated, 280 passed |
| `cd src && npx tsc --noEmit`                                                         | Clean                            |
| `cd webview-ui && npx tsc --noEmit`                                                  | Clean                            |

## 7. Remaining work at the snapshot date

These are historical pending items, not a claim that they remain unfinished today.

### A4 — Only-frozen filter

In [ChatView](../webview-ui/src/components/chat/ChatView.tsx), add `showFrozenOnly`, derive a
filtered `groupedMessages` list retaining `msg.pinned`, and use it at each rendering site.
Original line references were approximately 1332, 1613, 1810, 1923 and 1932. This is a display
filter only; it must not change stored history or outgoing context. Add a top-of-chat toggle and
count; locale keys already existed: `showPinnedOnly`, `showAll`, `pinnedCount_one` / `_other`.

### A6 — Budget

Normalization and the 50% default existed. A settings control and applying `checkPinnedBudget()`
on freezing remained; only `MAX_PINNED_MESSAGES` was enforced at that point.

### Delivery

The historical plan called for full tests, both type checks, a version bump, changeset, changelog,
VSIX and PhpStorm ZIP for user testing. Current regular delivery is VS Code-only; this document
is not permission to build legacy packages.

## 8. Environment lessons recorded at the time

1. If reading the large webview handler fails, use a targeted `sed -n 'X,Yp'` read.
2. Edit locale JSON surgically: a parse/stringify rewrite removed existing duplicate keys and had
   to be reverted.
3. Run backend tests inside `src`, using paths without the `src/` prefix.
4. In truncation tests, space timestamps (10, 20, 30, ...). The marker uses `firstKeptTs - 1`;
   consecutive timestamps can collide with a real message.
5. New tool registration changes prompt snapshots; review and update them with `-u`.
