# opencode-decisions — project summary

**As of:** 2026-11-26
**Repo:** https://github.com/sudo455/opencode-decisions  
**Plugin entrypoint:** `plugins/opencode-decisions/index.js`  
**Runtime:** auto-discovered by OpenCode from `~/.config/opencode/plugins/opencode-decisions` (symlink to the repo); not registered in `opencode.json`.

## Purpose

Make OpenCode's free decision model usable as a first-class policy input without replacing the user's working chat model. The plugin asks a decision model short, typed questions at prompt admission and on selected lifecycle events, then applies the answers as advisory context, tool-input rewrites, or ledger entries.

OpenCode's built-in `subagent` tool remains the delegation mechanism. The plugin does **not** create its own child sessions and does **not** select models for subagents; it only fills the optional `agent` field when the caller left it empty.

## What was built

### Core decision surface
- **Prompt hook** — once at admission, asks `task_type`, `risk`, `agent`, `skill`, and `ambiguous`.
- **Idempotent instruction block** — writes `<context key="opencode-decisions">…</context>` with task guidance, verification depth, selected agent/skill, and clarification when needed.
- **`decisions.decide` tool** — typed `predicate` / `choice` / `score` questions from inside the agent runtime.
- **`decisions.switch_agent` tool** — switches the session to any live, non-hidden primary/all agent. Explicit `@agent` mentions win.
- **`decisions.handoff` / `decisions.return_to_owner` tools** — transfer the current session to a live specialist and back with a sanitized, structured record; depth-capped and audited.
- **`/decide` command** — yes/no question fed back into the session.
- **Multi-model ensemble** — high-risk prompts are cross-checked against the configured decision models; disagreement injects a human-review note.
- **Decision cache** — identical successful decisions are cached in `ctx.storage` for 60s by default.

### Policy hooks
- **Context hook** — re-injects the stored task/risk/verification block on every agent-loop model call.
- **Compaction hook** — tells the summarizer to preserve that policy block.
- **Retry hook** — on provider failure, asks the decision model whether to retry; overrides OpenCode's decision only above the configured confidence, otherwise leaves it untouched.
- **Unified approval gate** — `riskGate` records risk and a single `permission.evaluate` hook gates deterministic high-impact targets or risk ≥ `highRisk`; low-risk category matches no longer gate, and a per-call marker prevents re-asking after approval. No second `permission.assert` path.
- **Shell and result hooks** — `shell.create.before` marks gated commands and caps timeout; `tool.execute.after` audits status without result text; `session.generate` receives the stored policy block.
- **Least privilege** — removes write tools for low-risk research/review/docs tasks when enabled.
- **Post-task gate** — opt-in `session.idle` check for high-risk work, with cooldown and a synthetic review request.

### Native subagent delegation
- `execute.before` hook sees `subagent` calls without an explicit `agent`.
- Discovers live non-hidden agents with `mode: subagent` or `mode: all`.
- Asks the decision model to pick the agent and the narrowest authority scope (`read-only` / `reversible` / `consequential`).
- Deterministic policy sets authority: consequential or high-impact targets require a human; read-only/reversible work is bounded. `leastPrivilegeAgent` may downgrade read-only picks.
- Writes `event.input.agent` only if the pick is in the live list and the contract does not require a human.
- Records one sanitized `subagent-agent` ledger entry with contract fields; failures are fail-open with an audit entry.

### Specialist handoff
- `decisions.handoff` validates the target against live specialists and switches the session.
- A structured frame records objective, responsibility, constraints, authorization, verified facts, evidence, decisions, files, and completed work.
- `decisions.return_to_owner` pops the frame and publishes findings, outstanding issues, and escalation.
- Both write an `opencode-decisions-handoff` instruction block and sanitized audit entries; depth is capped at 5.

