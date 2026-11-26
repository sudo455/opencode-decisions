// Native `subagent` delegation helper. OpenCode still creates and runs the
// child session; the decision model only fills in the optional `agent` field.

import {
  SCOPES,
  contractLedgerFields,
  delegationObjective,
  leastPrivilegeAgent,
  makeDelegationContract,
  sanitizeDelegationText,
  validateDelegationContract,
} from "./delegation.js";

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
      description: sanitizeDelegationText(agent.description || `Agent: ${agent.name || agent.id}`, 300),
    }));
    const objective = delegationObjective(event);
    const scoped = opt.delegationPolicy !== false;
    const questions = [
      {
        type: "choice",
        name: "agent",
        instructions: "Which subagent type is best suited to carry out this delegated task?",
        choices,
      },
    ];
    if (scoped) {
      questions.push({
        type: "choice",
        name: "scope",
        instructions: "What is the narrowest authority scope sufficient for this delegated task?",
        choices: SCOPES.map((value) => ({
          value,
          description: value === "read-only" ? "investigation only; no writes"
            : value === "reversible" ? "bounded local changes with rollback"
              : "consequential; requires human approval",
        })),
      });
    }

    const result = await decide(ctx, {
      input: [{ type: "text", text: objective }],
      questions,
      timeoutMs: opt.timeoutMs,
      ledger,
      cache,
      meta: { kind: "subagent-agent", sessionID: event.sessionID },
    });
    const answers = { agent: first(result.answers, "agent"), scope: first(result.answers, "scope") };
    const modelPick = answers.agent?.choice;
    if (!choices.some((entry) => entry.value === modelPick)) return undefined;

    let picked = modelPick;
    let contractFields = {};
    if (scoped) {
      const contract = makeDelegationContract(event, answers, modelPick, opt);
      const missing = validateDelegationContract(contract);
      if (missing.length) {
        await ledger.record({
          kind: "audit", audit: "delegation-contract-invalid", sessionID: event.sessionID,
          missing: missing.join(","), messageID: event.messageID, tool: event.tool,
        }).catch(() => {});
        return undefined;
      }
      picked = leastPrivilegeAgent(contract, choices, agents);
      if (!picked) {
        await ledger.record({
          kind: "audit", audit: "delegation-requires-human", sessionID: event.sessionID,
          task_id: contract.task_id, scope: contract.scope, risk: contract.risk,
          authority: contract.authority, correlationId: contract.correlationId,
          messageID: event.messageID, tool: event.tool,
        }).catch(() => {});
        return undefined;
      }
      // Fold the contract into the single native ledger entry so the plugin's
      // one-entry-per-delegation contract is preserved.
      contractFields = contractLedgerFields({ ...contract, agent: picked });
    }

    event.input = { ...input, agent: picked };
    await ledger.record({
      ...contractFields,
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
