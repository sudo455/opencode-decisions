// Durable, scoped decision ledger backed by ctx.storage.
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
      if (!enabled) return { entries: [] };
      return ctx.storage.scan({ prefix: "decisions/", limit });
    },
  };
}
