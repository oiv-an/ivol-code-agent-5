# AGENTS.md

IVOL Code is an open source AI coding agent for VS Code, PhpStorm, and IntelliJ IDEA that generates code from natural language, automates tasks, and supports 500+ AI models.

## IVOL Fork: Supported Editions and Change Parity

User instruction recorded on **2026-09-08**:

- Maintain **VS Code, PhpStorm, and IntelliJ IDEA** together. Unless the user explicitly narrows the current task, every requested feature, behavior change, and bug fix must be assessed and implemented across all three supported editions, even if it was reported in only one IDE.
- Prefer the shared core, providers, types, and webview implementation so the same behavior reaches every edition. Do not consider a shared change complete while another supported edition still lacks it. Report any blocked implementation or unavailable verification explicitly.
- For an IDE-specific bug, fix the appropriate adapter and check the other editions for the same underlying issue and regressions; do not duplicate irrelevant platform-specific code.
- When a build or release is requested, prepare the VS Code VSIX, PhpStorm ZIP, and IntelliJ IDEA ZIP from the same source revision with the same product version, unless the user explicitly requests a narrower delivery. Validate each target and distinguish automated checks from an actual IDE launch.
- VS Code and PhpStorm are the long-term targets. IntelliJ IDEA support is provisionally needed for about one month, with a review around **2026-10-08**. This is **not an automatic end date**: stop supporting IDEA only after the user confirms the return to two editions.
- This parity rule does not authorize closing or restarting IDEs, installing builds, modifying task history or credentials, or publishing to GitHub/Marketplace without a corresponding user request. Preserve existing plugin identities and data storage paths during ordinary updates.
- Additional requested target: **PyCharm 2025.1.1.1 (PY-251.25410.159)**. Keep its shared core and applicable adapter fixes aligned with the other editions, but build its separate Java 21 / platform 251 package. Do not label a current platform 262 package as compatible with this older PyCharm or silently broaden its supported range.
- The developer's exact IDEA target is **IntelliJ IDEA 2025.3.6.1 (IU-253.33813.55)**. Keep its Java 21 / platform 253 package separate from the existing IDEA 2026.2 / Java 25 package. Include applicable shared fixes in both; for a specifically requested 2025.3 adaptation, build and verify that target without replacing the other ready artifacts.

## Project Structure

This is a pnpm monorepo using Turbo for task orchestration:

- **`src/`** - VSCode extension (core logic, API providers, tools)
- **`webview-ui/`** - React frontend (chat UI, settings)
- **`packages/`** - Shared packages (`types`, `ipc`, `telemetry`, `cloud`)
- **`jetbrains/`** - JetBrains plugin (Kotlin + Node.js host)
- **`apps/`** - E2E tests, Storybook, docs

Key source directories:

- `src/api/providers/` - AI provider implementations (50+ providers)
- `src/core/tools/` - Tool implementations (ReadFile, ApplyDiff, ExecuteCommand, etc.)
- `src/services/` - Services (MCP, browser, checkpoints, code-index)
- `packages/agent-runtime/` - Standalone agent runtime (runs extension without VS Code)

## Agent Runtime Architecture

The `@kilocode/agent-runtime` package enables running IVOL Code agents as isolated Node.js processes without VS Code.

### How It Works

```
┌─────────────────────┐     fork()      ┌─────────────────────┐
│  Agent Manager      │ ───────────────▶│  Agent Process      │
│                     │◀───── IPC ─────▶│  (extension host)   │
└─────────────────────┘                 └─────────────────────┘
```

1. **ExtensionHost**: Hosts the IVOL Code extension with a complete VS Code API mock
2. **MessageBridge**: Bidirectional IPC communication (request/response with timeout)
3. **ExtensionService**: Orchestrates host and bridge lifecycle

### Spawning Agents

Agents are forked processes configured via the `AGENT_CONFIG` environment variable:

```typescript
import { fork } from "child_process"

const agent = fork(require.resolve("@kilocode/agent-runtime/process"), [], {
	env: {
		AGENT_CONFIG: JSON.stringify({
			workspace: "/path/to/project",
			providerSettings: { apiProvider: "anthropic", apiKey: "..." },
			mode: "code",
			autoApprove: false,
		}),
	},
	stdio: ["pipe", "pipe", "pipe", "ipc"],
})

agent.on("message", (msg) => {
	if (msg.type === "ready") {
		agent.send({ type: "sendMessage", payload: { type: "newTask", text: "Fix the bug" } })
	}
})
```

### Message Protocol

| Direction      | Type           | Description                    |
| -------------- | -------------- | ------------------------------ |
| Parent → Agent | `sendMessage`  | Send user message to extension |
| Parent → Agent | `injectConfig` | Update extension configuration |
| Parent → Agent | `shutdown`     | Gracefully terminate agent     |
| Agent → Parent | `ready`        | Agent initialized              |
| Agent → Parent | `message`      | Extension message              |
| Agent → Parent | `stateChange`  | State updated                  |

