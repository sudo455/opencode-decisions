// Durable, scoped decision ledger backed by ctx.storage.
// Exported entries are sanitized: no prompt text, raw provider responses, or error strings.

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const value = raw.value && typeof raw.value === "object" ? raw.value : raw;
  const model = value.model && typeof value.model === "object" ? value.model : {};

  const entry = {
    id: value.id || raw.key || null,
    at: value.at || null,
    kind: value.kind || "decision",
  };
  if (value.sessionID) entry.sessionID = value.sessionID;
  const modelID = value.modelID || model.id || null;
  if (modelID) entry.model = modelID;
  if (model.providerID) entry.providerID = model.providerID;
  const durationMs = finite(value.durationMs);
  if (durationMs !== undefined) entry.durationMs = durationMs;
  const cost = finite(value.cost);
  if (cost !== undefined) entry.cost = cost;
  if (value.error) entry.error = true;

  if (Array.isArray(value.answers)) {
    entry.answers = value.answers
      .filter((answer) => answer && typeof answer === "object")
      .map((answer) => {
        const item = { type: answer.type || "?", name: answer.name || "?" };
        const probability = finite(answer.probability);
        if (probability !== undefined) item.probability = probability;
        const confidence = finite(answer.confidence);
        if (confidence !== undefined) item.confidence = confidence;
        const score = finite(answer.score);
        if (score !== undefined) item.score = score;
        return item;
      });
  }

  for (const key of ["audit", "agent", "from", "tool", "attempt", "probability", "correlationId", "task_id", "scope", "risk", "authority", "missing", "handoff_id", "responsibility", "depth", "findings", "outstanding", "escalation"]) {
    const candidate = value[key];
    if (candidate === undefined || candidate === null || candidate === "") continue;
    if (typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean") {
      entry[key] = candidate;
    }
  }

  return entry;
}

function inRange(entry, since, until) {
  if (!entry.at) return true;
  const at = Date.parse(entry.at);
  if (!Number.isFinite(at)) return true;
  if (since) {
    const start = Date.parse(since);
    if (Number.isFinite(start) && at < start) return false;
  }
  if (until) {
    const end = Date.parse(until);
    if (Number.isFinite(end) && at > end) return false;
  }
  return true;
}

export function makeLedger(ctx, enabled = true) {
  let counter = 0;

  return {
    async record(entry) {
      if (!enabled) return;
      const id = `${Date.now()}-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
      await ctx.storage.set(`decisions/${id}`, {
        id,
        at: new Date().toISOString(),
        ...entry,
      });
    },

    async recent(limit = 50) {
      return this.query({ limit });
    },

    async query({ kind, audit, limit = 50, since, until } = {}) {
      if (!enabled) return { entries: [] };
      const scanLimit = Math.min(2000, Math.max(50, Number(limit) * 10 || 50));
      const page = await ctx.storage.scan({ prefix: "decisions/", limit: scanLimit });
      let entries = (page.entries || []).map(cleanEntry).filter(Boolean);
      if (typeof kind === "string" && kind) entries = entries.filter((entry) => entry.kind === kind);
      if (typeof audit === "string" && audit) entries = entries.filter((entry) => entry.audit === audit);
      entries = entries.filter((entry) => inRange(entry, since, until));
      entries.sort((a, b) => {
        const left = a.at ? Date.parse(a.at) || 0 : 0;
        const right = b.at ? Date.parse(b.at) || 0 : 0;
        return right - left;
      });
      return { entries: entries.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))) };
    },

    async stats() {
      const empty = {
        total: 0,
        byKind: {},
        byModel: {},
        errors: 0,
        successes: 0,
        avgDurationMs: 0,
        lastAt: null,
      };
      if (!enabled) return empty;
      const page = await ctx.storage.scan({ prefix: "decisions/", limit: 2000 });
      const entries = (page.entries || []).map(cleanEntry).filter(Boolean);
      let durationTotal = 0;
      let durationCount = 0;
      for (const entry of entries) {
        empty.byKind[entry.kind] = (empty.byKind[entry.kind] || 0) + 1;
        if (entry.model) empty.byModel[entry.model] = (empty.byModel[entry.model] || 0) + 1;
        if (entry.error) empty.errors += 1;
        else empty.successes += 1;
        if (entry.durationMs !== undefined) {
          durationTotal += entry.durationMs;
          durationCount += 1;
        }
        if (entry.at && (!empty.lastAt || entry.at > empty.lastAt)) empty.lastAt = entry.at;
      }
      empty.total = entries.length;
      empty.avgDurationMs = durationCount ? Math.round(durationTotal / durationCount) : 0;
      return empty;
    },
  };
}
