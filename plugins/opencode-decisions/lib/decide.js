// Shared decision caller: cache, timeout, answer parsing, and ledger recording.
import crypto from "node:crypto";
import { DEFAULT_MODEL } from "./models.js";

export function answer(answers, name) {
  return Array.isArray(answers) ? answers.find((item) => item && item.name === name) : undefined;
}

export async function decide(
  ctx,
  {
    questions,
    input,
    model = DEFAULT_MODEL,
    timeoutMs = 6000,
    ledger,
    cache,
    meta = {},
  },
) {
  const started = Date.now();
  const correlationId = crypto.randomUUID();

  if (cache) {
    const hit = await cache.get(model, questions, input);
    if (hit) {
      console.log(`[opencode-decisions] cache hit kind=${meta.kind || "unknown"}`);
      return { answers: hit, raw: undefined, cached: true };
    }
  }

  let timer;
  try {
    const pending = ctx.experimental.generate.decisions({ model, input, questions });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Decision timed out")), timeoutMs);
    });
    const result = await Promise.race([pending, timeout]);
    const answers = result?.answers || [];
    if (cache) await cache.set(model, questions, input, answers);
    if (ledger) {
      await ledger.record({
        ...meta,
        correlationId,
        model,
        questions: questions.map((q) => ({ type: q.type, name: q.name })),
        answers,
        cost: result?.cost,
        tokens: result?.tokens,
        durationMs: Date.now() - started,
      });
    }
    return { answers, raw: result };
  } catch (error) {
    if (ledger) {
      await ledger.record({
        ...meta,
        correlationId,
        model,
        questions: questions.map((q) => ({ type: q.type, name: q.name })),
        error: error?.message || String(error),
        durationMs: Date.now() - started,
      });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
