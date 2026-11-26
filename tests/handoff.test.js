import test from "node:test";
import assert from "node:assert/strict";
import {
  SPECIALISTS,
  PRIMARIES,
  resolveAllowlists,
  handoffKey,
  newHandoffState,
  validateHandoffState,
  makeHandoffFrame,
  pushHandoff,
  popHandoff,
  handoffInstruction,
  handoffLedgerFields,
  roleFitQuestions,
  selectRoleFit,
  catalogItems,
} from "../plugins/opencode-decisions/lib/handoff.js";
import { makeLedger } from "../plugins/opencode-decisions/lib/ledger.js";
import { makeStorage } from "./helpers.js";

const task = {
  from: "plan",
  to: "researcher",
  responsibility: "Verify the standards register against primary sources",
  objective: "Audit the AOEF documentation",
  taskID: "AOEF-001",
  phase: "research",
  constraints: "read-only",
  authorization: "no writes",
  facts: ["OpenCode v2.4.1"],
  evidence: ["STANDARDS-REGISTER.md"],
  decisions: ["Adopt V2 semantics"],
  files: ["~/Έγγραφα/AOEF/STANDARDS-REGISTER.md"],
  completed: ["Inventory read"],
};

test("allowlist separation honours explicit options", () => {
  const routing = resolveAllowlists({
    agentAllowlist: ["plan", "build"],
    autoAgentAllowlist: ["plan"],
    switchAgentAllowlist: ["plan", "build", "researcher"],
    subagentAllowlist: ["explore"],
  });
  assert.deepEqual(routing.auto, ["plan"]);
  assert.deepEqual(routing.switch, ["plan", "build", "researcher"]);
  assert.deepEqual(routing.subagent, ["explore"]);
  assert.deepEqual(routing.migration, []);
});

test("legacy allowlist migration keeps specialists switchable", () => {
  const routing = resolveAllowlists({ agentAllowlist: ["plan", "build"] });
  assert.deepEqual(routing.auto, ["plan", "build"]);
  for (const agent of [...PRIMARIES, ...SPECIALISTS]) {
    assert.equal(routing.switch.includes(agent), true, `${agent} missing from switch allowlist`);
  }
  assert.equal(routing.subagent.includes("general"), true);
  assert.equal(routing.migration.length, 2);
});

test("defaults cover primaries and all five specialists", () => {
  const routing = resolveAllowlists({});
  assert.deepEqual(routing.auto, PRIMARIES);
  for (const agent of [...PRIMARIES, ...SPECIALISTS]) {
    assert.equal(routing.switch.includes(agent), true);
  }
  assert.equal(SPECIALISTS.length, 5);
});

test("handoff state validation rejects malformed state", () => {
  assert.deepEqual(validateHandoffState(newHandoffState("ses-1", "plan")), []);
  assert.ok(validateHandoffState(null).includes("state"));
  assert.ok(validateHandoffState({ sessionID: "ses-1" }).includes("originalOrchestrator"));
  assert.ok(validateHandoffState({ sessionID: "s", originalOrchestrator: "p", currentAgent: "p", stack: "no" }).includes("stack"));
});

test("push and pop preserve nested return destinations", () => {
  let state = newHandoffState("ses-1", "plan");
  const first = pushHandoff(state, makeHandoffFrame(task));
  assert.equal(first.error, null);
  state = first.state;
  const second = pushHandoff(state, makeHandoffFrame({ ...task, from: "researcher", to: "code-reviewer" }));
  state = second.state;
  assert.equal(state.stack.length, 2);
  assert.equal(state.currentAgent, "code-reviewer");
  const popped = popHandoff(state);
  assert.equal(popped.frame.to, "code-reviewer");
  assert.equal(popped.state.currentAgent, "researcher");
  const popped2 = popHandoff(popped.state);
  assert.equal(popped2.state.currentAgent, "plan");
  assert.equal(popHandoff(popped2.state).error, "no-active-handoff");
});

test("handoff depth limit prevents unbounded nesting", () => {
  let state = newHandoffState("ses-1", "plan");
  for (let i = 0; i < 4; i += 1) {
    const result = pushHandoff(state, makeHandoffFrame({ ...task, to: SPECIALISTS[i % SPECIALISTS.length] }), 4);
    assert.equal(result.error, null);
    state = result.state;
  }
  const blocked = pushHandoff(state, makeHandoffFrame(task), 4);
  assert.equal(blocked.error, "handoff-depth-limit");
  assert.equal(blocked.state.stack.length, 4);
});

