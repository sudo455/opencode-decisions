import test from "node:test";
import assert from "node:assert/strict";
import {
  categorize,
  gateCategory,
  shouldGate,
  approvalMessage,
  shellGuard,
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

test("shouldGate uses category or high-risk sensitive fallback", () => {
  const risky = { probability: 0.8, task: "fix" };
  assert.equal(shouldGate({ action: "bash", resources: ["rm -rf ./dist"] }, opts, risky, "destructive"), "destructive");
  assert.equal(shouldGate({ action: "bash", resources: [] }, opts, risky, null), "risk");
  assert.equal(shouldGate({ action: "read", resources: [] }, opts, risky, null), null);
  assert.equal(shouldGate({ action: "bash", resources: [] }, opts, { probability: 0.2 }, null), null);
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
  assert.doesNotMatch(message, /rm -rf/);
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
