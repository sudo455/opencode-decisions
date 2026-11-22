// Per-session risk state, shared between the prompt hook and tool hooks.
const key = (sessionID) => `risk/${sessionID}`;

export async function saveRisk(ctx, sessionID, record) {
  await ctx.storage.set(key(sessionID), { at: new Date().toISOString(), ...record });
}

export async function loadRisk(ctx, sessionID) {
  return ctx.storage.get(key(sessionID));
}
