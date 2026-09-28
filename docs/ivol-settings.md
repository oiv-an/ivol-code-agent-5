# IVOL settings

Open **Settings → IVOL** (the first item, with a sparkles icon). The same webview is used by VS Code, PhpStorm, IntelliJ IDEA (262 and 253), and PyCharm 251. No adapter or storage migration is required.

## Contents and persistence

- **Selected provider profile:** task working-file memory, MAX/MED/MIN model presets, and native web search with a dedicated search model for OpenAI-compatible and OpenAI Responses profiles. These edit the same draft as Providers; the displayed profile name may differ from the active profile. Select another profile in Providers. Use the main **Save** button, or discard the draft when leaving settings.
- **Task memory:** the frozen-message context budget is a global preference saved by the main Save button. Automatic condensation thresholds and ordinary context limits remain in Context.
- **Project task storage:** enable/hide project-local storage and copy existing tasks with progress. These retain their existing immediate actions and busy-state protection.
- **BrowserOS and personal Chrome:** browser mode selection, connection and permission controls, task-action preference, pause/resume/revoke, and advanced MCP server selection. Opening settings only observes connection status; it does not grant access. Preferences retain the usual Save behavior; connection/permission buttons act immediately.
- **Telegram:** credentials and status retain the dedicated Telegram save action. Secrets do not enter the provider/global draft.

Provider URLs, credentials, model selection, transport settings, terminal, auto-approval, standard isolated-browser controls, display preferences, autocomplete and upstream experiments remain in their existing sections. A fork-specific implementation improvement does not by itself make a standard setting an IVOL feature.

## Adding features

Put new IVOL-specific settings in `webview-ui/src/components/settings/IvolSettings.tsx`, grouped by function. Extract reusable controls from mixed upstream sections rather than duplicating them. Keep persisted keys and profile/global save semantics unchanged. Register searchable controls with `SearchableSetting`, a stable setting ID, and `section="ivol"`. Programmatic settings navigation uses `values: { section: "ivol" }` / `targetSection="ivol"`; do not redirect entire mixed legacy sections.

Add English and Russian labels; other locales use the existing English fallback. Cover the actual IVOL tab contents, absence of legacy duplicates, search navigation and Save/Discard behavior. Shared webview checks do not substitute for launching each IDE; no IDE was launched or installed for this change.