### Governance and observability
- **Sanitized ledger** — `decisions/` entries in `ctx.storage`; prompt text, raw provider responses, and error strings are never exported.
- **Ledger query** — filter by `kind`, `audit`, `since`, `until`, `limit`; newest first.
- **Stats** — total, by kind, by model, errors, successes, average duration, last activity.
- **Commands** — `/decisions-ledger [kind] [limit]`, `/decisions-stats`, `/decisions-export [kind] [limit]`.
- **Audit entries** — approval gates, shell gates, tool results, compaction policy, retry failure, subagent decision failure, agent switch, post-task gate.
- **`failureMode`** — default `open`; `closed` injects an explicit failure notice rather than silently continuing.

### HTTP decision RPC
Registered as `Rpc.define({ id: "decisions", events: {} })`.

- `choose` — `{question, choices, state?, model?, providerID?, token}` → `{choice, model?, confidence?, probabilities?}`.
- `models` — lists models OpenCode reports with `type: "decision"`.
- `ledger` — sanitized filtered entries.
- `stats` — aggregate ledger statistics.

Wire format: `POST /api/rpc/decisions/{method}` with `{"input":{...}}` and `location.directory` set to the project directory. Two auth layers: OpenCode HTTP Basic auth plus a per-client token in the RPC payload. Transport is loopback HTTP; no new server and no TLS were added.

The generic contract lives in `lib/rpc-definition.js` so it can be unit-tested without OpenCode's runtime-only `@opencode/plugin/rpc` module. `rpc.js` is only the `Rpc.define(...)` wrapper.

## Verification

- `npm test` — 57 tests, all passing. Covers ledger sanitization/filters/stats, cache TTL and fingerprinting, `decide()` cache/error/ledger behavior, risk storage, RPC contract, native subagent agent selection (including explicit-agent short-circuit and fail-open), delegation contracts (scope/authority/least privilege/sanitization), handoff frames and stack push/pop, and workflow gate helpers (risk-aware approval, shell guards, tool-result audits).
- `node --check` — passed on `index.js`, `rpc.js`, and all `lib/*.js`.
- Hot reload with explicit `location.directory` — plugin loads cleanly; `opencode plugin list` shows `opencode-decisions local`.
- Live RPC probes — `stats` and `ledger` returned real, sanitized data.
- Live tool probe — `decisions.decide` returned a typed answer after the test/refactor changes.
- Secret scan — no secret-shaped values in the diff; RPC token occurrence in `opencode.log` is zero.

## Security notes

- RPC token file: `~/.config/opencode/decisions-rpc-tokens.json` (mode 600). Read it yourself in the Python router; never print it and never pass it via `opencode api --data` (OpenCode logs CLI args).
- `~/.secrets/opencode-api-key` exists but is unused by the current router path.
- The revoked `knowledgegraph` Authorization token was removed from the live config long ago; its old backup was deleted.
- No prompt text, raw provider response, or token value is written to the ledger or logs by this plugin.

## Known limitations

- A true mid-turn agent swap is impossible in OpenCode V2; `switch_agent` applies from the next request/step.
- Model choice for subagents is intentionally left to OpenCode and `@npv12/opencode-jev-router`. The earlier custom delegate tool was removed after it selected a quota-exhausted model.
- Audit entries are implemented but were not exercised live with a forced permission denial.
- The untracked `~/` directory in the repo tree is an mcp-smart-router cache artifact and is intentionally left alone.

## Layout

```text
README.md                              user-facing docs
SUMMARY.md                             this file
package.json                           npm test runner
research/jev-router-candidates.md      vetting record and background
plugins/opencode-decisions/
  index.js                             plugin setup, hooks, tools, commands, RPC handlers
  rpc.js                               Rpc.define wrapper
  lib/rpc-definition.js                testable RPC schema
  lib/decide.js                        shared decision caller
  lib/cache.js                         short-lived decision cache
  lib/ledger.js                        sanitized ledger/query/stats
  lib/risk.js                          per-session risk state
  lib/models.js                        decision-model endpoint IDs
  lib/subagent.js                      native subagent agent-pick + contract helper
  lib/delegation.js                    pure delegation contract / least-privilege helpers
  lib/handoff.js                       pure specialist handoff frame / stack helpers
  lib/workflow.js                      category, risk-aware gate, shell and audit helpers
tests/*.test.js                        node:test suite
```
