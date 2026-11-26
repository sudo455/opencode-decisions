import test from "node:test";
import assert from "node:assert/strict";
import {
  SCOPES,
  PROHIBITED_ACTIONS,
  sanitizeDelegationText,
  delegationObjective,
  delegationRisk,
  delegationAuthority,
  allowedCapabilities,
  makeDelegationContract,
  validateDelegationContract,
  leastPrivilegeAgent,
  contractLedgerFields,
} from "../plugins/opencode-decisions/lib/delegation.js";

const agents = [
  { id: "build", name: "build", mode: "subagent", description: "implements changes" },
  { id: "explore", name: "explore", mode: "subagent", description: "read-only research" },
  { id: "review", name: "review", mode: "subagent", description: "read-only review" },
];
const choices = agents.map((agent) => ({ value: agent.id, description: agent.description }));
const baseEvent = {
  tool: "subagent", sessionID: "ses-1", messageID: "msg-1", id: "tool-1",
  input: { description: "Investigate the failing test and report the root cause", prompt: "..." },
};

test("sanitizeDelegationText strips secret-like patterns and bounds length", () => {
  const input = `key sk-abcdefghijklmnopqrst token ghp_abcdefghijklmnopqrstuvwxyz ${"x".repeat(5000)}`;
  const out = sanitizeDelegationText(input, 200);
  assert.equal(out.length <= 200, true);
  assert.equal(out.includes("[REDACTED]"), true);
  assert.equal(/sk-[A-Za-z0-9]{12}/.test(out), false);
});

test("delegationObjective uses the native task prompt and sanitizes it", () => {
  assert.equal(delegationObjective(baseEvent), baseEvent.input.prompt);
});

test("delegationRisk is high for destructive objectives and low otherwise", () => {
  assert.equal(delegationRisk("Investigate the failing test", {}), 0.2);
  assert.equal(delegationRisk("rm -rf the database", {}), 0.9);
  assert.equal(delegationRisk("rm -rf the database", { delegationHighRisk: 0.95 }), 0.95);
});

test("delegationAuthority escalates consequential scope and high risk", () => {
  assert.equal(delegationAuthority({ scope: "consequential", risk: 0.1 }, {}), "requires-human");
  assert.equal(delegationAuthority({ scope: "read-only", risk: 0.9 }, {}), "requires-human");
  assert.equal(delegationAuthority({ scope: "read-only", risk: 0.2 }, {}), "read-only-autonomous");
  assert.equal(delegationAuthority({ scope: "reversible", risk: 0.2 }, {}), "bounded-autonomous");
});

test("allowedCapabilities is narrow for read-only and empty for consequential", () => {
  assert.deepEqual(allowedCapabilities("read-only"), ["read", "glob", "grep", "webfetch", "list"]);
  assert.equal(allowedCapabilities("reversible").includes("bash(reversible-only)"), true);
  assert.deepEqual(allowedCapabilities("consequential"), []);
});

test("makeDelegationContract produces all required fields with stable task id", () => {
  const answers = { agent: { choice: "build" }, scope: { choice: "read-only" } };
  const a = makeDelegationContract(baseEvent, answers, "build", {});
  const b = makeDelegationContract(baseEvent, answers, "build", {});
  assert.equal(a.task_id, b.task_id);
  assert.deepEqual(validateDelegationContract(a), []);
  assert.equal(a.authority, "read-only-autonomous");
  assert.equal(a.risk, 0.2);
  assert.ok(a.correlationId);
  assert.ok(PROHIBITED_ACTIONS.every((item) => a.prohibited_actions.includes(item)));
});

test("validateDelegationContract detects missing and malformed fields", () => {
  const missing = validateDelegationContract({});
  assert.ok(missing.includes("task_id"));
  assert.ok(missing.includes("scope:invalid"));
  assert.ok(missing.includes("risk:invalid"));
  const answers = { agent: { choice: "build" }, scope: { choice: "consequential" } };
  const contract = makeDelegationContract(baseEvent, answers, "build", {});
  assert.deepEqual(validateDelegationContract(contract), []);
});

test("leastPrivilegeAgent blocks human-required and prefers readers for read-only", () => {
  const escalate = { ...makeDelegationContract(baseEvent, { scope: { choice: "read-only" } }, "build", {}), authority: "requires-human" };
  assert.equal(leastPrivilegeAgent(escalate, choices, agents), undefined);
  const readOnly = makeDelegationContract(baseEvent, { scope: { choice: "read-only" } }, "build", {});
  assert.equal(leastPrivilegeAgent(readOnly, choices, agents), "explore");
  const reversible = makeDelegationContract(baseEvent, { scope: { choice: "reversible" } }, "build", {});
  assert.equal(leastPrivilegeAgent(reversible, choices, agents), "build");
  assert.equal(leastPrivilegeAgent({ ...reversible, agent: "not-listed" }, choices, agents), undefined);
});

test("contractLedgerFields emits only sanitized scalar fields", () => {
  const contract = makeDelegationContract(baseEvent, { scope: { choice: "read-only" } }, "build", {});
  const fields = contractLedgerFields(contract);
  assert.equal(fields.kind, "delegation-contract");
  assert.equal(fields.task_id, contract.task_id);
  assert.equal(fields.scope, "read-only");
  assert.equal(fields.agent, "build");
  assert.equal(Object.values(fields).some((v) => typeof v === "object"), false);
  assert.equal(Object.values(fields).some((v) => typeof v === "string" && v.includes("sk-")), false);
});

test("SCOPES covers exactly the three declared scopes", () => {
  assert.deepEqual(SCOPES, ["read-only", "reversible", "consequential"]);
});
