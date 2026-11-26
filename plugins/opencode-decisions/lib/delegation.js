// Decision-model-driven subagent delegation with least-privilege contracts.
// The decision model supplies objective classification and an agent choice;
// deterministic policy decides whether delegation is allowed at all.
// Pure module — no OpenCode runtime imports, so it is directly unit testable.

import crypto from "node:crypto";
import { categorize, deterministicFloor, riskProbability } from "./workflow.js";

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /nvapi-[A-Za-z0-9_-]{12,}/g,
  /AKIA[A-Z0-9]{12,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._-]{20,}/g,
];

export const SCOPES = ["read-only", "reversible", "consequential"];
export const PROHIBITED_ACTIONS = Object.freeze([
  "deploy", "publish", "push", "release", "credentials or token access",
  "system-wide configuration", "production changes", "disabling security controls",
  "broadening permissions", "expanding own authority",
]);

export function sanitizeDelegationText(text, max = 2000) {
  let value = typeof text === "string" ? text : "";
  for (const re of SECRET_PATTERNS) value = value.replace(re, "[REDACTED]");
  value = value.replace(/\s+/g, " ").trim();
  return value.slice(0, max);
}

export function delegationObjective(event) {
  const input = event?.input && typeof event.input === "object" ? event.input : {};
  // Preserve the native subagent hook's existing behavior: the full prompt is
  // the task text; description is only a short label. Sanitization still applies.
  return sanitizeDelegationText(input.prompt || input.description || input.objective || "");
}

export function delegationRisk(objective, opt) {
  if (categorize(objective)) return opt?.delegationHighRisk ?? 0.9;
  const floorEvent = { action: "subagent", resources: [objective] };
  return deterministicFloor(floorEvent, opt) ? (opt?.delegationHighRisk ?? 0.9) : (opt?.delegationLowRisk ?? 0.2);
}

export function delegationAuthority({ scope, risk }, opt) {
  if (scope === "consequential") return "requires-human";
  const high = opt?.delegationHighRisk ?? 0.9;
  if (typeof risk === "number" && risk >= high) return "requires-human";
  return scope === "reversible" ? "bounded-autonomous" : "read-only-autonomous";
}

export function allowedCapabilities(scope) {
  if (scope === "read-only") return ["read", "glob", "grep", "webfetch", "list"];
  if (scope === "reversible") return ["read", "glob", "grep", "webfetch", "list", "write", "edit", "bash(reversible-only)"];
  return [];
}

export function makeDelegationContract(event, answers, agent, opt = {}) {
  const input = event?.input && typeof event.input === "object" ? event.input : {};
  const objective = delegationObjective(event);
  const modelScope = answers?.scope?.choice;
  const scope = SCOPES.includes(modelScope) ? modelScope : "read-only";
  const risk = delegationRisk(objective, opt);
  const seed = `${event?.messageID || ""}:${event?.id || ""}:${objective}`;
  return {
    task_id: sanitizeDelegationText(input.task_id || `dlg-${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12)}`, 128),
    objective,
    scope,
    allowed_capabilities: allowedCapabilities(scope),
    prohibited_actions: [...PROHIBITED_ACTIONS],
    deliverables: sanitizeDelegationText(input.deliverables || "structured delegated result", 500),
    acceptance_criteria: sanitizeDelegationText(input.acceptance_criteria || "result with independent evidence", 500),
    risk,
    authority: delegationAuthority({ scope, risk }, opt),
    agent,
    correlationId: crypto.randomUUID(),
  };
}

export function validateDelegationContract(contract) {
  const required = ["task_id", "objective", "scope", "deliverables", "acceptance_criteria", "agent", "authority"];
  const missing = required.filter((field) =>
    !(typeof contract?.[field] === "string" && contract[field].trim()));
  if (!SCOPES.includes(contract?.scope)) missing.push("scope:invalid");
  if (typeof contract?.risk !== "number" || !Number.isFinite(contract.risk)) missing.push("risk:invalid");
  // An empty capability list is valid and expected for consequential work,
  // whose authority is "requires-human" — it grants no autonomous capabilities.
  if (!Array.isArray(contract?.allowed_capabilities)) {
    missing.push("allowed_capabilities:invalid");
  }
  if (!Array.isArray(contract?.prohibited_actions) || !contract.prohibited_actions.length) {
    missing.push("prohibited_actions:invalid");
  }
  return missing;
}

// Least privilege: for read-only objectives, prefer a specialist whose declared
// identity is read-only. Never upgrade authority on model recommendation alone.
export function leastPrivilegeAgent(contract, choices, agents) {
  if (contract.authority === "requires-human") return undefined;
  if (!choices.some((entry) => entry.value === contract.agent)) return undefined;
  if (contract.scope !== "read-only") return contract.agent;
  const reads = /research|review|read|audit|explore|qa| scout/i;
  const eligible = agents.filter((agent) => reads.test(`${agent.id} ${agent.name || ""} ${agent.description || ""}`));
  if (!eligible.length) return contract.agent;
  const preferred = eligible.find((agent) => agent.id === contract.agent);
  if (preferred) return contract.agent;
  return eligible[0].id;
}

export function contractLedgerFields(contract) {
  return {
    kind: "delegation-contract",
    task_id: contract.task_id,
    scope: contract.scope,
    risk: contract.risk,
    authority: contract.authority,
    agent: contract.agent,
    correlationId: contract.correlationId,
  };
}

export { riskProbability };
