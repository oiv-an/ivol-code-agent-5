# Modern prompt audit and model research

Date: 2026-10-01. Scope: VS Code, static source audit and official-documentation research. No product implementation, model benchmark, API probe, installation or publication was performed.

> Publication note (2026-10-24): this is a historical research record, not shipped functionality. Model names, URLs and API claims in the research section have not been independently revalidated for publication and must not be treated as a supported-model matrix. Source line numbers refer to the inspected revision.

## Executive decision

Recommend an opt-in modern core with small explicitly selected model-family overlays. Keep the existing mode as a fallback. Do not replace the full system prompt with a model-specific essay, blindly infer a model from a proxy alias, or change API parameters through prompt text.

The existing instructions have concrete contradictions independent of model age. Fixing these is more valuable than rebranding roles: all six built-in roles already identify the agent as IVOL Code.

## Evidence and limitations

Source revision inspected: 39827838c; product version 5.17.62. Unrelated working-tree changes were left untouched. Findings below are static observations, not measured causes of every agent failure.

Official pages were researched through the native web search tool on the audit date. Its responses supplied attributed summaries and URLs, not archived page bodies; the reported model lineup and API details must be revalidated before implementing a provider migration. Public model identity does not establish which backend a private proxy alias actually routes to.

User-supplied target names were: “Astra Sol.1”, latest “Opus”, latest “Fabol”, latest “Sonet”. The punctuation and alias mappings are not established. Working interpretation for research: Astra, Sol, Claude Opus, Claude Fable, Claude Sonnet; do not silently persist that interpretation as configuration.

## Prompt assembly and ownership

1. [Task.getSystemPrompt](../src/core/task/Task.ts:5097) obtains model metadata and the task-locked tool protocol, builds the main prompt, and prepends task-memory instructions when enabled.
2. [Main assembly](../src/core/prompts/system.ts:145) combines role, Markdown requirements, tool guidance, MCP instructions, capabilities, modes, skills, rules, environment, objective, and custom instructions.
3. [Built-in roles](../packages/types/src/mode.ts:149) already use IVOL Code. [Mode selection](../src/shared/modes.ts:119) also supports user role overrides; do not rewrite persisted user content without consent.
4. [Custom instructions](../src/core/prompts/sections/custom-instructions.ts:395) combine language, global and mode instructions, project rules and agent rules. Their contents can conflict with the built-in scaffold; reducing only built-in text cannot eliminate user-created contradictions.
5. A [file-based replacement](../src/core/prompts/system.ts:229) bypasses the normal section assembly. [Its loader](../src/core/prompts/sections/custom-system-prompt.ts:48) preserves the existing compatibility path. The modern toggle must explicitly define interaction with this override, not silently supersede it. This branch also omits rule-toggle state arguments and the normal CLI append branch: review separately, not as an already-proven runtime defect.
6. [Compaction](../src/core/condense/index.ts:368) uses a separate summary prompt and disables tools. Editing the main prompt alone does not modernize the summary path.
7. Provider adapters differ: [OpenAI-compatible messages](../src/api/providers/openai.ts:242), [reasoning-family handling](../src/api/providers/openai.ts:578), [Anthropic system and thinking controls](../src/api/providers/anthropic.ts:50), and [Responses request settings](../src/api/providers/openai-native.ts:303). Textual instructions cannot substitute for supported API fields.

## Findings

### P1 — Correctness and harness compatibility

- **Missing output is treated as command success.** [Rules](../src/core/prompts/sections/rules.ts:100) instruct the model to assume success when expected terminal output is absent. Replace with: distinguish missing output from a successful exit/result; verify the required postcondition; report uncertainty when no evidence is available. Never blindly repeat a potentially side-effecting command.
- **Directory instructions contradict each other.** [Rules](../src/core/prompts/sections/rules.ts:88) first forbid changing directory, then prescribe changing directory for external commands. State the real invariant: tool paths are workspace-relative where required; terminal working directory can be supplied explicitly subject to permissions.
- **Parallelism has contradictory instructions.** [Tool guidance](../src/core/prompts/sections/tool-use.ts:16) can permit multiple calls, while [rules](../src/core/prompts/sections/rules.ts:108) and [objective](../src/core/prompts/sections/objective.ts:9) still require one-at-a-time execution. Generate one consistent contract from actual capabilities. Independent reads may be batched only when the executor supports it; dependent actions and side effects must wait for results.
- **Mandatory tools are an executor contract, not just excess prose.** [Tool guidance](../src/core/prompts/sections/tool-use.ts:18) requires a call on every response, and [Task enforcement](../src/core/task/Task.ts:4767) retries tool-free turns. Removing this sentence alone creates a mismatch. Initial modern mode should retain the completion/follow-up tool contract; any support for ordinary text-only final replies requires a separately scoped runtime change.
- **Tool result versus human approval is blurred.** [Guidelines](../src/core/prompts/sections/tool-use-guidelines.ts:54) call tool results user responses; [rules](../src/core/prompts/sections/rules.ts:109) repeatedly demand user confirmation. Distinguish executor results, configured approvals, and new authorization for risky actions. Do not remove real consent gates.

