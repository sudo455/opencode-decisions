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
| `agent` | choice from `ctx.agent.list()` | Suggest/select an agent (unless the prompt already mentions one) |
| `skill` | choice from `ctx.skill.list()` | Attach a skill (unless already attached) |
| `ambiguous` | predicate | Ask for clarification when key details are missing |

It then writes an idempotent instruction block via `ctx.session.instructions.entry.put`:
`<context key="opencode-decisions">…</context>`. Risk ≥ 0.6 → **thorough** verification, ≥ 0.3 →
**standard**, else **quick**. High risk means multiple independent passes, live/runtime state and
rollback path.

Additional capabilities:

- **Decision tool** — `decide` in the `decisions` namespace (Code Mode: `tools.decisions.decide`)
  accepts `question`, `type` (`predicate` | `choice` | `score`), `choices`/`levels`, and optional `state`.
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
  "ensemble": true
}
```

Additional model-related options: `modelID`, `ensembleModels`, `fallbackModelID`.

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
