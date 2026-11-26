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


// Restrict workflow categorization to command-bearing events. File paths and
// resource text are not command strings and must not trigger operation gates.
export function gateCategoryForEvent(event, enabledCategories, categories = GATE_CATEGORIES) {
  if (String(event?.action || "") !== "shell") return null;
  return gateCategory(event, enabledCategories, categories);
}
export function gateCategory(event, enabledCategories, categories = GATE_CATEGORIES) {
  const category = categorize(eventText(event));
  if (!category) return null;
  const allowed = Array.isArray(enabledCategories) && enabledCategories.length ? enabledCategories : categories;
  return allowed.includes(category) ? category : null;
}

// Advisory model probability is never an operational risk score. Coerce only
// finite numbers (including numeric strings); anything else defaults to 0.5.
export function riskProbability(answer) {
  const raw = answer?.probability;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return 0.5;
}

// High-impact targets gate deterministically, independent of the advisory model.
// Patterns are intentionally narrow: ordinary writes are not blocked.
const FLOOR_PATTERNS = [
  /\.(env|secrets|pem|key|pfx|p12)\b/i,
  /(private[_-]?key|authorized_keys|id_rsa|credentials|auth\.json)/i,
  /(^|\/)etc\//i,
  /\b(kubectl|helm|terraform|docker\s+(stack|service))\b/i,
  /\b(git\s+push|npm\s+publish|docker\s+push|gh\s+pr\s+create)\b/i,
  /\b(deploy|rollout|rollback)\b/i,
  /\brestart(?:ing)?\s+(?:service|server|container|stack)\b/i,
];

export function deterministicFloor(event, opt) {
  if (opt?.deterministicFloor === false) return null;
  const text = eventText(event);
  return FLOOR_PATTERNS.some((re) => re.test(text)) ? "risk-floor" : null;
}

// Per-category severity lets destructive/publish operations be denied outright
// while others remain an approval request. Default preserves prior behavior.
export function categoryEffect(reason, opt) {
  const mapped = opt?.categoryEffect && typeof opt.categoryEffect[reason] === "string"
    ? opt.categoryEffect[reason]
    : undefined;
  if (mapped === "deny" || mapped === "ask") return mapped;
  return opt?.approvalEffect === "deny" ? "deny" : "ask";
}

export function approvalMessage({ category, record, action, opt }) {
  const risk = typeof record?.probability === "number" ? record.probability.toFixed(2) : "unknown";
  const task = record?.task || "other";
  const denied = categoryEffect(category, opt) === "deny";
  const lines = [
    `<opencode-decisions-gate category="${category}">`,
    `Human approval ${denied ? "was denied" : "is required"} for this ${category} operation (${action || "tool call"}).`,
    `Decision policy: task=${task}; risk=${risk}.`,
    "Confirm scope and rollback path before allowing it to proceed.",
    `</opencode-decisions-gate>`,
  ];
  return lines.join("\n");
}

export function shouldGate(event, opt, record, category) {
  if (!opt?.workflowGates && !opt?.riskGate) return null;
  const floor = deterministicFloor(event, opt);
  if (floor) return floor;
  if (!record || typeof record.probability !== "number") return null;
  if (record.probability < (opt?.highRisk ?? 0.6)) return null;
  if (opt?.categoryGates === false) return "risk";
  return category || "risk";
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

// Authorization-service failure is separate from advisory classification
// failure. Opt-in fail-closed gate; never enabled by default in this change.
export async function applyGateFailure(event, ledger, opt) {
  if (!opt?.gateFailClosed) return false;
  try {
    event.effect = "deny";
    event.message = [
      '<opencode-decisions-gate category="authorization-unavailable">',
      "Authorization service unavailable; operation denied until it is restored.",
      "</opencode-decisions-gate>",
    ].join("\n");
    if (ledger) {
      await ledger.record({
        kind: "audit",
        audit: "gate-fail-closed",
        sessionID: event?.sessionID,
        agent: event?.agent,
        action: event?.action,
      });
    }
  } catch {
    // A ledger failure must not turn a deny into an allow.
    event.effect = "deny";
  }
  return true;
}

// Reassessment uses tool identity and status only, never tool output, so
// secrets cannot be shipped to the decision model by this path.
export function toolReassessment(event) {
  const tool = typeof event?.tool === "string" ? event.tool : "unknown";
  const status = event?.status === "error" ? "error" : "completed";
  return [
    {
      input: [{ type: "text", text: `Tool call: ${tool} (status=${status}).` }],
      questions: [
        {
          type: "predicate",
          name: "reassess",
          instructions:
            "Does this completed tool call have irreversible or high-impact effects that should now be treated as high-risk?",
        },
      ],
    },
  ];
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