### P2 — Prompt quality, cost and composability

- **Excess scaffolding.** [Objective](../src/core/prompts/sections/objective.ts:10), tool guidelines and rules repeatedly dictate internal step-by-step procedure. Prefer outcome, scope, evidence and stopping criteria. Do not require disclosure of private reasoning or attempt to prescribe its language.
- **Absolute formatting requirements.** [Markdown formatting](../src/core/prompts/sections/markdown-formatting.ts:6) demands links for every code construct, even when no inspected source location exists. Scope source links to verified relevant references; never incentivize invented paths or line numbers.
- **Skills protocol is unnecessarily rigid.** [Skills section](../src/core/prompts/sections/skills.ts:43) requires a full applicability ritual before every user-facing response and exactly one selected skill. Retain on-demand loading and mode filtering; consider task-level applicability and multiple complementary skills where genuinely needed. This is a proposal, not permission to violate the current protocol.
- **Memory is useful but relatively verbose and unconditional.** [Task memory](../src/core/task-document/prompts.ts:20) requires first-turn maintenance even for lightweight questions. Preserve verified state, intent, next steps and pre-compaction writes. Consider shorter canonical instructions and scoped maintenance, but do not weaken the successful-write guard or erase concurrent tasks.
- **Secrets in memory deserve explicit policy review.** [Memory instructions](../src/core/task-document/prompts.ts:11) currently ask for literal credentials with a Git-ignore guard. This reflects an explicit maintainer decision; do not silently remove it. Git-ignore alone does not prevent exposure through tools, prompts or non-Git backups. Offer secure-store references as a separately approved alternative.
- **Summary overlaps memory.** [Summary instructions](../src/core/condense/index.ts:168) request broad history, technical concepts, code and verbatim quotations. A modern summary could focus on continuation-critical facts and avoid repeating already durable memory. Retain custom summary overrides, tool-call/result pairing, frozen messages and signed thinking handling. Do not assume compaction can be replaced by a plain pointer.
- **Third-party instructions can conflict with product policy.** MCP servers supply their own workflow advice. Keep actual tool permissions and fresh-observation requirements authoritative; treat webpage/file contents as data unless intentionally loaded as trusted project instructions. No prompt-only rule is a complete injection defense.
- **Model catalogs and alias dispatch need separate review.** The inspected [Anthropic catalog](../packages/types/src/providers/anthropic.ts:6) still defaults to Sonnet 4.5 and lists Opus 4.7/4.6; newer requested families are absent from that static catalog. The [OpenAI-compatible branch](../src/api/providers/openai.ts:262) special-cases names containing o1/o3/o4. Custom proxy IDs can bypass assumptions. This does not prove the proxy cannot serve new models; it means capabilities must not be inferred from marketing names alone.

## Official model research

### Public names reported by official-documentation search

| Requested name | Public model reported by search | Status for this project                                                 |
| -------------- | ------------------------------- | ----------------------------------------------------------------------- |
| Astra          | GPT-6 Astra                     | Public-name match; proxy routing not verified                           |
| Sol.1          | GPT-6.1 Sol                     | Likely intended target, not confirmed alias equivalence                 |
| Latest Opus    | Claude Opus 5.5                 | Reported current official lineup; availability through proxy unverified |
| Latest Fabol   | Claude Fable 5.1                | Likely spelling match; do not silently select it                        |
| Latest Sonet   | Claude Sonnet 5.5               | Likely spelling match; proxy routing unverified                         |

