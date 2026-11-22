// Short-lived cache for successful decision responses, scoped to plugin storage.
const PREFIX = "cache/decisions/";

function fingerprint(model, questions, input) {
  const payload = JSON.stringify({ model, questions, input });
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < payload.length; i += 1) {
    h1 ^= payload.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= payload.charCodeAt(i);
    h2 = Math.imul(h2, 0x811c9dc5);
  }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}

export function makeCache(ctx, enabled = true, ttlMs = 60000) {
  const keyFor = (model, questions, input) => PREFIX + fingerprint(model, questions, input);

  return {
    async get(model, questions, input) {
      if (!enabled || ttlMs <= 0) return undefined;
      try {
        const entry = await ctx.storage.get(keyFor(model, questions, input));
        if (!entry || typeof entry.at !== "number") return undefined;
        if (Date.now() - entry.at > ttlMs) return undefined;
        return Array.isArray(entry.answers) ? entry.answers : undefined;
      } catch {
        return undefined;
      }
    },

    async set(model, questions, input, answers) {
      if (!enabled || ttlMs <= 0 || !Array.isArray(answers) || answers.length === 0) return;
      try {
        await ctx.storage.set(keyFor(model, questions, input), { at: Date.now(), answers });
      } catch {
        // Cache is best-effort; a storage failure must not fail the decision.
      }
    },
  };
}
