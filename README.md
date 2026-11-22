# opencode-decisions

OpenCode V2 plugins and research around the free **Jev 1.13** decision model.

Jev (`jev-1.13-free`) is a System One decision model from TypeSafe AI, served by OpenCode at
`https://opencode.ai/inference/systemone/v1/systemone`. It is **not a chat model**: it never appears in
`/models` and cannot be selected as a session model. It returns structured decisions (choice /
predicate / score) with probabilities and confidence. Use it through the decision API or a plugin.

## Contents

- `plugins/jev-policy/` — local OpenCode V2 plugin that runs Jev on every prompt and applies policies.
- `research/` — vetting notes: endpoint probes, candidate routers, and why one was chosen.

## jev-policy plugin

`id: jev-policy`. Registered by **auto-discovery only** — it is not listed in `opencode.json`.

### What it does

On each prompt (once, at admission, before skills resolve) it sends the prompt text, attachment names,
and agent mentions to `ctx.experimental.generate.decisions` with `jev-1.13-free` and asks:

| Question | Type | Purpose |
|---|---|---|
| `task_type` | choice: fix, feature, refactor, review, docs, research, other | Tailor instructions to the kind of work |
| `risk` | predicate | Risk gate: deployment, production config, credentials, migration, destructive work |
| `agent` | choice from `ctx.agent.list()` | Suggest/select an agent (unless the prompt already mentions one) |
| `skill` | choice from `ctx.skill.list()` | Attach a skill (unless already attached) |
| `ambiguous` | predicate | Ask for clarification when key details are missing |

It then writes an idempotent instruction block via `ctx.session.instructions.entry.put`:
`<context key="jev-policy">…</context>`. Risk ≥ 0.6 → **thorough** verification, ≥ 0.3 → **standard**,
else **quick**. High risk means multiple independent passes, live/runtime state and rollback path.

Additional capabilities:

- **Jev as a tool** — `jev_decide` (Code Mode: `tools.jev.decide`) accepts `question`, `type`
  (`predicate` | `choice` | `score`), `choices`/`levels`, and optional `state`.
- **`/decide` command** — asks Jev a yes/no question about the supplied prompt text and feeds the
  result back into the session.
- **Risk gate** — for sensitive tools (`write`, `edit`, `patch`, `bash`) at high risk, calls
  `ctx.permission.assert`; your permission rules decide whether to allow, ask, or deny.
- **Least privilege** — when enabled, removes write/edit/patch tools from the model call for
  low-risk `research`, `review`, and `docs` tasks.
- **Decision ledger** — every decision, tool call, and ensemble run is stored under `decisions/`
  in `ctx.storage`. Show recent entries with `/jev-ledger`.
- **Multi-model ensemble** — high-risk prompts are also sent to `gpt-6-luna-decision` and
  `gemini-decision-1`. Disagreement or a confidence split injects "obtain human review".
- **Prompt clarification** — ambiguous prompts get a clarification directive appended; existing
  attachment mention offsets stay valid because the text is only appended to.

Credential comes from the OpenCode integration (`ctx.integration.connection.active("opencode")` →
`resolve()`), the same one used by the router. **Fail open**: any Jev error, missing credential, or
timeout is logged as `[jev-policy] failed open` and the prompt proceeds unchanged.

### Install

```bash
git clone https://github.com/sudo455/opencode-decisions.git ~/Projects/github/opencode-decisions
ln -s ~/Projects/github/opencode-decisions/plugins/jev-policy \
      ~/.config/opencode/plugins/jev-policy
```

`~/.config/opencode/plugins/` is auto-discovered for immediate entries. Do **not** also add this plugin
to `opencode.json` — that would double-load it and double every Jev call.

Verify:

```bash
opencode plugin list | grep jev-policy
```

On the next prompt you should see an injected `<context key="jev-policy">` block (task, risk,
verification, agent/skill). If Jev is unavailable, prompts continue normally.

### Options

Defaults can be overridden by registering the plugin explicitly with options instead of relying on
auto-discovery. Defaults:

```jsonc
{
  "enabled": true,
  "modelID": "jev-1.13-free",
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
  "ensembleModels": ["jev-1.13-free", "gpt-6-luna-decision", "gemini-decision-1"],
  "fallbackModelID": "jev-1.13"
}
```

### Limits / caveats

- This plugin does **not** change the main chat model — decision models are not chat models.
- `@npv12/opencode-jev-router` (separate plugin) handles reasoning effort and subagent model choice;
  it also never changes the main session model.
- The prompt hook sees the prompt before skills resolve; explicit `@agent` mentions are preserved.
- Jev calls happen in addition to the router's Jev calls (the free endpoint reports cost 0).
- The risk gate relies on your permission rules. If no rule matches, `ctx.permission.assert` allows
  the action; add explicit `ask`/`deny` rules for the actions you want gated.
- Ensemble calls use paid decision models (`gpt-6-luna-decision`, `gemini-decision-1`) only on
  high-risk prompts. Set `"ensemble": false` to avoid that cost.
- `jev-1.13-free` is limited-time. Set `modelID` to `jev-1.13` when it expires.

## Related

- `research/jev-router-candidates.md` — full vetting record.
- OpenCode plugin docs: <https://opencode.ai/docs/build/plugins/server.md>
- Console models: <https://opencode.ai/docs/console/models/>
