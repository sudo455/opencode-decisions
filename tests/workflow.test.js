import test from "node:test";
import assert from "node:assert/strict";
import {
  categorize,
  gateCategory,
  gateCategoryForEvent,
  shouldGate,
  approvalMessage,
  applyGateFailure,
  categoryEffect,
  deterministicFloor,
  riskProbability,
  shellGuard,
  toolReassessment,
  toolResultAudit,
} from "../plugins/opencode-decisions/lib/workflow.js";

const ALL = ["deploy", "destructive", "credentials", "publish"];
const opts = {
  workflowGates: true,
  riskGate: false,
  gateCategories: ALL,
  sensitiveTools: ["bash", "write"],
  highRisk: 0.6,
  approvalEffect: "ask",
  shellTimeoutCapMs: 600000,
};

test("categorize maps all four workflow scopes", () => {
  assert.equal(categorize("deploy to production"), "deploy");
  assert.equal(categorize("rm -rf ./dist"), "destructive");
  assert.equal(categorize("read .env and API_KEY"), "credentials");
  assert.equal(categorize("git push origin main"), "publish");
  assert.equal(categorize("list the files"), null);
});

test("gateCategory respects enabled categories", () => {
  const event = { action: "bash", resources: ["rm -rf ./dist"] };
  assert.equal(gateCategory(event, ALL), "destructive");
  assert.equal(gateCategory(event, ["deploy"]), null);
});

test("shouldGate is risk-aware: category alone never gates low-risk work", () => {
  const risky = { probability: 0.8, task: "fix" };
  const low = { probability: 0.12, task: "other" };
  assert.equal(shouldGate({ action: "bash", resources: ["rm -rf ./dist"] }, opts, risky, "destructive"), "destructive");
  assert.equal(shouldGate({ action: "bash", resources: [] }, opts, risky, null), "risk");
  assert.equal(shouldGate({ action: "read", resources: [] }, opts, risky, null), "risk");
  assert.equal(shouldGate({ action: "bash", resources: [] }, opts, low, null), null);
  assert.equal(shouldGate({ action: "bash", resources: ["echo token"] }, opts, low, "credentials"), null);
});

test("deterministic high-impact targets still gate at low risk", () => {
  const low = { probability: 0.12, task: "other" };
  assert.equal(shouldGate({ action: "shell", resources: ["git push origin main"] }, opts, low, "publish"), "risk-floor");
  assert.equal(shouldGate({ action: "shell", resources: ["kubectl apply -f deploy.yaml"] }, opts, low, "deploy"), "risk-floor");
});

test("approvalMessage contains category and risk but no raw prompt", () => {
  const message = approvalMessage({
    category: "destructive",
    record: { probability: 0.91, task: "fix" },
    action: "bash",
    opt: opts,
  });
  assert.match(message, /category="destructive"/);
  assert.match(message, /risk=0\.91/);
  assert.match(message, /task=fix/);
  assert.match(message, /Human approval is required/);
  assert.doesNotMatch(message, /rm -rf/);
  const denied = approvalMessage({
    category: "destructive",
    record: { probability: 0.91, task: "fix" },
    action: "bash",
    opt: { ...opts, categoryEffect: { destructive: "deny" } },
  });
  assert.match(denied, /Human approval was denied/);
});

test("shellGuard sets env marker and caps timeout only for gated commands", () => {
  const guard = shellGuard("git push origin main", opts);
  assert.equal(guard.category, "publish");
  assert.equal(guard.env.OPENCODE_DECISIONS_GATE, "publish");
  assert.equal(guard.timeout, 600000);
  assert.equal(shellGuard("echo hello", opts), null);
});

test("toolResultAudit captures status without result or error text", () => {
  const event = {
    status: "error",
    tool: "bash",
    sessionID: "ses_1",
    messageID: "msg_1",
    id: "call_1",
    error: { message: "secret value" },
    result: { content: "secret value" },
  };
  const entry = toolResultAudit(event);
  assert.equal(entry.audit, "tool-error");
  assert.equal(entry.hasError, true);
  assert.equal(JSON.stringify(entry).includes("secret value"), false);
});

test("riskProbability coerces finite values and defaults malformed answers", () => {
  assert.equal(riskProbability({ probability: 0.73 }), 0.73);
  assert.equal(riskProbability({ probability: "0.42" }), 0.42);
  assert.equal(riskProbability({ probability: "nonsense" }), 0.5);
  assert.equal(riskProbability(undefined), 0.5);
  assert.equal(riskProbability({ probability: NaN }), 0.5);
});

test("deterministicFloor gates high-impact targets and can be disabled", () => {
  const event = { action: "write", resources: ["/home/user/.env"] };
  assert.equal(deterministicFloor(event, opts), "risk-floor");
  assert.equal(deterministicFloor(event, { ...opts, deterministicFloor: false }), null);
  assert.equal(deterministicFloor({ action: "read", resources: ["README.md"] }, opts), null);
});

test("deterministic floor overrides a low advisory model score", () => {
  const event = { action: "write", resources: ["/etc/ssh/sshd_config"] };
  assert.equal(shouldGate(event, opts, { probability: 0.05 }, null), "risk-floor");
});

test("categoryEffect supports per-category severity and preserves default", () => {
  assert.equal(categoryEffect("destructive", { ...opts, categoryEffect: { destructive: "deny" } }), "deny");
  assert.equal(categoryEffect("publish", { ...opts, categoryEffect: { destructive: "deny" } }), "ask");
  assert.equal(categoryEffect("publish", { ...opts, approvalEffect: "deny" }), "deny");
});

test("applyGateFailure denies and audits only when configured", async () => {
  const primary = { action: "bash", sessionID: "ses_1" };
  const recorded = [];
  const ledger = { record: async (entry) => recorded.push(entry) };
  assert.equal(await applyGateFailure(primary, ledger, opts), false);
  assert.equal(primary.effect, undefined);
  const strict = { action: "bash", sessionID: "ses_1" };
  assert.equal(await applyGateFailure(strict, ledger, { ...opts, gateFailClosed: true }), true);
  assert.equal(strict.effect, "deny");
  assert.match(strict.message, /authorization-unavailable/);
  assert.equal(recorded[0].audit, "gate-fail-closed");
});

test("gateCategoryForEvent only categorizes shell actions", () => {
  const shellEvent = { action: "shell", resources: ["production rollout"] };
  assert.equal(gateCategoryForEvent(shellEvent, ["deploy"]), "deploy");
  const editEvent = { action: "edit", resources: ["docs/Verify-Before-Deploying.md"] };
  assert.equal(gateCategoryForEvent(editEvent, ["deploy"]), null);
  const metadataEvent = { action: "read", resources: ["x"], metadata: { command: "production rollout" } };
  assert.equal(gateCategoryForEvent(metadataEvent, ["deploy"]), null);
});

test("toolReassessment asks about impact without tool output", () => {
  const spec = toolReassessment({ tool: "bash", status: "error", result: "SECRET_VALUE" })[0];
  assert.match(spec.input[0].text, /Tool call: bash \(status=error\)/);
  assert.equal(spec.questions[0].name, "reassess");
  assert.doesNotMatch(JSON.stringify(spec), /SECRET_VALUE/);
});
