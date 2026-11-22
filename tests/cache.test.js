import test from "node:test";
import assert from "node:assert/strict";
import { makeCache } from "../plugins/opencode-decisions/lib/cache.js";
import { makeStorage } from "./helpers.js";

const MODEL = { providerID: "opencode", id: "test-decision" };
const QUESTIONS = [{ type: "predicate", name: "answer", instructions: "Probe?" }];
const INPUT = [{ type: "text", text: "same input" }];

test("cache stores and retrieves successful answers for identical input", async () => {
  const storage = makeStorage();
  const cache = makeCache({ storage }, true, 60000);
  const answers = [{ type: "predicate", name: "answer", probability: 0.3 }];

  assert.equal(await cache.get(MODEL, QUESTIONS, INPUT), undefined);
  await cache.set(MODEL, QUESTIONS, INPUT, answers);
  assert.deepEqual(await cache.get(MODEL, QUESTIONS, INPUT), answers);

  const keys = [...storage.map.keys()];
  assert.equal(keys.length, 1);
  assert.ok(keys[0].startsWith("cache/decisions/"));
});

test("cache distinguishes different inputs and expires old entries", async () => {
  const storage = makeStorage();
  const cache = makeCache({ storage }, true, 1000);
  const answers = [{ type: "predicate", name: "answer", probability: 0.3 }];
  await cache.set(MODEL, QUESTIONS, INPUT, answers);

  assert.equal(
    await cache.get(MODEL, QUESTIONS, [{ type: "text", text: "different input" }]),
    undefined,
  );

  const key = [...storage.map.keys()][0];
  storage.map.get(key).at = Date.now() - 5000;
  assert.equal(await cache.get(MODEL, QUESTIONS, INPUT), undefined);
});

test("disabled and zero-TTL caches never write", async () => {
  for (const options of [[false, 60000], [true, 0]]) {
    const storage = makeStorage();
    const cache = makeCache({ storage }, options[0], options[1]);
    await cache.set(MODEL, QUESTIONS, INPUT, [{ type: "predicate", name: "answer", probability: 0.3 }]);
    assert.equal(storage.map.size, 0);
    assert.equal(await cache.get(MODEL, QUESTIONS, INPUT), undefined);
  }
});
