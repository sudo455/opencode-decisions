import test from "node:test";
import assert from "node:assert/strict";
import { loadRisk, saveRisk } from "../plugins/opencode-decisions/lib/risk.js";
import { DEFAULT_MODEL, ENSEMBLE_MODELS, FALLBACK_MODEL } from "../plugins/opencode-decisions/lib/models.js";
import { makeStorage } from "./helpers.js";

test("risk state is stored per session with a timestamp", async () => {
  const storage = makeStorage();
  const ctx = { storage };
  await saveRisk(ctx, "session-a", { probability: 0.72, task: "fix" });
  await saveRisk(ctx, "session-b", { probability: 0.1, task: "docs" });

  const a = await loadRisk(ctx, "session-a");
  const b = await loadRisk(ctx, "session-b");
  assert.equal(a.probability, 0.72);
  assert.equal(a.task, "fix");
  assert.ok(a.at);
  assert.equal(b.probability, 0.1);
  assert.deepEqual([...storage.map.keys()].sort(), ["risk/session-a", "risk/session-b"]);
});

test("model identifiers are centralized and decision-only", () => {
  assert.deepEqual(DEFAULT_MODEL, { providerID: "opencode", id: "jev-1.13-free" });
  assert.deepEqual(ENSEMBLE_MODELS, ["jev-1.13-free", "gpt-6-luna-decision", "gemini-decision-1"]);
  assert.equal(FALLBACK_MODEL, "jev-1.13");
});
