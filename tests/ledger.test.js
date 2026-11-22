import test from "node:test";
import assert from "node:assert/strict";
import { makeLedger } from "../plugins/opencode-decisions/lib/ledger.js";
import { makeStorage } from "./helpers.js";

function ledgerWith(entries = []) {
  const storage = makeStorage();
  for (const [key, value] of entries) storage.map.set(key, value);
  return { ledger: makeLedger({ storage }), storage };
}

test("query sanitizes entries and keeps only structured fields", async () => {
  const { ledger } = ledgerWith([
    [
      "decisions/one",
      {
        id: "one",
        at: "2026-11-22T10:00:00.000Z",
        kind: "tool",
        prompt: "do not export this prompt",
        rawResponse: { apiKey: "do-not-export" },
        error: "provider failure text",
        model: { id: "jev-1.13-free", providerID: "opencode" },
        durationMs: 120,
        cost: 0,
        answers: [
          {
            type: "predicate",
            name: "answer",
            probability: 0.42,
            confidence: 0.9,
            instructions: "do not export",
          },
        ],
        audit: "permission-denied",
        agent: "plan",
        attempt: 2,
        probability: 0.42,
      },
    ],
  ]);

  const { entries } = await ledger.query({ limit: 10 });
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.id, "one");
  assert.equal(entry.kind, "tool");
  assert.equal(entry.model, "jev-1.13-free");
  assert.equal(entry.providerID, "opencode");
  assert.equal(entry.error, true);
  assert.equal(entry.audit, "permission-denied");
  assert.equal(entry.agent, "plan");
  assert.equal(entry.attempt, 2);
  assert.deepEqual(entry.answers, [{ type: "predicate", name: "answer", probability: 0.42, confidence: 0.9 }]);
  for (const forbidden of ["prompt", "rawResponse", "instructions"]) {
    assert.equal(JSON.stringify(entry).includes(forbidden), false);
  }
});

test("query filters by kind, audit, time range and limit, sorted newest first", async () => {
  const { ledger } = ledgerWith([
    ["decisions/a", { id: "a", at: "2026-11-20T10:00:00.000Z", kind: "prompt" }],
    ["decisions/b", { id: "b", at: "2026-11-21T10:00:00.000Z", kind: "tool", audit: "permission-denied" }],
    ["decisions/c", { id: "c", at: "2026-11-22T10:00:00.000Z", kind: "tool", audit: "permission-denied" }],
  ]);

  const filtered = await ledger.query({
    kind: "tool",
    audit: "permission-denied",
    since: "2026-11-21T00:00:00.000Z",
    limit: 5,
  });
  assert.deepEqual(filtered.entries.map((entry) => entry.id), ["c", "b"]);

  const limited = await ledger.query({ limit: 1 });
  assert.deepEqual(limited.entries.map((entry) => entry.id), ["c"]);
});

test("stats aggregates kinds, models, errors and durations", async () => {
  const { ledger } = ledgerWith([
    ["decisions/a", { id: "a", at: "2026-11-20T10:00:00Z", kind: "tool", model: { id: "m1" }, durationMs: 100 }],
    ["decisions/b", { id: "b", at: "2026-11-22T10:00:00Z", kind: "tool", model: { id: "m1" }, durationMs: 300 }],
    ["decisions/c", { id: "c", at: "2026-11-21T10:00:00Z", kind: "retry", error: "failed", durationMs: 200 }],
  ]);

  const stats = await ledger.stats();
  assert.equal(stats.total, 3);
  assert.deepEqual(stats.byKind, { tool: 2, retry: 1 });
  assert.deepEqual(stats.byModel, { m1: 2 });
  assert.equal(stats.errors, 1);
  assert.equal(stats.successes, 2);
  assert.equal(stats.avgDurationMs, 200);
  assert.equal(stats.lastAt, "2026-11-22T10:00:00Z");
});

test("disabled ledger records nothing and reports empty stats", async () => {
  const storage = makeStorage();
  const ledger = makeLedger({ storage }, false);
  await ledger.record({ kind: "tool" });
  assert.deepEqual(await ledger.recent(), { entries: [] });
  assert.equal((await ledger.stats()).total, 0);
});
