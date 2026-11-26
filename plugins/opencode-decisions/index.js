import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Plugin } from "@opencode/plugin";
import { makeCache } from "./lib/cache.js";
import { answer, decide } from "./lib/decide.js";
import { makeLedger } from "./lib/ledger.js";
import { DEFAULT_MODEL, ENSEMBLE_MODELS, FALLBACK_MODEL } from "./lib/models.js";
import { loadRisk, saveRisk } from "./lib/risk.js";
import { chooseSubagentAgent } from "./lib/subagent.js";
import {
  SPECIALISTS, catalogItems, handoffInstruction, handoffKey, handoffLedgerFields,
  makeHandoffFrame, newHandoffState, popHandoff, pushHandoff,
  resolveAllowlists, roleFitQuestions, selectRoleFit, validateHandoffState,
} from "./lib/handoff.js";
import {
  applyGateFailure, approvalMessage, categoryEffect, gateCategoryForEvent,
  riskProbability, shellGuard, shouldGate, toolReassessment, toolResultAudit,
} from "./lib/workflow.js";
import { Decisions } from "./rpc.js";

const DEFAULT_OPTIONS = {
  enabled: true,
  modelID: DEFAULT_MODEL.id,
  timeoutMs: 6000,
  highRisk: 0.6,
  mediumRisk: 0.3,
  maxChoices: 12,
  toolDecide: true,
  commandDecide: true,
  ledger: true,
  ledgerLimit: 50,
  riskGate: true,
  leastPrivilege: false,
  restrictedTools: ["write", "edit", "patch"],
  sensitiveTools: ["write", "edit", "patch", "bash"],
  clarify: true,
  clarifyThreshold: 0.7,
  ensemble: true,
  ensembleModels: ENSEMBLE_MODELS,
  fallbackModelID: FALLBACK_MODEL,
  rpc: true,
  rpcTimeoutMs: 6000,
  switchTool: true,
  // Routing controls. Legacy `agentAllowlist` is migrated in setup() to the
  // auto/switch lists; explicit new lists always win.
  agentAllowlist: ["plan", "build"],
  autoAgentAllowlist: undefined,
  switchAgentAllowlist: undefined,
  subagentAllowlist: undefined,
  handoffPolicy: true,
  roleFitPolicy: true,
  roleFitMaxDepth: 4,
  agentFallback: true,
  highRiskAgent: "plan",
  lowRiskAgent: "build",
  decisionCache: true,
  decisionCacheMs: 60000,
  contextPolicy: true,
  compactionPolicy: true,
  retryPolicy: true,
  postTaskGate: false,
  postTaskGateMs: 60000,
  retryDecisionMs: 1200,
  retryConfidence: 0.6,
  failureMode: "open",
  subagentDecision: true,
  subagentMaxChoices: 12,
  workflowGates: true,
  gateCategories: ["deploy", "destructive", "credentials", "publish"],
  approvalEffect: "ask",
  shellTimeoutCapMs: 600000,
  shellEnv: {},
  afterToolAudit: true,
  generatePolicy: true,
  // AOEF Stage D additions. Defaults preserve existing behavior except the
  // deterministic floor, which gates only narrow high-impact targets.
  deterministicFloor: true,
  // Authorized AOEF remediation (P0): high-impact workflow categories are
  // denied outright; advisory-only risk tiers still ask for human approval.
  categoryEffect: {
    destructive: "deny",
    credentials: "deny",
    deploy: "deny",
    publish: "deny",
    "risk-floor": "ask",
    risk: "ask",
  },
  gateFailClosed: true,
  riskReassess: false,
  // Decision-driven delegation with least-privilege contracts.
  delegationPolicy: true,
  delegationHighRisk: 0.9,
  delegationLowRisk: 0.2,
};

const TASK_TYPES = ["fix", "feature", "refactor", "review", "docs", "research", "other"];

const TASK_GUIDANCE = {
  fix: "Reproduce first, find root cause, apply one minimal fix, then verify it.",
  feature: "Clarify acceptance criteria, implement in small steps, verify each step.",
  refactor: "Preserve behavior, keep changes mechanical, verify with existing tests.",
  review: "Read before judging, cite concrete evidence, separate real bugs from cosmetic issues.",
  docs: "Verify against the codebase; inline source material when the doc must stand alone.",
  research: "Research before acting, cite sources, write findings back to memory.",
  other: "State assumptions, verify them, then proceed with the smallest safe change.",
};

const VERIFY_GUIDANCE = {
  quick: "Quick verification is sufficient: lint or a single targeted check.",
  standard: "Standard verification: lint + relevant tests + a live probe where applicable.",
  thorough: "Thorough verification: multiple independent passes, including deploy/runtime state and rollback path.",
};

function policyText(record) {
  const verification = VERIFY_GUIDANCE[record?.verification] || VERIFY_GUIDANCE.quick;
  const lines = [
    '<opencode-decisions-policy>',
    `Task: ${record?.task || "other"}; risk: ${typeof record?.probability === "number" ? record.probability.toFixed(2) : "unknown"}`,
    `Verification: ${verification}`,
  ];
  if (record?.needsReview) lines.push("Multiple decision models disagreed: obtain human review before high-impact actions.");
  lines.push('</opencode-decisions-policy>');
  return lines.join("\n");
}

function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const role = message?.info?.role || message?.role || message?.type;
    if (role !== "assistant") continue;
    const parts = message.parts || message.content || message?.info?.parts || [];
    const text = (Array.isArray(parts) ? parts : [])
      .map((part) => part?.text || part?.content?.text || "")
      .filter(Boolean)
      .join("\n");
    if (text) return text.slice(0, 2500);
  }
  return "";
}

function first(answers, name) {
  return answer(answers, name);
}

function label(list, id) {
  const item = list.find((entry) => entry.id === id || entry.name === id);
  return item?.name || item?.id || id;
}

const RPC_TOKENS_FILE = path.join(os.homedir(), ".config", "opencode", "decisions-rpc-tokens.json");

