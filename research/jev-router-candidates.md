# Jev router research and vetting

Date: 2026-11-22. Goal: use the free Jev 1.13 decision model with OpenCode v2.3.2.

## The model

`jev-1.13-free` is a **decision/classification model**, not a chat LLM. Source:
<https://opencode.ai/docs/console/models/>.

- Endpoint: `https://opencode.ai/inference/systemone/v1/systemone`
- IDs: `jev-1.13`, `jev-1.13-free` (free, limited-time, cost 0)
- Request shape:
  ```json
  {
    "model": "jev-1.13-free",
    "state": "…",
    "questions": {
      "id": { "type": "noul|choice|score", "instructions": "…", "criteria": "…" }
    }
  }
  ```
- Decision models never appear in `/models`; `opencode/<id>` cannot select them.
- OpenCode v2 exposes `ctx.experimental.generate.decisions({model, input, questions})` → `{answers}`.

## Endpoint auth probes (decisive)

- POST with **no** Authorization header → HTTP 200, real decision returned
  (`is_urgent` noul 0.94, `department` choice=billing confidence 1,
  `usage.cost: 0`, `billing_source: free`).
- POST with `Authorization: <redacted>` → HTTP 401.

Conclusion: the free endpoint needs **no** auth header, but rejects any bogus bearer token. The
`@typesafe-ai/sdk` used by the first plugin always sends a bearer header, so it needs a real key.

## Failed plugin: opencode-auto-jev@0.1.1

- Was declared in `~/.config/opencode/opencode.json`; required a TypeSafe API key file.
- Config entry initially used the V1 tuple form → OpenCode logged `skipped malformed`.
- After converting to V2 object form `{package, options}`, it failed at load:
  `Plugin must export a default definition with an id and an effect or setup function`
  (`err_c20ed89f`).
- Root cause: `dist/index.js` exports V1 `default { id, server }`; OpenCode 2.3.2 requires
  `Plugin.define({id, setup})`. npm has only 0.1.0/0.1.1 — no V2 version. Unfixable by config.

## V2 plugin API facts (from docs and local type defs)

- `Plugin.define({id, async setup(ctx)})`; `@opencode/plugin` provided at runtime.
- `ctx.options`; `ctx.agent.list()` / `ctx.skill.list()` → `{location, data: Array}`.
- `ctx.session.hook("prompt", cb)` gets mutable `{prompt, metadata, delivery}`, runs once at
  admission before skills resolve; async allowed; keep retry-safe; no typed rejection.
- `ctx.session.instructions.entry.put({sessionID, key, value})` renders a `<context key="…">` block.
- `ctx.session.switchAgent({sessionID, agent})` — mentioned agents do not auto-switch.
- `ctx.session.hook("context", …)` only edits the outgoing model call.
- Decision answers: predicate `{probability}`; choice `{choice, probabilities, confidence}`;
  score `{score, probabilities, confidence}`; error `{reason, message?}` — always handle errors.
- Global `~/.config/opencode/plugins/` is auto-discovered; registering an auto-discovered plugin in
  `opencode.json` risks double-loading.

## Candidate routers

### 1. `@npv12/opencode-jev-router@0.1.0` — CHOSEN

- MIT, repo `github.com/npv12/opencode-jev-router`, engines `opencode >=2.0.0`, devDeps only,
  no runtime deps, provenance publish.
- Source reviewed: `src/jev.ts`, `src/router.ts`, `src/options.ts`, `src/candidates.ts`.
- Endpoint: `https://opencode.ai/inference/systemone/v1/systemone`; model comes from decider id.
- Credential: `ctx.integration.connection.active("opencode")` → `resolve()` — OAuth access token
  or key; **no separate TypeSafe/OpenRouter key**.
- Decider `opencode/jev-1.13-free` maps to the console endpoint with that exact model id.
- Behavior: does **not** change the main session model. Jev picks a reasoning-effort variant for the
  current model (every prompt + every 30 steps) and **worker/subagent models** from a `models`
  whitelist. Pinned worker models are skipped; failures are pushed back into Jev.
- Defaults: `recalc.steps: 30`, `allowDowngrade: true`. Pinned decider = no fallback.
- Installed in config as:
  ```jsonc
  {
    "package": "@npv12/opencode-jev-router@0.1.0",
    "options": {
      "models": {
        "opencode-go/hy4-flash-free": "Fast general coding model for everyday edits, explanations and small tasks.",
        "opencode/tidepool-alpha-free": "Stronger free model for complex reasoning, refactors and debugging."
      },
      "default": "opencode-go/hy4-flash-free",
      "decider": "opencode/jev-1.13-free"
    }
  }
  ```
- Verified: `opencode plugin list` shows `jev-router 0.1.0`; it registers no model
  (`tools.opencode.models({provider:"jev-router"})` → 0, expected).

### 2. `opencode-jev-router-plugin@0.1.0` — rejected (more friction)

- MIT, `github.com/emmdim/opencode-jev-router-plugin`, no runtime deps.
- Routes every prompt to `cheap` / `powerful` / `fallback` via `session.switchModel` (cross-provider
  OK); six Jev questions; registers `/jev` command.
- Requires `JEV_ROUTER_API_KEY` → OpenCode integration **key credential only** (OAuth ignored) →
  `auth.json` key entry. No global `env` in `opencode.json`, so env injection into the service or a
  key entry would be needed (reading `auth.json` is blocked by CC Safety Net).
- Builds URL as `{provider settings.baseURL}/systemone`, so a custom provider with
  `settings.baseURL = https://opencode.ai/inference/systemone/v1` is required.
- Would be the fallback only if main-session model switching is mandatory.

### 3. `@misaelcs/opencode-jev@2.0.2` — rejected

- Requires an OpenRouter API key; user has none and wants free OpenCode-only path.

## Outcome

Router = npv12 (effort + subagent models). A separate local `opencode-decisions` plugin (this repo)
uses decision models directly for task-type guidance, a risk gate, agent/skill selection, a decision
ledger, and clarification. Both use the OpenCode integration credential; both fail open.

The local plugin was originally named `jev-policy` and was renamed to `opencode-decisions` to match
the repository. All Jev-specific background lives in this research folder; the plugin itself exposes
only generic "decision" naming, with model identifiers centralized in
`plugins/opencode-decisions/lib/models.js`.

Scratch tarballs and unpacked candidate sources remain (gitignored) at
`/home/dr3ff1c13nt/Projects/github/devops_portainer/.scratch/jev-vet/`; they are not committed here
to avoid vendoring third-party code.

## Cleanup completed

`~/.config/opencode/opencode.json.bak-20261122-102645` (old revoked plaintext `knowledgegraph`
Authorization token) was deleted on 2026-11-22. Newer backups never contained it.
