import test from "node:test";
import assert from "node:assert/strict";
import { answer, decide } from "../plugins/opencode-decisions/lib/decide.js";
import { makeCache } from "../plugins/opencode-decisions/lib/cache.js";
import { makeStorage } from "./helpers.js";

const MODEL = { providerID: "opencode", id: "test-decision" };
const QUESTIONS = [{ type: "predicate", name: "answer", instructions: "Probe?" }];
const INPUT = [{ type: "text", text: "probe input" }];

function makeLedgerMock() {
  const entries = [];
  return {
    entries,
    async record(entry) {
      entries.push(entry);
    },
  };
}

test("answer() finds a named decision answer", () => {
  const answers = [
    { type: "predicate", name: "risk", probability: 0.2 },
    { type: "predicate", name: "answer", probability: 0.8 },
  ];
  assert.equal(answer(answers, "answer").probability, 0.8);
  assert.equal(answer(answers, "missing"), undefined);
});

test("decide() uses a cache hit without calling the provider or ledger", async () => {
  const storage = makeStorage();
  const cache = makeCache({ storage }, true, 60000);
  const cached = [{ type: "predicate", name: "answer", probability: 0.77 }];
  await cache.set(MODEL, QUESTIONS, INPUT, cached);
  const ledger = makeLedgerMock();
  let calls = 0;
  const ctx = {
    experimental: {
      generate: {
        decisions: async () => {
          calls += 1;
          throw new Error("should not be called");
        },
      },
    },
  };

  const result = await decide(ctx, {
    questions: QUESTIONS,
    input: INPUT,
    model: MODEL,
    cache,
    ledger,
    meta: { kind: "tool" },
  });

  assert.equal(result.cached, true);
  assert.deepEqual(result.answers, cached);
  assert.equal(calls, 0);
  assert.equal(ledger.entries.length, 0);
});

test("decide() records a successful decision with duration and caches it", async () => {
  const storage = makeStorage();
  const cache = makeCache({ storage }, true, 60000);
  const ledger = makeLedgerMock();
  const answers = [{ type: "predicate", name: "answer", probability: 0.42 }];
  const ctx = {
    experimental: { generate: { decisions: async () => ({ answers, cost: 0 }) } },
  };

  const result = await decide(ctx, {
    questions: QUESTIONS,
    input: INPUT,
    model: MODEL,
    cache,
    ledger,
    meta: { kind: "tool", sessionID: "s1" },
  });

  assert.deepEqual(result.answers, answers);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].kind, "tool");
  assert.equal(ledger.entries[0].sessionID, "s1");
  assert.ok(Number.isFinite(ledger.entries[0].durationMs));
  assert.deepEqual(await cache.get(MODEL, QUESTIONS, INPUT), answers);
});

test("decide() records errors and rethrows", async () => {
  const ledger = makeLedgerMock();
  const ctx = {
    experimental: {
      generate: {
        decisions: async () => {
          throw new Error("decision endpoint failed");
        },
      },
    },
  };

  await assert.rejects(
    decide(ctx, {
      questions: QUESTIONS,
      input: INPUT,
      model: MODEL,
      ledger,
      meta: { kind: "retry" },
    }),
    /decision endpoint failed/,
  );
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].error, "decision endpoint failed");
  assert.equal(ledger.entries[0].kind, "retry");
});