function loadRpcTokens() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RPC_TOKENS_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === "string" && value.length > 0),
    );
  } catch {
    return {};
  }
}

function tokenMatches(tokens, presented) {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const presentedBytes = Buffer.from(presented, "utf8");
  return Object.values(tokens).some((expected) => {
    const expectedBytes = Buffer.from(expected, "utf8");
    return (
      expectedBytes.length === presentedBytes.length &&
      crypto.timingSafeEqual(expectedBytes, presentedBytes)
    );
  });
}

function withDeadline(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("cancelled"));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("decision timed out"));
    }, timeoutMs);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function toolQuestion(input) {
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (!question) return undefined;
  const type = input.type || "predicate";
  if (type === "choice") {
    const choices = Array.isArray(input.choices) && input.choices.length ? input.choices : ["yes", "no"];
    return {
      type: "choice",
      name: "answer",
      instructions: question,
      choices: choices.map((value) => ({ value, description: value })),
    };
  }
  if (type === "score") {
    const levels = Array.isArray(input.levels) && input.levels.length ? input.levels : ["low", "medium", "high"];
    return {
      type: "score",
      name: "answer",
      instructions: question,
      levels: levels.map((labelText) => ({ label: labelText })),
    };
  }
  return { type: "predicate", name: "answer", instructions: question };
}

async function ensemble(ctx, opt, input, questions, ledger, cache, sessionID) {
  const settled = await Promise.allSettled(
    opt.ensembleModels.map((id) =>
      decide(ctx, {
        model: { providerID: "opencode", id },
        input,
        questions,
        timeoutMs: opt.timeoutMs,
        ledger,
        cache,
        meta: { kind: "ensemble", sessionID, modelID: id },
      }),
    ),
  );

  const views = settled.map((result, index) => ({
    modelID: opt.ensembleModels[index],
    answers: result.status === "fulfilled" ? result.value.answers : [],
    error: result.status === "rejected" ? String(result.reason?.message || result.reason) : undefined,
  }));

  const risks = views
    .map((view) => first(view.answers, "risk")?.probability)
    .filter((value) => typeof value === "number");
  const tasks = views.map((view) => first(view.answers, "task_type")?.choice).filter(Boolean);

  const riskSpread = risks.length > 1 ? Math.max(...risks) - Math.min(...risks) : 0;
  const boundarySplit =
    risks.some((value) => value >= opt.highRisk) && risks.some((value) => value < opt.highRisk);
  const disagree = riskSpread > 0.2 || boundarySplit || new Set(tasks).size > 1;

  return {
    disagree,
    summary: views.map((view) => ({
      modelID: view.modelID,
      risk: first(view.answers, "risk")?.probability,
      task: first(view.answers, "task_type")?.choice,
      error: view.error,
    })),
  };
}

