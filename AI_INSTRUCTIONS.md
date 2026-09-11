# AI_INSTRUCTIONS.md

> **Central working agreement for any AI agent contributing to this repository.**
> Read this file FIRST, before `CURRENT_TASK.md` and before touching any code.
> This file is owned by the project maintainer. Do not rewrite it without an explicit request.

---

## 0. Who is who

| Role                       | Who                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Project owner / maintainer | Ivan Olyansky (solo founder)                                                                                            |
| Product                    | **IVOL Code Agent 5** — a fork of [Kilo Code](https://github.com/Kilo-Org/kilocode-legacy), which itself forks Roo Code |
| Repository                 | `https://github.com/oiv-an/ivol-code-agent-5` (public, open source)                                                     |
| Working branch             | `stable-v5`                                                                                                             |
| Marketplace publisher      | `ivol`                                                                                                                  |

The project has been maintained by AI agents. You are one of them. Another AI agent may be
connected to the same working tree at the same time — see §4 (Commits).

---

## 1. Golden rules

1. **The project is public.** Anyone can fork it. Write code, comments and commit messages so
   that an outside contributor who has never spoken to us can understand them.
2. **Every change bumps the version.** No exceptions. See §3.
3. **VS Code and PhpStorm come first.** The maintainer works in those two. Other editions are
   best-effort.
4. **The agent never publishes to the Marketplace.** The agent builds the artifact and reports
   the file path. The maintainer uploads it manually. See §5.
5. **Commit only our own changes.** Never sweep up edits made by another agent. See §4.
6. **English for everything committed** — code, comments, commit messages, changesets,
   documentation. Russian is only for chat with the maintainer.

---

## 2. Language and communication

- Talk to the maintainer in **Russian**, directly and technically, no filler.
- Everything that lands in the repository is written in **English**.
- Small fix or snippet requested → answer with the code, no preamble.
- New feature or architectural question → propose 2–3 approaches first and wait for a decision
  before writing code.
- Terminal commands → one step at a time, wait for the output before continuing.

---

## 3. Versioning policy

The version lives in [`src/package.json`](src/package.json). The Marketplace rejects a version
that has already been published, so **every** release needs a new number.

The agent decides the significance:

| Bump                              | When                                                         |
| --------------------------------- | ------------------------------------------------------------ |
| `patch` (`5.16.242` → `5.16.243`) | bug fixes, small improvements, refactors, dependency updates |
| `minor` (`5.16.x` → `5.17.0`)     | new user-visible feature                                     |
| `major`                           | breaking change to settings, storage layout or public API    |

Historically the project has moved in patch steps even for features. Prefer a patch bump unless
the change genuinely alters how the product is used.

Every change also needs a changeset in `.changeset/<name>.md`:

```md
---
"ivol-code-agent-5": patch
---

Short, user-facing description of the change
```

Keep it to one line for fixes. No PR numbers, no file paths, no internal jargon — these lines
appear directly in the release notes that users read.

Documentation-only or internal tooling changes do not need a changeset, but still need a version
bump if they ship.

---

## 4. Commits and Git

### What to commit

**Only the files you changed for the current task.** Another AI agent works in the same tree and
its half-finished edits show up in `git status`. Staging them would mix unrelated work into our
history and can break the build.

Always stage explicitly:

```bash
git add path/to/file-you-changed.ts path/to/another.ts
```

Never use `git add -A`, `git add .` or `git commit -a`.

Before committing, run `git status --short`, list which files are yours, and leave the rest
untouched. If you are unsure whether a file is yours, ask.

### What never gets committed

- `.lh/` — Local History plugin data
- `CURRENT_TASK.md` — agent scratch state
- `bin/`, `dist/`, `out/` — build artifacts
- anything containing tokens, keys or personal paths

### Commit messages

English, imperative mood, one line of summary plus a short body when the change needs context:

```
Attach any file from the file system to the chat

Drag and drop now accepts any file type, and the paperclip button opens a
native picker without format filters. Paths outside the workspace are turned
into mentions so the model can read them.
```

Explain _what changed for the user_, not which functions you touched.

### Branch and remotes

- Work on `stable-v5` and push to `origin`.
- `upstream` points at the original Kilo Code repository and its push URL is deliberately
  disabled. Never push there.

---

## 5. Build and release

### Prerequisites on the maintainer's machine

- `pnpm` is **not** on `PATH`. Use `corepack pnpm ...` or the local binaries in
  `node_modules/.bin/` (`turbo`, `vsce`, `changeset`).
- Node 20.

### Release procedure

1. Bump the version in [`src/package.json`](src/package.json).
2. Add the changeset (§3).
3. Run the type checks and the tests that cover the change.
4. Build the VS Code package:
    ```bash
    corepack pnpm vsix
    ```
    The artifact lands in `bin/ivol-code-agent-5-<version>.vsix`.
5. Commit and push our files only (§4).
6. **Report the absolute path of the `.vsix` to the maintainer.** He uploads it himself at
   <https://marketplace.visualstudio.com/manage>.

The agent must **not** run `vsce publish`, `ovsx publish` or `publish:marketplace`, and must not
ask for a Marketplace token.

### JetBrains

PhpStorm is a first-class target alongside VS Code. When a change touches shared code, verify
that the JetBrains host and plugin pick it up. Build with `pnpm jetbrains:bundle` only when the
maintainer asks for a JetBrains artifact.

---

## 6. Repository layout

pnpm monorepo orchestrated by Turbo:

| Path              | Contents                                                             |
| ----------------- | -------------------------------------------------------------------- |
| `src/`            | VS Code extension — core logic, providers, tools                     |
| `webview-ui/`     | React chat UI and settings                                           |
| `packages/types/` | Shared types, including the webview ↔ extension message contract    |
| `packages/`       | Other shared packages (`ipc`, `telemetry`, `cloud`, `agent-runtime`) |
| `jetbrains/`      | JetBrains plugin (Kotlin) plus its Node.js host                      |
| `apps/`           | E2E tests, Storybook, docs                                           |

Frequently touched directories:

- `src/api/providers/` — AI provider implementations
- `src/core/tools/` — tool implementations (`read_file`, `apply_diff`, …)
- `src/core/webview/webviewMessageHandler.ts` — every message coming from the UI
- `src/services/` — MCP, browser, checkpoints, code index

---

## 7. Code conventions

### `kilocode_change` markers

This repository is a fork and is periodically synced with upstream. Mark our edits inside shared
code so merges stay manageable:

```ts
const value = 42 // kilocode_change

// kilocode_change start
const foo = 1
const bar = 2
// kilocode_change end
```

New files that are entirely ours start with `// kilocode_change - new file`.

Markers are required in `src/`, `webview-ui/` and `packages/`. They are **not** needed in
`jetbrains/`, in any `agent-manager/` directory, in paths that already contain `kilocode`, or in
`src/services/autocomplete/`.

Keep edits to shared upstream code minimal.

### Style

- Use Tailwind classes instead of inline style objects in new markup.
- VS Code CSS variables must be registered in `webview-ui/src/index.css` before use.
- Never disable a lint rule without asking.
- Never leave an empty `catch` block — log the error or let it propagate.

### Tests

- Framework: Vitest. `vi`, `describe`, `it` are globals, no imports needed.
- Naming: `*.spec.ts` / `*.spec.tsx`. Files named `*.test.ts` are **not** picked up by the
  current config.
- Run from inside the workspace that owns the `package.json`:
    ```bash
    cd src && npx vitest run core/mentions
    cd webview-ui && npx vitest run src/utils/__tests__/some.spec.ts
    ```
    Running from the repository root fails with `vitest: command not found`.
- Cover behaviour the user can observe, not implementation details. The maintainer values speed
  over exhaustive coverage — do not generate test suites nobody asked for, but do add a test when
  a change fixes a real bug.

### Type checking

```bash
cd src && npx tsc --noEmit
cd webview-ui && npx tsc --noEmit
```

Both must be clean before a release.

---

## 8. Engineering philosophy

- **Speed over perfection.** A pragmatic workaround that works reliably beats an elegant design
  that takes three days.
- **No over-engineering.** No microservices, no speculative abstraction layers, no patterns for
  the sake of patterns.
- **Warn about low ROI.** If a request would take disproportionately long, say so and offer a
  cheaper alternative before starting.
- **Practical security.** Validate inputs that come from users or the file system. Ignore
  compliance bureaucracy.

---

## 9. Working state

`CURRENT_TASK.md` in the repository root holds the live plan for whatever task is in flight:
goal, constraints, blocks with their status, verified results and the next action. Read it after
this file when you resume work or lose context. It is scratch state — never commit it.

---

## 10. Checklist before reporting a task as done

- [ ] Type checks pass in `src/` and `webview-ui/`
- [ ] Tests covering the change pass
- [ ] Version bumped in `src/package.json`
- [ ] Changeset added
- [ ] `kilocode_change` markers present in shared code
- [ ] Only our files staged, verified with `git status --short`
- [ ] Commit message written in English and understandable to an outsider
- [ ] Pushed to `origin/stable-v5`
- [ ] VSIX built and its path reported to the maintainer
- [ ] Nothing published to any marketplace by the agent