### Detecting Agent Context

Code running in agent processes can check for the `AGENT_CONFIG` environment variable. This is set by the agent manager when spawning processes:

```typescript
if (process.env.AGENT_CONFIG) {
	// Running as spawned agent - disable worker pools, etc.
}
```

### State Management Pattern

The Agent Manager follows a **read-shared, write-isolated** pattern:

- **Read**: Get config (models, API settings) from extension via `provider.getState()`
- **Write**: Inject state via `AGENT_CONFIG` env var when spawning - each agent gets isolated config

```typescript
fork(agentRuntimePath, [], {
	env: { AGENT_CONFIG: JSON.stringify({ workspace, providerSettings, mode, sessionId }) },
})
```

This ensures parallel agents have independent state with no race conditions or file I/O conflicts.

## Build Commands

```bash
pnpm install          # Install all dependencies
pnpm build            # Build extension (.vsix)
pnpm lint             # Run ESLint
pnpm check-types      # TypeScript type checking
```

## Skills

- **Translation**: `.kilocode/skills/translation/SKILL.md` - Translation and localization guidelines

## Workflows

- **Add Missing Translations**: `.kilocode/workflows/add-missing-translations.md` - Run `/add-missing-translations` to find and fix missing translations

## Changesets

Each PR requires a changeset unless it's documentation-only or internal tooling. Create one with:

```bash
pnpm changeset
```

Format (in `.changeset/<random-name>.md`):

```md
---
"ivol-code-agent-5": patch
---

Brief description of the change
```

- Use `patch` for fixes, `minor` for features, `major` for breaking changes

Keep changesets concise and feature-oriented as they appear directly in release notes.

- **Only for actual changes**: Documentation-only or internal tooling changes do not need a changeset.
- **User-focused**: Avoid technical descriptions, code references, or PR numbers. Readers may not know the codebase.
- **Concise**: Use a one-liner for small fixes. For larger features, a few words or a short sentence is sufficient.

## Fork Merge Process

IVOL Code is a fork of [Roo Code](https://github.com/RooVetGit/Roo-Code). We periodically merge upstream changes using scripts in `scripts/kilocode/`.

## kilocode_change Markers

To minimize merge conflicts when syncing with upstream, mark IVOL Code-specific changes in shared code with `kilocode_change` comments.

**Single line:**

```typescript
const value = 42 // kilocode_change
```

**Multi-line:**

```typescript
// kilocode_change start
const foo = 1
const bar = 2
// kilocode_change end
```

**New files:**

```typescript
// kilocode_change - new file
```

### When markers are NOT needed

Code in these directories is IVOL Code-specific and doesn't need markers:

- `jetbrains/` - JetBrains plugin
- `agent-manager/` directories
- Any path containing `kilocode` in filename or directory name
- `src/services/autocomplete/ - Autocomplete service

### When markers ARE needed

All modifications to core extension code (files that exist in upstream Roo Code) require markers:

- `src/` (except Kilo-specific subdirectories listed above)
- `webview-ui/`
- `packages/` (shared packages)

Keep changes to core extension code minimal to reduce merge conflicts during upstream syncs.

## Code Quality Rules

1. Test Coverage:

    - Before attempting completion, always make sure that any code changes have test coverage
    - Ensure all tests pass before submitting changes
    - The vitest framework is used for testing; the `vi`, `describe`, `test`, `it`, etc functions are defined by default in `tsconfig.json` and therefore don't need to be imported from `vitest`
    - Tests must be run from the same directory as the `package.json` file that specifies `vitest` in `devDependencies`
    - Run tests with: `pnpm test <relative-path-from-workspace-root>`
    - Do NOT run tests from project root - this causes "vitest: command not found" error
    - Tests must be run from inside the correct workspace:
        - Backend tests: `cd src && pnpm test path/to/test-file` (don't include `src/` in path)
        - UI tests: `cd webview-ui && pnpm test src/path/to/test-file`
    - Example: For `src/tests/user.spec.ts`, run `cd src && pnpm test tests/user.spec.ts` NOT `pnpm test src/tests/user.spec.ts`
    - **Test File Naming Convention**:
        - Monorepo default: `.spec.ts` / `.spec.tsx`

2. Lint Rules:

    - Never disable any lint rules without explicit user approval

3. Error Handling:

    - Never use empty catch blocks - always log or handle the error
    - Handle expected errors explicitly, or omit try-catch if the error should propagate
    - Consider user impact when deciding whether to throw or log errors

4. Styling Guidelines:

    - Use Tailwind CSS classes instead of inline style objects for new markup
    - VSCode CSS variables must be added to webview-ui/src/index.css before using them in Tailwind classes
    - Example: `<div className="text-md text-vscode-descriptionForeground mb-2" />` instead of style objects
