# opencode-decisions

OpenCode V2 plugin and research around structured decision models.

Decision models are not chat models. They never appear in `/models` and cannot be selected as a
session model. They return structured decisions (choice / predicate / score) with probabilities and
confidence, which this plugin uses to set task guidance, verification depth, agent/skill selection,
risk gating, and clarification. See [`research/`](research/) for the specific models, endpoint
probes, and router vetting.

## Contents

- `plugins/opencode-decisions/` — local OpenCode V2 plugin that applies decision policies on each prompt.
- `research/` — vetting notes: endpoint probes, candidate routers, and why one was chosen.

## opencode-decisions plugin

`id: opencode-decisions`. Registered by **auto-discovery only** — it is not listed in `opencode.json`.

### What it does

On each prompt (once, at admission, before skills resolve) it sends the prompt text, attachment names,
and agent mentions to `ctx.experimental.generate.decisions` and asks:

| Question | Type | Purpose |
|---|---|---|
| `task_type` | choice: fix, feature, refactor, review, docs, research, other | Tailor instructions to the kind of work |
| `risk` | predicate | Risk gate: deployment, production config, credentials, migration, destructive work |
| `agent` | choice from `ctx.agent.list()` | Select an agent (unless the prompt already mentions one); see [Agent switching](#agent-switching) |
| `skill` | choice from `ctx.skill.list()` | Attach a skill (unless already attached) |
| `ambiguous` | predicate | Ask for clarification when key details are missing |

It then writes an idempotent instruction block via `ctx.session.instructions.entry.put`:
`<context key="opencode-decisions">…</context>`. Risk ≥ 0.6 → **thorough** verification, ≥ 0.3 →
**standard**, else **quick**. High risk means multiple independent passes, live/runtime state and
rollback path.

Additional capabilities:

- **Decision tool** — `decide` in the `decisions` namespace (Code Mode: `tools.decisions.decide`)
  accepts `question`, `type` (`predicate` | `choice` | `score`), `choices`/`levels`, and optional `state`.
- **Agent switch tool** — `switch_agent` in the same namespace (Code Mode:
  `tools.decisions.switch_agent`) takes `{ agent, reason? }`. The working model can call it mid-task
  when it decides it needs a different mode. See [Agent switching](#agent-switching).
- **Default subagent delegation** — OpenCode's built-in `subagent` tool stays in charge of launching
  and reporting children. When no `agent` is specified, a decision model picks the best subagent type
  from the live agent catalog; the model stays under OpenCode's normal routing. See
  [Default subagent delegation](#default-subagent-delegation).
- **`/decide` command** — asks a yes/no decision question about the supplied prompt text and feeds
  the result back into the session.
- **Risk gate** — for sensitive tools (`write`, `edit`, `patch`, `bash`) at high risk, calls
  `ctx.permission.assert`; your permission rules decide whether to allow, ask, or deny.
- **Least privilege** — when enabled, removes write/edit/patch tools from the model call for
  low-risk `research`, `review`, and `docs` tasks.
- **Decision ledger** — every decision, tool call, and ensemble run is stored under `decisions/`
  in `ctx.storage`. Show recent entries with `/decisions-ledger`.
- **Multi-model ensemble** — high-risk prompts are also sent to the other configured decision
  models. Disagreement or a confidence split injects "obtain human review".
- **Prompt clarification** — ambiguous prompts get a clarification directive appended; existing
  attachment mention offsets stay valid because the text is only appended to.
- **HTTP decision RPC** — an external process (e.g. an MCP router) can call any decision model over
  plain HTTP without a Code Mode tool call. See [HTTP decision RPC](#http-decision-rpc).
- **Decision cache** — identical successful decisions are cached in `ctx.storage` for 60s by default,
  cutting duplicate calls when several agents/plugins ask the same question.
- **Context / compaction policy** — the stored risk record is re-sent as a compact system block on
  every agent-loop model call and included in compaction so it survives summarization.
- **Retry policy** — on a provider failure, a short-timeout decision can override OpenCode's retry
  decision; if the decision model is unavailable, OpenCode's built-in decision stands.
- **Post-task gate** (opt-in) — on `session.idle`, a high-risk session can be checked again and a
  synthetic review request injected. Cooldown and opt-in defaults keep it quiet.

Credential comes from the OpenCode integration (`ctx.integration.connection.active("opencode")` →
`resolve()`). **Fail open**: any decision error, missing credential, or timeout is logged as
`[opencode-decisions] failed open` and the prompt proceeds unchanged.

### Install

```bash
git clone https://github.com/sudo455/opencode-decisions.git ~/Projects/github/opencode-decisions
ln -s ~/Projects/github/opencode-decisions/plugins/opencode-decisions \
      ~/.config/opencode/plugins/opencode-decisions
```

`~/.config/opencode/plugins/` is auto-discovered for immediate entries. Do **not** also add this plugin
to `opencode.json` — that would double-load it and double every decision call.

Verify:

```bash
opencode plugin list | grep opencode-decisions
```

On the next prompt you should see an injected `<context key="opencode-decisions">` block (task, risk,
verification, agent/skill). If the decision service is unavailable, prompts continue normally.

### Options

Defaults can be overridden by registering the plugin explicitly with options instead of relying on
auto-discovery. Model identifiers are defined in `plugins/opencode-decisions/lib/models.js`; their
background and selection rationale are in [`research/`](research/).

```jsonc
{
  "enabled": true,
  "timeoutMs": 6000,
  "highRisk": 0.6,
  "mediumRisk": 0.3,
  "maxChoices": 12,
  "toolDecide": true,
  "commandDecide": true,
  "ledger": true,
  "ledgerLimit": 50,
  "riskGate": true,
  "leastPrivilege": false,
  "restrictedTools": ["write", "edit", "patch"],
  "sensitiveTools": ["write", "edit", "patch", "bash"],
  "clarify": true,
  "clarifyThreshold": 0.7,
  "ensemble": true,
  "rpc": true,
  "rpcTimeoutMs": 6000,
  "switchTool": true,
  "agentAllowlist": [],
  "agentFallback": true,
  "highRiskAgent": "plan",
  "lowRiskAgent": "build",
  "decisionCache": true,
  "decisionCacheMs": 60000,
  "contextPolicy": true,
  "compactionPolicy": true,
  "retryPolicy": true,
  "retryDecisionMs": 1200,
  "retryConfidence": 0.6,
  "postTaskGate": false,
  "postTaskGateMs": 60000,
  "failureMode": "open",
  "subagentDecision": true,
  "subagentMaxChoices": 12
}
```

Additional model-related options: `modelID`, `ensembleModels`, `fallbackModelID`.

### Agent switching

Two layers, so you don't have to type a mode:

1. **Per prompt (already active):** the decision model discovers every non-hidden primary/all agent
   from `ctx.agent.list()` and picks one. By default `agentAllowlist` is `[]` (no hardcoded list), so
   the whole discovered catalog is offered — all of it, uncapped by `maxChoices` (that limit applies
   only to skills). Set `agentAllowlist: ["build", "plan"]` to restrict the menu to specific agents.
   The agent question states when to pick `plan` vs `build` for design/implementation work.
   If the decision model returns `keep`, an invalid id, or fails, `agentFallback` applies a
   deterministic rule: high risk (≥ `highRisk`) → `highRiskAgent` (`plan`), otherwise →
   `lowRiskAgent` (`build`). Explicit `@agent` mentions always win. The injected context block says
   `Agent selected by decision model: …` or `… by risk fallback: …`.
2. **Mid-task (model-triggered):** the working model can call `tools.decisions.switch_agent({
   agent: "<any discovered agent id>", reason: "…" })` when it decides the work needs a different
   mode. The plugin validates the target against the live agent list (and allowlist, if set), calls
   `ctx.session.switchAgent`, writes an `opencode-decisions-switch` instruction, and records an
   `agent-switch` entry in the ledger.

**Limitation:** OpenCode V2 does not support a true mid-turn agent swap — `agent` is readonly in every
per-model-call hook, and `switchAgent` changes *subsequent requests*. The tool therefore takes effect
from the next step/request, not instantly inside the current tool call. It does not override an
explicit `@agent` mention.

### Default subagent delegation

This plugin does **not** replace OpenCode's built-in `subagent` tool. It stays in charge of launching
children, background execution, reports, and model selection. The plugin only adds an `execute.before`
hook: when the model calls `subagent` **without** an explicit `agent`, the decision model picks the
best subagent type from the live catalog (`ctx.agent.list()`, mode `subagent` or `all`) and the plugin
sets `input.agent`. An explicit `agent` always wins. The decision model is given the task prompt but
never logs it; the ledger stores only the chosen agent id, session, message, and tool id.

`subagentMaxChoices` caps the agent menu (default 12). Set `subagentDecision: false` to disable this
hook entirely. The delegated child's model remains whatever OpenCode and `@npv12/opencode-jev-router`
normally select — this plugin does not choose or override it.

### In-session policy hooks

`contextPolicy` and `compactionPolicy` re-inject the saved task/risk/verification record on every
agent-loop model call and into compaction prompts, so the policy survives long sessions.
`retryPolicy` asks the decision model (bounded by `retryDecisionMs`) whether a provider failure is
worth retrying; it only overrides OpenCode's decision when confidence crosses `retryConfidence`,
and otherwise leaves the built-in decision untouched.

`postTaskGate` is **off by default**. When enabled, it subscribes to `session.idle`; for a session
whose stored risk is ≥ `highRisk`, it asks whether human review is needed and, if so, injects a
synthetic review request. A per-session cooldown (`postTaskGateMs`) prevents loops.

All hooks are fail-open by default. Set `failureMode: "closed"` to inject a caution block when the
decision subsystem is unavailable; this does not block prompts.

### HTTP decision RPC

For a separate process (e.g. an MCP router), the plugin registers a generic RPC at
`POST /api/rpc/decisions/choose` and `POST /api/rpc/decisions/models`. It is **not** a new OpenCode tool.
Model selection is in the payload, so any model OpenCode reports with `type: "decision"` can be used;
omitting `model`/`providerID` uses the plugin's configured default.

**Authentication is two layers:**

1. OpenCode server HTTP Basic auth (`opencode` / its generated password). The router must supply it.
2. A per-client token in the RPC payload. Tokens are read at setup from
   `~/.config/opencode/decisions-rpc-tokens.json`, e.g.:
   ```json
   { "universal-hub": "<token>" }
   ```
   Create it without printing the secret:
   ```bash
   umask 077 && printf '{"universal-hub":"%s"}\n' "$(openssl rand -hex 32)" > ~/.config/opencode/decisions-rpc-tokens.json
   ```
   If the file is missing/empty, or the token is missing/wrong, the RPC returns `unauthorized`.

`choose` request:

```json
{
  "question": "Which tool answers: what time is it?",
  "choices": ["time-get_current_time", "fetch-fetch"],
  "state": "tool name — tool description ...",
  "model": "jev-1.13",
  "providerID": "opencode",
  "token": "<token>"
}
```

Response (top-level, no wrapper):

```json
{"choice":"time-get_current_time","model":"jev-1.13","confidence":1,"probabilities":[]}
```

Errors are `decision_failed` (with `reason`), `unsupported_model` (with `model`), and `unauthorized`
(with `reason`). A returned choice outside `choices` is always `decision_failed` — never invented.
`models` takes `{"token":"..."}` and returns the list of decision models OpenCode reports.

Prompts, tokens, credentials, and raw provider responses are never logged. This plugin does not manage
MCP servers; wiring this RPC into one or many MCPs is the router's job.

### Limits / caveats

- This plugin does **not** change the main chat model — decision models are not chat models.
- The separate router plugin handles reasoning effort and subagent model choice; it also never
  changes the main session model.
- The prompt hook sees the prompt before skills resolve; explicit `@agent` mentions are preserved.
- Decision calls happen in addition to the router's calls. The free endpoint reports cost 0.
- The free decision model is limited-time. See [`research/`](research/) before relying on it.
- The risk gate relies on your permission rules. If no rule matches, `ctx.permission.assert` allows
  the action; add explicit `ask`/`deny` rules for the actions you want gated.
- Ensemble calls use paid decision models only on high-risk prompts. Set `"ensemble": false` to avoid
  that cost.

## Related

- [`research/jev-router-candidates.md`](research/jev-router-candidates.md) — full vetting record and model background.
- OpenCode plugin docs: <https://opencode.ai/docs/build/plugins/server.md>
- Console models: <https://opencode.ai/docs/console/models/>
