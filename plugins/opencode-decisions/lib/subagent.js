// Native `subagent` delegation helper. OpenCode still creates and runs the
// child session; the decision model only fills in the optional `agent` field.

export async function chooseSubagentAgent(ctx, event, opt, tools) {
  const { decide, ledger, cache, first, onFailure } = tools;
  if (event?.tool !== "subagent") return undefined;
  const input = event.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  if (typeof input.agent === "string" && input.agent.trim()) return undefined;

  try {
    const listed = await ctx.agent.list();
    const agents = (listed?.data || []).filter(
      (agent) => agent && !agent.hidden && ["subagent", "all"].includes(agent.mode),
    );
    if (!agents.length) return undefined;

    const choices = agents.slice(0, opt.subagentMaxChoices).map((agent) => ({
      value: agent.id,
      description: agent.description || `Agent: ${agent.name || agent.id}`,
    }));
    const promptText = typeof input.prompt === "string" ? input.prompt.slice(0, 4000) : "";
    const result = await decide(ctx, {
      input: [{ type: "text", text: promptText }],
      questions: [
        {
          type: "choice",
          name: "agent",
          instructions: "Which subagent type is best suited to carry out this delegated task?",
          choices,
        },
      ],
      timeoutMs: opt.timeoutMs,
      ledger,
      cache,
      meta: { kind: "subagent-agent", sessionID: event.sessionID },
    });
    const picked = first(result.answers, "agent")?.choice;
    if (!choices.some((entry) => entry.value === picked)) return undefined;

    event.input = { ...input, agent: picked };
    await ledger.record({
      kind: "subagent-agent",
      sessionID: event.sessionID,
      agent: picked,
      messageID: event.messageID,
      toolID: event.id,
    });
    return picked;
  } catch (error) {
    onFailure("subagent decision", error);
    await ledger
      .record({
        kind: "audit",
        audit: "subagent-decision-failure",
        sessionID: event.sessionID,
        messageID: event.messageID,
        tool: event.tool,
      })
      .catch(() => {});
    return undefined;
  }
}
