import test from "node:test";
import assert from "node:assert/strict";
import { DecisionsDefinition } from "../plugins/opencode-decisions/lib/rpc-definition.js";

test("RPC contract stays generic and exposes all four methods", () => {
  assert.equal(DecisionsDefinition.id, "decisions");
  assert.deepEqual(DecisionsDefinition.events, {});
  assert.deepEqual(Object.keys(DecisionsDefinition.methods).sort(), ["choose", "ledger", "models", "stats"]);
  assert.equal(JSON.stringify(DecisionsDefinition).toLowerCase().includes("jev"), false);
});

test("choose requires question and choices and limits the choice list", () => {
  const choose = DecisionsDefinition.methods.choose;
  assert.deepEqual(choose.input.required, ["question", "choices"]);
  assert.equal(choose.input.additionalProperties, false);
  assert.equal(choose.input.properties.choices.minItems, 2);
  assert.equal(choose.input.properties.choices.maxItems, 20);
  assert.deepEqual(choose.output.required, ["choice"]);
  for (const name of ["decision_failed", "unsupported_model", "unauthorized"]) {
    assert.ok(choose.errors[name], `missing error ${name}`);
  }
  assert.ok(choose.input.properties.token);
});

test("ledger and stats RPC methods are token-protected and sanitized", () => {
  const ledger = DecisionsDefinition.methods.ledger;
  const stats = DecisionsDefinition.methods.stats;
  assert.ok(ledger.input.properties.token);
  assert.ok(stats.input.properties.token);
  assert.equal(ledger.input.properties.limit.minimum, 1);
  assert.equal(ledger.input.properties.limit.maximum, 200);
  assert.deepEqual(ledger.output.required, ["entries"]);
  assert.ok(stats.output.required.includes("total"));
  assert.ok(stats.output.required.includes("byKind"));
  assert.ok(ledger.errors.ledger_failed);
  assert.ok(stats.errors.ledger_failed);
  assert.ok(ledger.errors.unauthorized);
  assert.ok(stats.errors.unauthorized);
});