test("handoff frame sanitizes secrets in free-text fields", () => {
  const frame = makeHandoffFrame({
    ...task,
    responsibility: "Use token sk-abcdefghijklmnopqrst to check",
    facts: ["ghp_abcdefghijklmnopqrstuvwxyz was seen"],
  });
  assert.equal(frame.responsibility.includes("[REDACTED]"), true);
  assert.equal(frame.verifiedFacts[0].includes("[REDACTED]"), true);
  assert.equal(frame.verifiedFacts[0].includes("ghp_abcdef"), false);
  assert.equal(frame.taskId, "AOEF-001");
  assert.match(frame.handoffId, /^[0-9a-f-]{36}$/);
});

test("handoff instruction carries the full continuity record", () => {
  const state = newHandoffState("ses-1", "plan");
  const pushed = pushHandoff(state, makeHandoffFrame(task));
  const text = handoffInstruction(pushed.state, pushed.frame, { findings: "All rows verified", outstanding: "Two dead links" });
  for (const label of ["Task ID", "Original objective", "Original orchestrator", "Previous active agent", "New active specialist", "Specialist responsibility", "User constraints", "Authorization boundaries", "Verified facts", "Evidence references", "Architectural decisions", "Files and components", "Completed work", "Handoff depth", "Next expected action", "Specialist findings", "Specialist outstanding issues"]) {
    assert.equal(text.includes(label), true, `missing ${label}`);
  }
  assert.equal(text.includes("<opencode-decisions-handoff>"), true);
});

test("ledger fields are scalar, sanitized and include handoff correlation", () => {
  const frame = pushHandoff(newHandoffState("ses-1", "plan"), makeHandoffFrame(task)).frame;
  const fields = handoffLedgerFields(frame, { findings: "sk-abcdefghijklmnopqrst leaked", audit: "handoff-open", correlationId: "corr-1" });
  assert.equal(fields.handoff_id, frame.handoffId);
  assert.equal(fields.task_id, "AOEF-001");
  assert.equal(fields.agent, "researcher");
  assert.equal(fields.from, "plan");
  assert.equal(fields.depth, 1);
  assert.equal(fields.findings.includes("[REDACTED]"), true);
  assert.equal(fields.correlationId, "corr-1");
  for (const value of Object.values(fields)) {
    assert.equal(["string", "number", "boolean", "undefined"].includes(typeof value), true);
  }
});

test("ledger preserves handoff fields while dropping arbitrary keys", async () => {
  const storage = makeStorage();
  const ledger = makeLedger({ storage });
  const frame = pushHandoff(newHandoffState("ses-1", "plan"), makeHandoffFrame(task)).frame;
  await ledger.record({ kind: "handoff", ...handoffLedgerFields(frame, { findings: "verified" }), secret: "do-not-export" });
  const { entries } = await ledger.query({ limit: 5 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].handoff_id, frame.handoffId);
  assert.equal(entries[0].task_id, "AOEF-001");
  assert.equal(entries[0].responsibility, frame.responsibility);
  assert.equal(entries[0].depth, 1);
  assert.equal(entries[0].findings, "verified");
  assert.equal("secret" in entries[0], false);
});

test("role-fit selection only picks allowed available specialists", () => {
  const questions = roleFitQuestions(SPECIALISTS);
  assert.equal(questions.length, 2);
  assert.equal(questions[1].choices.length, SPECIALISTS.length + 1);
  const answers = [
    { name: "specialist_required", type: "predicate", probability: 0.9 },
    { name: "specialist_agent", type: "choice", choice: "security-auditor" },
  ];
  assert.equal(selectRoleFit(answers, ["researcher", "security-auditor"]).target, "security-auditor");
  assert.equal(selectRoleFit(answers, ["researcher"]).target, null);
  assert.equal(selectRoleFit([{ name: "specialist_required", probability: 0.2 }, answers[1]], SPECIALISTS).target, "security-auditor");
  assert.equal(selectRoleFit([answers[0], { name: "specialist_agent", choice: "keep" }], SPECIALISTS).target, null);
});

test("handoff key and state are session-scoped", () => {
  assert.equal(handoffKey("ses-1"), "handoff/ses-1");
  assert.equal(newHandoffState("ses-1", "plan").sessionID, "ses-1");
});

test("catalogItems accepts direct arrays and wrapped responses", () => {
  const agents = [{ id: "researcher", mode: "all" }];
  assert.deepEqual(catalogItems(agents), agents);
  assert.deepEqual(catalogItems({ data: agents }), agents);
  assert.deepEqual(catalogItems(null), []);
});
