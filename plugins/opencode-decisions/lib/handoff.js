// Same-session specialist takeover helpers. Pure functions only; the plugin
// owns storage, switching, instruction entries and ledger writes.

import crypto from "node:crypto";
import { sanitizeDelegationText } from "./delegation.js";

export const SPECIALISTS = [
  "researcher",
  "code-reviewer",
  "security-auditor",
  "qa-verifier",
  "documentation-reviewer",
];

export const PRIMARIES = ["plan", "build"];

const asList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : []);

// OpenCode catalog helpers may return an array directly or wrapped in { data }.
export function catalogItems(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data)) return response.data;
  return [];
}

// Explicit new options win. Otherwise the legacy agentAllowlist is migrated to
// auto + switch routing, and child delegation keeps its own default set.
export function resolveAllowlists(opt = {}) {
  const legacy = asList(opt.agentAllowlist);
  const auto = asList(opt.autoAgentAllowlist);
  const switching = asList(opt.switchAgentAllowlist);
  const subagents = asList(opt.subagentAllowlist);

  let autoAgents = auto;
  let switchAgents = switching;
  let subagentAgents = subagents;
  const migration = [];

  if (!auto.length && legacy.length) {
    autoAgents = legacy.slice();
    migration.push("agentAllowlist -> autoAgentAllowlist");
  }
  if (!switching.length && legacy.length) {
    // Legacy allowlist governed primary admission only. Switching must still
    // permit the five specialists so same-session takeover keeps working.
    switchAgents = [...new Set([...legacy, ...SPECIALISTS])];
    migration.push("agentAllowlist -> switchAgentAllowlist (+ specialists)");
  }
  if (!autoAgents.length) autoAgents = PRIMARIES.slice();
  if (!switchAgents.length) switchAgents = [...PRIMARIES, ...SPECIALISTS];
  if (!subagentAgents.length) subagentAgents = [...SPECIALISTS, "explore", "general"];

  return {
    auto: autoAgents,
    switch: switchAgents,
    subagent: subagentAgents,
    migration,
  };
}

export function handoffKey(sessionID) {
  return `handoff/${String(sessionID || "unknown")}`;
}

export function newHandoffState(sessionID, orchestrator) {
  return {
    sessionID: String(sessionID || "unknown"),
    originalOrchestrator: String(orchestrator || "unknown"),
    currentAgent: String(orchestrator || "unknown"),
    stack: [],
    updatedAt: new Date().toISOString(),
  };
}

export function validateHandoffState(state) {
  const missing = [];
  if (!state || typeof state !== "object") return ["state"];
  for (const field of ["sessionID", "originalOrchestrator", "currentAgent"]) {
    if (typeof state[field] !== "string" || !state[field]) missing.push(field);
  }
  if (!Array.isArray(state.stack)) missing.push("stack");
  return missing;
}

export function makeHandoffFrame({ from, to, responsibility, objective, taskID, task, phase, constraints, authorization, facts, evidence, decisions, files, completed }) {
  return {
    handoffId: crypto.randomUUID(),
    taskId: typeof taskID === "string" && taskID ? taskID : `TASK-${crypto.randomUUID().slice(0, 8)}`,
    from: String(from || "unknown"),
    to: String(to || "unknown"),
    responsibility: sanitizeDelegationText(responsibility || "Perform the assigned specialist responsibility", 500),
    objective: sanitizeDelegationText(objective || "", 1000),
    phase: sanitizeDelegationText(phase || "in-progress", 100),
    task: sanitizeDelegationText(task || "other", 100),
    constraints: sanitizeDelegationText(constraints || "", 600),
    authorization: sanitizeDelegationText(authorization || "", 600),
    verifiedFacts: Array.isArray(facts) ? facts.slice(0, 20).map((item) => sanitizeDelegationText(String(item), 300)) : [],
    evidence: Array.isArray(evidence) ? evidence.slice(0, 20).map((item) => sanitizeDelegationText(String(item), 300)) : [],
    decisions: Array.isArray(decisions) ? decisions.slice(0, 20).map((item) => sanitizeDelegationText(String(item), 300)) : [],
    files: Array.isArray(files) ? files.slice(0, 20).map((item) => sanitizeDelegationText(String(item), 300)) : [],
    completed: Array.isArray(completed) ? completed.slice(0, 20).map((item) => sanitizeDelegationText(String(item), 300)) : [],
    outstanding: [],
    failures: [],
    nextAction: "Read this handoff record, perform the responsibility, then call decisions.return_to_owner with structured findings.",
    state: "active",
    createdAt: new Date().toISOString(),
  };
}