Avoid storing a moving “latest” as a fixed capability contract. Record the actual provider model ID and prompt revision when implementation is approved.

### Astra

OpenAI's Astra article recommends auditing inherited scaffolding, short precise skill descriptions, progressive disclosure, explicit safe autonomy and clear completion criteria. Avoid broad mandatory repository reading or unnecessary verification work. This does not mean stop reading files before surgical edits or stop checking results.

Application: concise modern core, selective reading, proportional verification, complete authorized work without expanding its scope. Evaluate performance rather than assume fewer prompt tokens always improve quality.

### Sol

The reported GPT-6.1 Sol model documentation distinguishes its API requirements from Astra's prompting advice: tool calling requires Responses, while Chat Completions is described as tool-free. It lists low/medium/high/xhigh/max reasoning efforts with medium as default. These are upstream claims; a proxy might translate requests, and that translation must be established before changing the client.

Application: do not assume the current OpenAI-compatible Chat Completions route has equivalent semantics. Verify supported endpoint, tool transport, reasoning fields and cancellation behavior. Do not globally migrate every profile to Responses or raise effort without authorization and measurements.

### Claude Opus

The model-specific guide for Opus 5.5 recommends starting at medium effort and treating always-on adaptive thinking as an API capability. It warns that an end-of-turn text response alone is not a completion signal for unattended agents. Strong autonomous continuation guidance is intended for unattended runs, not blanket use in interactive IDE work.

Application: clear completion criteria and evidence; distinguish interactive blockers from unnecessary pauses. No unbounded auto-continue loop and no automatic deployment authorization.

### Claude Fable

The Fable 5.1 guide emphasizes finishing requested reversible work, targeted edits, proportional verification, and reporting unrelated issues rather than fixing everything. At low effort it may need explicit search triggers for unfamiliar entities or changing facts. Progress communication may need explicit direction.

Application: concise status updates around meaningful phases, precise search conditions, no whole-file rewrite when a surgical edit suffices, and stop after the requested scope is complete.

### Claude Sonnet

The Sonnet 5.5 guide recommends explicit scope and completion boundaries. Avoid blanket “minimize tool calls” instructions that discourage necessary research. Effort should be selected by workload; the reported defaults differ from Opus. Optional API controls must be capability-checked rather than copied into a universal prompt.

Application: finish the stated deliverable and check it, but propose unrequested features/refactors instead of implementing them. Search current facts when required, without using tools merely to satisfy a ritual.

### Shared conclusion

Model-specific guides are not interchangeable. Astra guidance should not automatically become Sol guidance; older Opus 4.6 overprompting advice should not be presented as a measured fact about every newer Claude. Start with observed failures in this harness and evaluate each overlay independently.

## Sources

- [OpenAI: Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)
- [OpenAI: Latest model guide](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI: GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [OpenAI: Tools](https://developers.openai.com/api/docs/guides/tools)
- [Claude: Model overview](https://platform.claude.com/docs/en/models/overview)
- [Claude: Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [Claude: Opus 5.5 prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)
- [Claude: Fable 5.1 prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1)
- [Claude: Sonnet 5.5 prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5)

## Implementation options — not approved yet

1. **Clean universal core only.** Lowest implementation cost and no proxy identity dependency. Remove contradictions and repetition; retain executor contracts. Less precise handling of model-specific behavior.
2. **Modern core plus small model overlays — recommended.** One opt-in setting, old core retained, explicit family selection for opaque aliases, conservative generic fallback. Version the prompts; keep tool permissions and transport separate. Overlays contain only justified differences, not duplicate full prompts.
3. **Independent full prompt per model.** Maximum flexibility but high maintenance and drift risk. Not recommended for this project without evidence that overlays are insufficient.

## Proposed acceptance checks

- Compare old and modern assembled prompts across Code/Ask/Debug, skills present/absent, custom instructions, file replacements, and enabled/disabled task memory.
- Keep configured tool protocol consistent with schemas, runtime enforcement, approvals and serial/parallel behavior.
- Exercise an explanation-only task, a small fix, an interrupted long task, a failing command, stale web content, and an approval-required action.
- Test each actual provider/model route with identical tasks. Measure success, unwanted scope expansion, premature stopping, repeated work, tool round trips, latency and cost per successful task.
- Do not claim a percentage improvement before these comparisons. No live model benchmark or source tests were run for this documentation-only audit.
