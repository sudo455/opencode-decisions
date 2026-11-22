// Minimal in-memory stand-in for ctx.storage used by the unit tests.
export function makeStorage() {
  const map = new Map();
  return {
    map,
    async set(key, value) {
      map.set(key, structuredClone(value));
    },
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : undefined;
    },
    async scan({ prefix = "", limit = 1000 } = {}) {
      const entries = [];
      for (const [key, value] of map) {
        if (!key.startsWith(prefix)) continue;
        entries.push({ key, value: structuredClone(value) });
        if (entries.length >= limit) break;
      }
      return { entries };
    },
  };
}
