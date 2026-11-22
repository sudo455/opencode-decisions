// Shared decision caller: timeout, answer parsing, and ledger recording.
import { DEFAULT_MODEL } from "./models.js";

export function answer(answers, name) {
  return Array.isArray(answers) ? answers.find((item) => item && item.name === name) : undefined;
}

export async function decide(
  ctx,
  { questions, input, model = DEFAULT_MODEL, timeoutMs = 6000, ledger, meta = {} },
) {
  let timer;
  try {
    const pending = ctx.experimental.generate.decisions({ model, input, questions });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Decision timed out")), timeoutMs);
    });
    const result = await Promise.race([pending, timeout]);
    if (ledger) {
      await ledger.record({
        ...meta,
        model,
        questions: questions.map((q) => ({ type: q.type, name: q.name })),
        answers: result?.answers || [],
        cost: result?.cost,
        tokens: result?.tokens,
      });
    }
    return { answers: result?.answers || [], raw: result };
  } catch (error) {
    if (ledger) {
      await ledger.record({
        ...meta,
        model,
        questions: questions.map((q) => ({ type: q.type, name: q.name })),
        error: error?.message || String(error),
      });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
