// Pure helpers for workflow approval gates and remaining hook surfaces.
// Kept free of OpenCode runtime imports so they can be unit tested with node:test.

const PATTERNS = {
  destructive:
    /\b(rm\s+-rf|rm\s+-r|drop\s+(?:table|database)|truncate|migration|migrate|force[ -]?push|--force|hard\s+reset|delete\s+(?:all|db|database)|destroy)\b/i,
  credentials:
    /\b(api[_-]?key|secret|token|password|credential|\.env|\.secrets|\.ssh|private[_-]?key|auth\.json)\b/i,
  deploy:
    /\b(deploy(?:ment|ing|ed)?|rollout|roll[ -]?back|restart(?:ing)?\s+(?:service|server|container|stack)|production|prod)\b/i,
  publish:
    /\b(git\s+push|push(?:ing)?\s+to\s+(?:origin|remote)|npm\s+publish|docker\s+push|publish|release|gh\s+pr\s+create)\b/i,
};

const PRIORITY = ["destructive", "credentials", "deploy", "publish"];

export const GATE_CATEGORIES = Object.keys(PATTERNS);

export function categorize(text) {
  const value = typeof text === "string" ? text : "";
  for (const category of PRIORITY) {
    if (PATTERNS[category].test(value)) return category;
  }
  return null;
}

export function eventText(event = {}) {
  const resources = Array.isArray(event.resources)
    ? event.resources.map((item) => (typeof item === "string" ? item : "")).join(" ")
    : "";
  const metadata = event.metadata && typeof event.metadata === "object" ? JSON.stringify(event.metadata) : "";
  return [event.action, resources, metadata].filter(Boolean).join(" ");
}

export function gateCategory(event, enabledCategories, categories = GATE_CATEGORIES) {
  const category = categorize(eventText(event));
  if (!category) return null;
  const allowed = Array.isArray(enabledCategories) && enabledCategories.length ? enabledCategories : categories;
  return allowed.includes(category) ? category : null;
}

export function approvalMessage({ category, record, action, opt }) {
  const risk = typeof record?.probability === "number" ? record.probability.toFixed(2) : "unknown";
  const task = record?.task || "other";
  const effect = opt?.approvalEffect === "deny" ? "denied" : "requires approval";
  const lines = [
    `<opencode-decisions-gate category="${category}">`,
    `Human approval ${effect} for this ${category} operation (${action || "tool call"}).`,
    `Decision policy: task=${task}; risk=${risk}.`,
    "Confirm scope and rollback path before allowing it to proceed.",
    `</opencode-decisions-gate>`,
  ];
  return lines.join("\n");
}

export function shouldGate(event, opt, record, category) {
  if (!opt?.workflowGates && !opt?.riskGate) return null;
  if (category) return category;
  if (!record || typeof record.probability !== "number") return null;
  if (record.probability < (opt?.highRisk ?? 0.6)) return null;
  const action = String(event?.action || "");
  const resources = Array.isArray(event?.resources) ? event.resources.join(" ") : "";
  const sensitive = Array.isArray(opt?.sensitiveTools) ? opt.sensitiveTools : [];
  const isSensitive = sensitive.some((tool) => action === tool || resources.includes(tool));
  return isSensitive ? "risk" : null;
}

export function shellGuard(command, opt) {
  const text = Array.isArray(command) ? command.join(" ") : String(command || "");
  const category = categorize(text);
  const allowed = Array.isArray(opt?.gateCategories) && opt.gateCategories.length ? opt.gateCategories : GATE_CATEGORIES;
  if (!category || !allowed.includes(category)) return null;
  const cap = Number(opt?.shellTimeoutCapMs);
  const timeout = Number.isFinite(cap) && cap > 0 ? cap : undefined;
  return {
    category,
    env: { ...(opt?.shellEnv || {}), OPENCODE_DECISIONS_GATE: category },
    timeout,
  };
}

export function toolResultAudit(event) {
  const status = event?.status === "error" ? "error" : "completed";
  return {
    kind: "tool-result",
    audit: status === "error" ? "tool-error" : "tool-completed",
    tool: event?.tool,
    sessionID: event?.sessionID,
    messageID: event?.messageID,
    toolID: event?.id,
    hasError: status === "error" && Boolean(event?.error),
  };
}