export function pushHandoff(state, frame, maxDepth = 5) {
  const base = state && !validateHandoffState(state).length ? state : newHandoffState(frame?.sessionID, frame?.from);
  const depth = base.stack.length;
  if (depth >= Math.max(1, Number(maxDepth) || 5)) {
    return { state: base, frame: null, error: "handoff-depth-limit" };
  }
  const next = {
    ...base,
    currentAgent: frame.to,
    stack: [...base.stack, { ...frame, depth: depth + 1 }],
    updatedAt: new Date().toISOString(),
  };
  return { state: next, frame: next.stack[next.stack.length - 1], error: null };
}

export function popHandoff(state) {
  if (!state || !Array.isArray(state.stack) || state.stack.length === 0) {
    return { state, frame: null, error: "no-active-handoff" };
  }
  const frame = state.stack[state.stack.length - 1];
  const stack = state.stack.slice(0, -1);
  const next = {
    ...state,
    stack,
    currentAgent: stack.length ? stack[stack.length - 1].to : state.originalOrchestrator,
    updatedAt: new Date().toISOString(),
  };
  return { state: next, frame, error: null };
}

export function handoffInstruction(state, frame, result = {}) {
  const value = (label, items) => (Array.isArray(items) && items.length ? items.join("; ") : "none recorded");
  const lines = [
    "<opencode-decisions-handoff>",
    `Task ID: ${frame.taskId}`,
    `Original objective: ${frame.objective || "none recorded"}`,
    `Original orchestrator: ${state.originalOrchestrator}`,
    `Previous active agent: ${frame.from}`,
    `New active specialist: ${frame.to}`,
    `Current task owner: ${frame.to}`,
    `Current phase: ${frame.phase}`,
    `Specialist responsibility: ${frame.responsibility}`,
    `User constraints: ${frame.constraints}`,
    `Authorization boundaries: ${frame.authorization}`,
    `Verified facts: ${value("verified", frame.verifiedFacts)}`,
    `Evidence references: ${value("evidence", frame.evidence)}`,
    `Architectural decisions: ${value("decisions", frame.decisions)}`,
    `Files and components: ${value("files", frame.files)}`,
    `Completed work: ${value("completed", frame.completed)}`,
    `Known failures: ${value("failures", frame.failures)}`,
    `Outstanding work: ${value("outstanding", frame.outstanding)}`,
    `Handoff depth: ${frame.depth || 1}`,
    `Next expected action: ${frame.nextAction}`,
  ];
  if (result.findings) lines.push(`Specialist findings: ${sanitizeDelegationText(result.findings, 800)}`);
  if (result.outstanding) lines.push(`Specialist outstanding issues: ${sanitizeDelegationText(result.outstanding, 600)}`);
  if (result.escalation) lines.push(`Escalation: ${sanitizeDelegationText(result.escalation, 400)}`);
  lines.push("</opencode-decisions-handoff>");
  return lines.join("\n");
}

export function handoffLedgerFields(frame, extra = {}) {
  const fields = {
    handoff_id: frame.handoffId,
    task_id: frame.taskId,
    from: frame.from,
    agent: frame.to,
    responsibility: frame.responsibility,
    depth: frame.depth,
  };
  for (const key of ["findings", "outstanding", "escalation", "audit"]) {
    if (typeof extra[key] === "string" && extra[key]) fields[key] = sanitizeDelegationText(extra[key], 500);
  }
  if (typeof extra.correlationId === "string") fields.correlationId = extra.correlationId;
  return fields;
}

export function roleFitQuestions(specialists) {
  return [
    {
      type: "predicate",
      name: "specialist_required",
      instructions:
        "Does this request clearly require one of the specialist roles (researcher, code-reviewer, security-auditor, qa-verifier, documentation-reviewer) to take over the current session?",
      criteria: {
        true: "A specialist's distinct responsibility is clearly required",
        false: "The current primary agent can handle the request",
      },
    },
    {
      type: "choice",
      name: "specialist_agent",
      instructions: "Which specialist should take over the current session? Choose 'keep' if none is clearly required.",
      choices: [
        { value: "keep", description: "Keep the current agent" },
        ...specialists.map((value) => ({ value, description: `Specialist: ${value}` })),
      ],
    },
  ];
}

export function selectRoleFit(answers, allowed) {
  const predicate = Array.isArray(answers) ? answers.find((item) => item?.name === "specialist_required") : undefined;
  const choice = Array.isArray(answers) ? answers.find((item) => item?.name === "specialist_agent") : undefined;
  const confidence = typeof predicate?.probability === "number" ? predicate.probability : 0;
  const target = typeof choice?.choice === "string" ? choice.choice : "keep";
  return {
    confidence,
    target: target !== "keep" && allowed.includes(target) ? target : null,
  };
}