export default Plugin.define({
  id: "opencode-decisions",
  async setup(ctx) {
    const opt = { ...DEFAULT_OPTIONS, ...(ctx.options || {}) };
    if (opt.enabled === false) return;

    const routing = resolveAllowlists(opt);
    if (routing.migration.length) {
      console.warn(`[opencode-decisions] migrating agent routing: ${routing.migration.join(", ")}`);
    }

    const ledger = makeLedger(ctx, opt.ledger);
    const cache = makeCache(ctx, opt.decisionCache, opt.decisionCacheMs);
    const cleanups = [];

    const onFailure = (scope, error) => {
      const message = error?.message || String(error);
      console.warn(`[opencode-decisions] ${scope} failed ${opt.failureMode}:`, message);
      if (opt.failureMode === "closed") {
        return `<opencode-decisions-failure scope="${scope}">Decision subsystem unavailable (${scope}); exercise heightened caution.</opencode-decisions-failure>`;
      }
      return "";
    };

    if (opt.rpc !== false) {
      const rpcTokens = loadRpcTokens();
      const decisionModels = async () => {
        const listed = await ctx.model.list({ types: ["decision"] });
        return (listed?.data || []).map((model) => ({
          providerID: model.providerID,
          id: model.id,
          name: model.name || model.id,
        }));
      };

      await ctx.rpc.register(Decisions, {
        choose: async (input, context) => {
          if (!tokenMatches(rpcTokens, input.token)) {
            return context.error("unauthorized", "Invalid RPC token", {
              reason: "missing_or_invalid_token",
            });
          }
          if (context.signal?.aborted) {
            return context.error("decision_failed", "Request cancelled", { reason: "cancelled" });
          }

          const providerID =
            typeof input.providerID === "string" && input.providerID
              ? input.providerID
              : DEFAULT_MODEL.providerID;
          const id = typeof input.model === "string" && input.model ? input.model : opt.modelID;

          if (id !== opt.modelID || providerID !== DEFAULT_MODEL.providerID) {
            try {
              const available = await decisionModels();
              if (
                available.length &&
                !available.some((model) => model.id === id && model.providerID === providerID)
              ) {
                return context.error("unsupported_model", "Not a decision model", {
                  model: `${providerID}/${id}`,
                });
              }
            } catch {
              // Catalog unavailable: let the endpoint decide.
            }
          }

          if (
            typeof input.question !== "string" ||
            !input.question.trim() ||
            !Array.isArray(input.choices) ||
            input.choices.length < 2 ||
            input.choices.length > 20
          ) {
            return context.error("decision_failed", "Invalid request", { reason: "invalid_input" });
          }

          try {
            const result = await withDeadline(
              ctx.experimental.generate.decisions({
                model: { providerID, id },
                input: [{ type: "text", text: typeof input.state === "string" ? input.state : "" }],
                questions: [
                  {
                    type: "choice",
                    name: "tool",
                    instructions: input.question,
                    choices: input.choices.map((value) => ({ value, description: value })),
                  },
                ],
              }),
              opt.rpcTimeoutMs,
              context.signal,
            );
            const picked = answer(result?.answers, "tool");
            if (typeof picked?.choice !== "string" || !input.choices.includes(picked.choice)) {
              return context.error("decision_failed", "Decision returned an invalid choice", {
                reason: "invalid_choice",
              });
            }
            return {
              choice: picked.choice,
              model: id,
              confidence: typeof picked.confidence === "number" ? picked.confidence : 0,
              probabilities: Array.isArray(picked.probabilities) ? picked.probabilities : [],
            };
          } catch (error) {
            return context.error("decision_failed", "Decision call failed", {
              reason: error?.message || String(error),
            });
          }
        },
        models: async (input, context) => {
          if (!tokenMatches(rpcTokens, input.token)) {
            return context.error("unauthorized", "Invalid RPC token", {
              reason: "missing_or_invalid_token",
            });
          }
          try {
            return { models: await decisionModels() };
          } catch (error) {
            return context.error("decision_failed", "Model catalog unavailable", {
              reason: error?.message || String(error),
            });
          }
        },
        ledger: async (input, context) => {
          if (!tokenMatches(rpcTokens, input.token)) {
            return context.error("unauthorized", "Invalid RPC token", {
              reason: "missing_or_invalid_token",
            });
          }
          try {
            return await ledger.query({
              kind: input.kind,
              audit: input.audit,
              limit: input.limit,
              since: input.since,
              until: input.until,
            });
          } catch (error) {
            return context.error("ledger_failed", "Ledger unavailable", {
              reason: error?.message || String(error),
            });
          }
        },
        stats: async (input, context) => {
          if (!tokenMatches(rpcTokens, input.token)) {
            return context.error("unauthorized", "Invalid RPC token", {
              reason: "missing_or_invalid_token",
            });
          }
          try {
            return await ledger.stats();
          } catch (error) {
            return context.error("ledger_failed", "Ledger stats unavailable", {
              reason: error?.message || String(error),
            });
          }
        },
      });
    }

    let agents = [];
    let catalogAgents = [];
    let skills = [];
    try {
      const catalog = catalogItems(await ctx.agent.list()).filter((agent) => agent && !agent.hidden);
      catalogAgents = catalog;
      agents = catalog.filter(
        (agent) =>
          (agent.mode === "all" || agent.mode === "primary") &&
          routing.auto.includes(agent.id),
      );
    } catch (error) {
      console.warn("[opencode-decisions] agent list unavailable:", error?.message || error);
    }
    try {
      skills = catalogItems(await ctx.skill.list()).filter((skill) => skill && skill.id);
    } catch (error) {
      console.warn("[opencode-decisions] skill list unavailable:", error?.message || error);
    }

    const agentChoices = [
      { value: "keep", description: "Keep the current agent" },
      ...agents.map((agent) => ({
        value: agent.id,
        description: agent.description || `Agent: ${agent.name || agent.id}`,
      })),
    ];
    const specialistTargets = SPECIALISTS.filter(
      (id) =>
        routing.switch.includes(id) &&
        catalogAgents.some((agent) => agent.id === id && agent.mode === "all"),
    );

    // Authoritative per-agent lookup: use ctx.agent.get rather than trusting a
    // setup-time list snapshot, which can be stale after agent discovery.
    const agentAvailable = async (id, requireAll = false) => {
      if (typeof id !== "string" || !id) return false;
      try {
        const response = await ctx.agent.get({ agentID: id });
        const agent = response && typeof response === "object" && !Array.isArray(response) && response.data
          ? response.data
          : response;
        if (agent && !agent.hidden && (!requireAll || agent.mode === "all")) return true;
      } catch {
        // Fall through to the live list, then the setup snapshot.
      }
      let live = catalogAgents;
      try {
        live = catalogItems(await ctx.agent.list());
      } catch (error) {
        console.warn("[opencode-decisions] live agent catalog lookup failed:", error?.message || error);
      }
      return live.some((agent) => agent.id === id && !agent.hidden && (!requireAll || agent.mode === "all"));
    };

    const skillChoices = [
      { value: "none", description: "No skill" },
      ...skills.slice(0, opt.maxChoices).map((skill) => ({
        value: skill.id,
        description: skill.description || `Skill: ${skill.name || skill.id}`,
      })),
    ];

    await ctx.session.hook("prompt", async (event) => {
      const prompt = event.prompt || {};
      const described = [
        typeof prompt.text === "string" ? prompt.text.slice(0, 4000) : "",
        Array.isArray(prompt.files) && prompt.files.length
          ? `Attachments: ${prompt.files.map((file) => file.name || file.uri).join(", ")}`
          : "",
        Array.isArray(prompt.agents) && prompt.agents.length
          ? `Agent mentions: ${prompt.agents.map((agent) => agent.name).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      const questions = [
        {
          type: "choice",
          name: "task_type",
          instructions: "What kind of work is this prompt asking for?",
          choices: TASK_TYPES.map((value) => ({ value, description: value })),
        },
        {
          type: "predicate",
          name: "risk",
          instructions:
            "Does this involve deployment, production configuration, credentials, data migration, or destructive operations?",
          criteria: {
            true: "High-impact or irreversible work",
            false: "Local, reversible work",
          },
        },
        {
          type: "choice",
          name: "agent",
          instructions:
            "Which agent is best suited to carry out this request? Choose 'plan' when the request needs design decisions, a multi-step approach, or high-risk/irreversible changes that should be planned before editing. Choose 'build' for straightforward implementation, fixes, and small edits.",
          choices: agentChoices,
        },
        {
          type: "choice",
          name: "skill",
          instructions: "Which available skill, if any, fits this request?",
          choices: skillChoices,
        },
      ];
      if (opt.clarify) {
        questions.push({
          type: "predicate",
          name: "ambiguous",
          instructions: "Is the request missing essential details needed to act safely?",
          criteria: {
            true: "Key details are missing",
            false: "The request is clear enough",
          },
        });
      }
      if (opt.roleFitPolicy && specialistTargets.length && event.agent) {
        questions.push(...roleFitQuestions(specialistTargets));
      }

      try {
        const result = await decide(ctx, {
          model: { providerID: "opencode", id: opt.modelID },
          input: [{ type: "text", text: described }],
          questions,
          timeoutMs: opt.timeoutMs,
          ledger,
          cache,
          meta: { kind: "prompt", sessionID: event.sessionID },
        });

        const answers = result.answers;
        const taskAnswer = first(answers, "task_type");
        const riskAnswer = first(answers, "risk");
        const agentAnswer = first(answers, "agent");
        const skillAnswer = first(answers, "skill");
        const ambiguousAnswer = first(answers, "ambiguous");

        const task = TASK_TYPES.includes(taskAnswer?.choice) ? taskAnswer.choice : "other";
        const probability = riskProbability(riskAnswer);
        const verification =
          probability >= opt.highRisk
            ? "thorough"
            : probability >= opt.mediumRisk
              ? "standard"
              : "quick";

        let chosenAgent =
          typeof agentAnswer?.choice === "string" && agentAnswer.choice !== "keep"
            ? agentAnswer.choice
            : undefined;
        let agentSource = "decision model";
        if (
          (!chosenAgent || !agents.some((agent) => agent.id === chosenAgent)) &&
          opt.agentFallback
        ) {
          chosenAgent = probability >= opt.highRisk ? opt.highRiskAgent : opt.lowRiskAgent;
          if (agents.some((agent) => agent.id === chosenAgent)) {
            agentSource = "risk fallback";
          } else {
            chosenAgent = undefined;
          }
        }
        const chosenSkill =
          typeof skillAnswer?.choice === "string" && skillAnswer.choice !== "none"
            ? skillAnswer.choice
            : undefined;

        let ensembleResult;
        if (opt.ensemble && probability >= opt.highRisk) {
          ensembleResult = await ensemble(
            ctx,
            opt,
            [{ type: "text", text: described }],
            questions,
            ledger,
            cache,
            event.sessionID,
          );
        }

        await saveRisk(ctx, event.sessionID, {
          probability,
          task,
          verification,
          needsReview: Boolean(ensembleResult?.disagree),
        });

        let handoffNotice = "";
        if (opt.handoffPolicy && specialistTargets.length && event.sessionID) {
          const fit = selectRoleFit(answers, specialistTargets);
          const from = typeof event.agent === "string" && event.agent ? event.agent : undefined;
          if (fit.target && from && fit.target !== from) {
            try {
              const key = handoffKey(event.sessionID);
              const existing = await ctx.storage.get(key);
              const originalText = typeof prompt.text === "string" ? prompt.text.slice(0, 1000) : "";
              const frame = makeHandoffFrame({
                from,
                to: fit.target,
                responsibility: `${task} specialist takeover`,
                objective: originalText,
                task,
                phase: "role-fit takeover",
                constraints: "Respect AOEF Authority Matrix and all user constraints already established in this session.",
                authorization: "No authority expansion; no approval bypass; no consequential operation authorized by this handoff.",
                facts: [`risk=${probability.toFixed(2)}`, `verification=${verification}`],
                evidence: ["opencode-decisions prompt classification"],
                decisions: [],
                files: [],
                completed: [],
              });
              const pushed = pushHandoff(existing, frame, opt.roleFitMaxDepth);
              if (pushed.error) {
                handoffNotice = `Specialist handoff suppressed: ${pushed.error}`;
              } else {
                await ctx.storage.set(key, pushed.state);
                await ctx.session.switchAgent({ sessionID: event.sessionID, agent: fit.target });
                await ctx.session.instructions.entry.put({
                  sessionID: event.sessionID,
                  key: "opencode-decisions-handoff",
                  value: handoffInstruction(pushed.state, pushed.frame),
                });
                await ledger.record({
                  kind: "audit",
                  audit: "handoff-open",
                  sessionID: event.sessionID,
                  ...handoffLedgerFields(pushed.frame),
                });
                handoffNotice = `Specialist ${fit.target} took over this session (role fit ${fit.confidence.toFixed(2)}). Return with decisions.return_to_owner.`;
              }
            } catch (error) {
              const notice = onFailure("handoff", error);
              if (notice) handoffNotice = notice;
            }
          }
        }

        const lines = [
          `<opencode-decisions task="${task}" risk="${probability.toFixed(2)}" verification="${verification}">`,
          `Task guidance: ${TASK_GUIDANCE[task]}`,
          `Verification: ${VERIFY_GUIDANCE[verification]}`,
        ];

        if (chosenAgent && agents.some((agent) => agent.id === chosenAgent)) {
          if (!Array.isArray(prompt.agents) || prompt.agents.length === 0) {
            await ctx.session.switchAgent({ sessionID: event.sessionID, agent: chosenAgent });
            lines.push(`Agent selected by ${agentSource}: ${label(agents, chosenAgent)}`);
          } else {
            lines.push(`Agent mention preserved; decision model suggested: ${label(agents, chosenAgent)}`);
          }
        }

        if (chosenSkill && skills.some((skill) => skill.id === chosenSkill)) {
          prompt.skills = Array.isArray(prompt.skills) ? prompt.skills.slice() : [];
          if (!prompt.skills.some((skill) => skill.id === chosenSkill)) {
            prompt.skills.push({ id: chosenSkill });
            lines.push(`Skill selected by decision model: ${label(skills, chosenSkill)}`);
          }
        }

        if (opt.clarify && typeof ambiguousAnswer?.probability === "number" && ambiguousAnswer.probability >= opt.clarifyThreshold) {
          const text = typeof prompt.text === "string" ? prompt.text : "";
          prompt.text = `${text}\n\n[Decision clarification] State the assumptions you are making and ask the user to confirm the key ambiguity before proceeding.`;
          lines.push(`Clarification requested by decision model (${ambiguousAnswer.probability.toFixed(2)})`);
        }

        if (ensembleResult) {
          lines.push(
            ensembleResult.disagree
              ? "Decision models disagree: obtain human review before high-risk actions."
              : "High-risk decision confirmed by multiple decision models.",
          );
        }
        if (handoffNotice) lines.push(handoffNotice);

        lines.push("</opencode-decisions>");
        await ctx.session.instructions.entry.put({
          sessionID: event.sessionID,
          key: "opencode-decisions",
          value: lines.join("\n"),
        });
        console.log(
          `[opencode-decisions] task=${task} risk=${probability.toFixed(2)} verification=${verification}` +
            (ensembleResult ? ` ensemble=${ensembleResult.disagree ? "disagree" : "agree"}` : ""),
        );
      } catch (error) {
        const notice = onFailure("prompt policy", error);
        if (notice) {
          try {
            await ctx.session.instructions.entry.put({
              sessionID: event.sessionID,
              key: "opencode-decisions-failure",
              value: notice,
            });
          } catch {
            // Instruction injection is best-effort; the prompt itself still proceeds.
          }
        }
      }
    });

    if (opt.contextPolicy) {
      await ctx.session.hook("context", async (event) => {
        try {
          const record = await loadRisk(ctx, event.sessionID);
          if (!record) return;
          event.system.push({ type: "text", text: policyText(record) });
          if (opt.handoffPolicy && event.sessionID) {
            const state = await ctx.storage.get(handoffKey(event.sessionID));
            const frame = Array.isArray(state?.stack) && state.stack.length
              ? state.stack[state.stack.length - 1]
              : null;
            if (frame) {
              event.system.push({ type: "text", text: handoffInstruction(state, frame) });
            }
          }
        } catch (error) {
          const notice = onFailure("context policy", error);
          if (notice) event.system.push({ type: "text", text: notice });
        }
      });
    }

    if (opt.compactionPolicy) {
      await ctx.session.hook("compaction", async (event) => {
        try {
          const record = await loadRisk(ctx, event.sessionID);
          event.system.push({
            type: "text",
            text: record
              ? `Preserve this decision policy in the summary. ${policyText(record)}`
              : "No decision policy was recorded for this session.",
          });
          if (opt.handoffPolicy && event.sessionID) {
            const state = await ctx.storage.get(handoffKey(event.sessionID));
            const frame = Array.isArray(state?.stack) && state.stack.length
              ? state.stack[state.stack.length - 1]
              : null;
            if (frame) {
              event.system.push({
                type: "text",
                text: `Preserve this active handoff state. ${handoffInstruction(state, frame)}`,
              });
            }
          }
          await ledger.record({
            kind: "audit",
            audit: record ? "compaction-with-policy" : "compaction-without-policy",
            sessionID: event.sessionID,
          });
        } catch (error) {
          const notice = onFailure("compaction policy", error);
          if (notice) event.system.push({ type: "text", text: notice });
        }
      });
    }

    if (opt.retryPolicy) {
      await ctx.session.hook("retry", async (event) => {
        const current = event.decision;
        try {
          const status = event.error?.status ?? "n/a";
          const type = event.error?.type ?? "n/a";
          const state = [
            `Provider failure: type=${type} status=${status} attempt=${event.attempt}.`,
            `Model: ${event.model?.providerID || "?"}/${event.model?.id || "?"}.`,
            `OpenCode currently proposes ${current?.retry ? "retry" : "no retry"}.`,
          ].join(" ");
          const result = await decide(ctx, {
            input: [{ type: "text", text: state }],
            questions: [
              {
                type: "predicate",
                name: "retry",
                instructions: "Should this failed model request be retried?",
                criteria: {
                  true: "Transient failure where a retry is likely to succeed",
                  false: "Permanent failure or retry would not help",
                },
              },
            ],
            timeoutMs: Math.min(opt.retryDecisionMs, opt.timeoutMs),
            ledger,
            meta: { kind: "retry", sessionID: event.sessionID, attempt: event.attempt },
          });
          const probability = first(result.answers, "retry")?.probability;
          if (typeof probability !== "number") return;
          if (probability >= opt.retryConfidence) {
            const delay = Number.isFinite(current?.delay) && current.delay >= 0 ? current.delay : 1000;
            event.decision = { retry: true, delay };
          } else if (probability <= 1 - opt.retryConfidence) {
            event.decision = { retry: false };
          }
        } catch (error) {
          onFailure("retry policy", error);
          await ledger
            .record({
              kind: "audit",
              audit: "retry-policy-failure",
              sessionID: event.sessionID,
              attempt: event.attempt,
            })
            .catch(() => {});
        }
      });
    }

    if (opt.postTaskGate) {
      const gateController = new AbortController();
      cleanups.push(() => gateController.abort());
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({
            types: ["session.idle"],
            signal: gateController.signal,
          })) {
            const sessionID = event?.data?.sessionID;
            if (!sessionID) continue;
            try {
              const gateKey = `gate/${sessionID}`;
              const previous = await ctx.storage.get(gateKey);
              const now = Date.now();
              if (typeof previous === "number" && now - previous < opt.postTaskGateMs) continue;
              const record = await loadRisk(ctx, sessionID);
              if (!record || record.probability < opt.highRisk) continue;
              const messages = await ctx.session.context({ sessionID });
              const state = lastAssistantText(messages) || "No assistant summary was available.";
              await ctx.storage.set(gateKey, now);
              const result = await decide(ctx, {
                input: [{ type: "text", text: state }],
                questions: [
                  {
                    type: "predicate",
                    name: "review",
                    instructions: "Does this completed high-risk work need human review before being considered done?",
                    criteria: {
                      true: "Irreversible or unverified high-impact change",
                      false: "Change is verified and safe to close out",
                    },
                  },
                ],
                timeoutMs: opt.timeoutMs,
                ledger,
                meta: { kind: "post-task-gate", sessionID },
              });
              const probability = first(result.answers, "review")?.probability;
              if (typeof probability === "number" && probability >= opt.highRisk) {
                await ctx.session.synthetic({
                  sessionID,
                  text: "[opencode-decisions] Post-task review requested before considering this high-risk work complete.",
                });
                await ledger.record({ kind: "post-task-gate", sessionID, probability });
              }
            } catch (error) {
              onFailure("post-task gate", error);
            }
          }
        } catch (error) {
          onFailure("post-task gate subscription", error);
        }
      })();
    }

    if (opt.leastPrivilege) {
      await ctx.session.hook("context", async (event) => {
        try {
          const record = await loadRisk(ctx, event.sessionID);
          if (!record || record.probability >= opt.mediumRisk) return;
          if (!["research", "review", "docs"].includes(record.task)) return;
          for (const tool of opt.restrictedTools) delete event.tools[tool];
        } catch (error) {
          console.warn("[opencode-decisions] least-privilege failed open:", error?.message || error);
        }
      });
    }

    if (opt.riskGate || opt.workflowGates) {
      await ctx.permission.hook("evaluate", async (event) => {
        if (event.effect === "deny") return;
        try {
          const sourceID =
            event.source?.id || (event.messageID && event.id ? `${event.messageID}:${event.id}` : null);
          const gateKey = event.sessionID && sourceID ? `gate/${event.sessionID}/${sourceID}` : null;
          if (gateKey) {
            try {
              if (await ctx.storage.get(gateKey)) return;
            } catch {
              // Storage failures must not silently allow a gated operation.
            }
          }
          const record = event.sessionID ? await loadRisk(ctx, event.sessionID) : null;
          const category = gateCategoryForEvent(event, opt.gateCategories);
          const reason = shouldGate(event, opt, record, category);
          if (!reason) return;
          event.effect = categoryEffect(reason, opt);
          event.message = approvalMessage({
            category: reason,
            record,
            action: event.action,
            opt,
          });
          await ledger.record({
            kind: "audit",
            audit: "approval-gate",
            category: reason,
            sessionID: event.sessionID,
            agent: event.agent,
            action: event.action,
            resources: Array.isArray(event.resources) ? event.resources : [],
            source: event.source,
            effect: event.effect,
            probability: record?.probability,
          });
          if (gateKey) {
            try {
              await ctx.storage.set(gateKey, {
                at: new Date().toISOString(),
                effect: event.effect,
                category: reason,
              });
            } catch {
              // Marker failure is advisory; the gate decision itself already stands.
            }
          }
        } catch (error) {
          await applyGateFailure(event, ledger, opt);
          onFailure("workflow approval gate", error);
        }
      });
    }

    if (opt.workflowGates) {
      await ctx.shell.hook("create.before", async (event) => {
        try {
          const guard = shellGuard(event.command, opt);
          if (!guard) return;
          event.env = { ...(event.env || {}), ...guard.env };
          if (guard.timeout && Number.isFinite(event.timeout) && event.timeout > guard.timeout) {
            event.timeout = guard.timeout;
          }
          await ledger.record({
            kind: "audit",
            audit: "shell-gate",
            category: guard.category,
            cwd: event.cwd,
          });
        } catch (error) {
          onFailure("shell gate", error);
        }
      });
    }

    if (opt.afterToolAudit) {
      await ctx.tool.hook("execute.after", async (event) => {
        try {
          await ledger.record(toolResultAudit(event));
          if (opt.riskReassess && event.sessionID) {
            const record = await loadRisk(ctx, event.sessionID);
            if (record) {
              const spec = toolReassessment(event)[0];
              const result = await decide(ctx, {
                questions: spec.questions,
                input: spec.input,
                ledger,
                cache,
                meta: { kind: "risk-reassessment", sessionID: event.sessionID },
              });
              const next = riskProbability(answer(result.answers, "reassess"));
              if (next > record.probability) {
                await saveRisk(ctx, event.sessionID, { ...record, probability: next });
                await ledger.record({
                  kind: "audit",
                  audit: "risk-escalated",
                  sessionID: event.sessionID,
                  probability: next,
                  previous: record.probability,
                });
              }
            }
          }
        } catch (error) {
          onFailure("tool result audit", error);
        }
      });
    }

    if (opt.generatePolicy) {
      await ctx.session.hook("generate", async (event) => {
        try {
          if (!Array.isArray(event.system)) return;
          const record = event.sessionID ? await loadRisk(ctx, event.sessionID) : null;
          if (record) event.system.push({ type: "text", text: policyText(record) });
        } catch (error) {
          onFailure("generate policy", error);
        }
      });
    }

    if (opt.subagentDecision) {
      await ctx.tool.hook("execute.before", async (event) => {
        await chooseSubagentAgent(
          ctx,
          event,
          { ...opt, agentAllowlist: routing.subagent },
          { decide, ledger, cache, first, onFailure },
        );
      });
    }

    if (opt.toolDecide) {
      await ctx.tool.transform((editor) => {
        editor.namespace({
          name: "decisions",
          description: "Structured decisions from OpenCode decision models",
        });
        editor.add({
          name: "decide",
          description:
            "Ask a typed decision question. type=predicate|choice|score; supply choices or levels for the latter two.",
          input: {
            type: "object",
            properties: {
              question: { type: "string", description: "The decision question" },
              type: { type: "string", enum: ["predicate", "choice", "score"], default: "predicate" },
              choices: { type: "array", items: { type: "string" } },
              levels: { type: "array", items: { type: "string" } },
              state: { type: "string", description: "Optional context for the decision model" },
            },
            required: ["question"],
            additionalProperties: false,
          },
          options: { namespace: "decisions", codemode: true },
          execute: async (input, context) => {
            const question = toolQuestion(input || {});
            if (!question) return { content: "A non-empty question is required." };
            try {
              const result = await decide(ctx, {
                questions: [question],
                input: [{ type: "text", text: input.state || question.instructions }],
                timeoutMs: opt.timeoutMs,
                ledger,
                cache,
                meta: { kind: "tool", sessionID: context.sessionID },
              });
              return { content: JSON.stringify(result.answers[0] || { type: "error", reason: "no answer" }) };
            } catch (error) {
              return { content: `Decision unavailable: ${error?.message || error}` };
            }
          },
        });

        if (opt.switchTool) {
          editor.add({
            name: "switch_agent",
            description:
              "Switch this session to an allowed agent from the live catalog (plan/build primaries and configured specialists). Takes effect from the next step/request.",
            input: {
              type: "object",
              properties: {
                agent: { type: "string", description: "Target agent id from the live agent catalog" },
                reason: { type: "string", description: "Why the switch is needed" },
              },
              required: ["agent"],
              additionalProperties: false,
            },
            options: { namespace: "decisions", codemode: true },
            execute: async (input, context) => {
              const target = typeof input?.agent === "string" ? input.agent.trim() : "";
              if (!target) return { content: "A target agent id is required." };
              try {
                const listed = await ctx.agent.list();
                let allowed = (listed?.data || []).filter(
                  (agent) =>
                    agent &&
                    (agent.mode === "all" || agent.mode === "primary") &&
                    !agent.hidden &&
                    agent.id === target,
                );
                allowed = allowed.filter((agent) => routing.switch.includes(agent.id));
                if (!allowed.length) {
                  return { content: `Agent '${target}' is not an available switch target.` };
                }
                if (context.agent === target) {
                  return { content: `Already using agent '${target}'.` };
                }
                await ctx.session.switchAgent({ sessionID: context.sessionID, agent: target });
                const reason = typeof input.reason === "string" ? input.reason.slice(0, 500) : "";
                await ctx.session.instructions.entry.put({
                  sessionID: context.sessionID,
                  key: "opencode-decisions-switch",
                  value: [
                    `<opencode-decisions-switch>`,
                    `Agent switched from ${context.agent} to ${target}.`,
                    reason ? `Reason: ${reason}` : "",
                    `</opencode-decisions-switch>`,
                  ]
                    .filter(Boolean)
                    .join("\n"),
                });
                await ledger.record({
                  kind: "agent-switch",
                  from: context.agent,
                  agent: target,
                  reason,
                  sessionID: context.sessionID,
                });
                await ledger.record({
                  kind: "audit",
                  audit: "agent-switch",
                  from: context.agent,
                  agent: target,
                  sessionID: context.sessionID,
                });
                return {
                  content: `Switched to agent '${target}'. The switch applies from the next step/request.`,
                };
              } catch (error) {
                return { content: `Agent switch unavailable: ${error?.message || error}` };
              }
            },
          });
        }

        if (opt.handoffPolicy) {
          editor.add({
            name: "handoff",
            description:
              "Explicitly hand the current session to a specialist, preserving a structured context record. Targets must be allowed specialists available in the live catalog.",
            input: {
              type: "object",
              properties: {
                agent: { type: "string", description: "Specialist agent id" },
                responsibility: { type: "string", description: "Exact responsibility assigned to the specialist" },
                task_id: { type: "string", description: "Optional existing task id" },
                objective: { type: "string", description: "Optional original objective" },
                reason: { type: "string", description: "Why this specialist is needed" },
              },
              required: ["agent", "responsibility"],
              additionalProperties: false,
            },
            options: { namespace: "decisions", codemode: true },
            execute: async (input, context) => {
              const target = typeof input?.agent === "string" ? input.agent.trim() : "";
              // Validate against the live catalog at call time: setup-time
              // snapshots can be stale after config or agent discovery changes.
              const isTarget =
                SPECIALISTS.includes(target) &&
                routing.switch.includes(target) &&
                (await agentAvailable(target, true));
              if (!isTarget) return { content: `Agent '${target}' is not an available specialist handoff target.` };
              if (context.agent === target) return { content: `Already using agent '${target}'.` };
              try {
                const key = handoffKey(context.sessionID);
                const existing = await ctx.storage.get(key);
                const frame = makeHandoffFrame({
                  from: context.agent,
                  to: target,
                  responsibility: input.responsibility,
                  taskID: input.task_id,
                  objective: input.objective,
                  task: "handoff",
                  phase: "explicit handoff",
                  constraints: "Respect AOEF Authority Matrix and all user constraints already established in this session.",
                  authorization: "No authority expansion; no approval bypass; no consequential operation authorized by this handoff.",
                  facts: [],
                  evidence: [],
                  decisions: [],
                  files: [],
                  completed: [],
                });
                const pushed = pushHandoff(existing, frame, opt.roleFitMaxDepth);
                if (pushed.error) return { content: `Handoff refused: ${pushed.error}` };
                await ctx.storage.set(key, pushed.state);
                await ctx.session.switchAgent({ sessionID: context.sessionID, agent: target });
                await ctx.session.instructions.entry.put({
                  sessionID: context.sessionID,
                  key: "opencode-decisions-handoff",
                  value: handoffInstruction(pushed.state, pushed.frame),
                });
                await ledger.record({
                  kind: "audit",
                  audit: "handoff-open",
                  sessionID: context.sessionID,
                  ...handoffLedgerFields(pushed.frame, {
                    escalation: typeof input.reason === "string" ? input.reason : undefined,
                  }),
                });
                return {
                  content: `Handoff to ${target} recorded (task ${frame.taskId}, depth ${pushed.frame.depth}). The specialist should call decisions.return_to_owner with its findings.`,
                };
              } catch (error) {
                return { content: `Handoff unavailable: ${error?.message || error}` };
              }
            },
          });

          editor.add({
            name: "return_to_owner",
            description:
              "Return a completed specialist assignment to the previous orchestrator in this same session, with structured findings and outstanding issues.",
            input: {
              type: "object",
              properties: {
                findings: { type: "string", description: "Structured specialist findings" },
                outstanding: { type: "string", description: "Outstanding issues, if any" },
                escalation: { type: "string", description: "Critical escalation, if any" },
              },
              required: ["findings"],
              additionalProperties: false,
            },
            options: { namespace: "decisions", codemode: true },
            execute: async (input, context) => {
              try {
                const key = handoffKey(context.sessionID);
                const state = await ctx.storage.get(key);
                if (validateHandoffState(state).length) {
                  return { content: "No valid handoff state exists for this session." };
                }
                const popped = popHandoff(state);
                if (popped.error || !popped.frame) {
                  return { content: `Handoff return refused: ${popped.error || "no frame"}` };
                }
                const owner = popped.frame.from;
                const ownerValid = await agentAvailable(owner);
                if (!ownerValid) {
                  return { content: `Return target '${owner}' is not a valid agent in the live catalog.` };
                }
                const frame = {
                  ...popped.frame,
                  outstanding: typeof input.outstanding === "string" ? [input.outstanding.slice(0, 600)] : [],
                  failures: typeof input.escalation === "string" ? [input.escalation.slice(0, 400)] : [],
                  nextAction: "Integrate specialist findings and continue the original mission.",
                  state: "returned",
                };
                await ctx.storage.set(key, popped.state);
                await ctx.session.switchAgent({ sessionID: context.sessionID, agent: owner });
                await ctx.session.instructions.entry.put({
                  sessionID: context.sessionID,
                  key: "opencode-decisions-return",
                  value: handoffInstruction(popped.state, frame, {
                    findings: input.findings,
                    outstanding: input.outstanding,
                    escalation: input.escalation,
                  }),
                });
                await ledger.record({
                  kind: "audit",
                  audit: "handoff-return",
                  sessionID: context.sessionID,
                  ...handoffLedgerFields(frame, {
                    findings: input.findings,
                    outstanding: input.outstanding,
                    escalation: input.escalation,
                  }),
                });
                return {
                  content: `Returned to ${owner} with findings (task ${frame.taskId}, remaining depth ${popped.state.stack.length}).`,
                };
              } catch (error) {
                return { content: `Handoff return unavailable: ${error?.message || error}` };
              }
            },
          });
        }
      });
    }

    if (opt.commandDecide) {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "decide",
          description: "Ask a yes/no decision question",
          execute: async ({ sessionID, prompt, delivery }) => {
            const text = typeof prompt.text === "string" ? prompt.text.trim() : "";
            if (!text) return;
            let resultText;
            try {
              const result = await decide(ctx, {
                questions: [{ type: "predicate", name: "answer", instructions: text }],
                input: [{ type: "text", text }],
                timeoutMs: opt.timeoutMs,
                ledger,
                cache,
                meta: { kind: "command", sessionID },
              });
              resultText = `Decision: ${JSON.stringify(result.answers[0] || {})}`;
            } catch (error) {
              resultText = `Decision unavailable: ${error?.message || error}`;
            }
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              delivery,
              text: `${resultText}\n\nQuestion: ${text}`,
            });
          },
        });

        editor.add({
          name: "decisions-ledger",
          description: "Show recent ledger entries; optional arguments: <kind> <limit>",
          execute: async ({ sessionID, prompt, delivery }) => {
            let text = "Decision ledger unavailable.";
            try {
              const tokens = (typeof prompt.text === "string" ? prompt.text.trim() : "").split(/\s+/).filter(Boolean);
              const kind = tokens.find((token) => !/^\d+$/.test(token));
              const limit = Number(tokens.find((token) => /^\d+$/.test(token))) || opt.ledgerLimit;
              const page = await ledger.query({ kind, limit });
              const lines = (page.entries || []).map((entry) => {
                const answers = Array.isArray(entry.answers)
                  ? entry.answers.map((item) => item.name).join(",")
                  : "";
                const model = entry.model
                  ? `${entry.providerID ? `${entry.providerID}/` : ""}${entry.model}`
                  : "";
                const audit = entry.audit ? ` audit=${entry.audit}` : "";
                return [entry.at, `[${entry.kind}]`, model, audit, answers].filter(Boolean).join(" ");
              });
              text = lines.length ? `Recent decisions:\n${lines.join("\n")}` : "No decisions recorded.";
            } catch (error) {
              text = `Decision ledger unavailable: ${error?.message || error}`;
            }
            await ctx.session.prompt({ ...prompt, sessionID, delivery, text });
          },
        });

        editor.add({
          name: "decisions-stats",
          description: "Show aggregate decision ledger statistics",
          execute: async ({ sessionID, prompt, delivery }) => {
            let text = "Decision stats unavailable.";
            try {
              const stats = await ledger.stats();
              text = [
                `Decision stats: total=${stats.total} success=${stats.successes} error=${stats.errors}`,
                `By kind: ${JSON.stringify(stats.byKind)}`,
                `By model: ${JSON.stringify(stats.byModel)}`,
                `Avg duration: ${stats.avgDurationMs}ms`,
                `Last: ${stats.lastAt || "n/a"}`,
              ].join("\n");
            } catch (error) {
              text = `Decision stats unavailable: ${error?.message || error}`;
            }
            await ctx.session.prompt({ ...prompt, sessionID, delivery, text });
          },
        });

        editor.add({
          name: "decisions-export",
          description: "Export sanitized ledger entries as JSON; optional arguments: <kind> <limit>",
          execute: async ({ sessionID, prompt, delivery }) => {
            let text = "Decision export unavailable.";
            try {
              const tokens = (typeof prompt.text === "string" ? prompt.text.trim() : "").split(/\s+/).filter(Boolean);
              const kind = tokens.find((token) => !/^\d+$/.test(token));
              const limit = Number(tokens.find((token) => /^\d+$/.test(token))) || opt.ledgerLimit;
              const page = await ledger.query({ kind, limit: Math.min(200, limit) });
              text = JSON.stringify(page.entries, null, 2);
            } catch (error) {
              text = `Decision export unavailable: ${error?.message || error}`;
            }
            await ctx.session.prompt({ ...prompt, sessionID, delivery, text });
          },
        });
      });
    }

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  },
});
