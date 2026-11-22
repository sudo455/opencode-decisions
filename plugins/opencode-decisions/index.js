import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Plugin } from "@opencode/plugin";
import { answer, decide } from "./lib/decide.js";
import { makeLedger } from "./lib/ledger.js";
import { DEFAULT_MODEL, ENSEMBLE_MODELS, FALLBACK_MODEL } from "./lib/models.js";
import { loadRisk, saveRisk } from "./lib/risk.js";
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
  agentAllowlist: [],
  agentFallback: true,
  highRiskAgent: "plan",
  lowRiskAgent: "build",
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

async function ensemble(ctx, opt, input, questions, ledger, sessionID) {
  const settled = await Promise.allSettled(
    opt.ensembleModels.map((id) =>
      decide(ctx, {
        model: { providerID: "opencode", id },
        input,
        questions,
        timeoutMs: opt.timeoutMs,
        ledger,
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

    const ledger = makeLedger(ctx, opt.ledger);

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
      });
    }

    let agents = [];
    let skills = [];
    try {
      agents = ((await ctx.agent.list()).data || []).filter(
        (agent) => agent && (agent.mode === "all" || agent.mode === "primary") && !agent.hidden,
      );
      if (Array.isArray(opt.agentAllowlist) && opt.agentAllowlist.length) {
        agents = agents.filter((agent) => opt.agentAllowlist.includes(agent.id));
      }
    } catch (error) {
      console.warn("[opencode-decisions] agent list unavailable:", error?.message || error);
    }
    try {
      skills = ((await ctx.skill.list()).data || []).filter((skill) => skill && skill.id);
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

      try {
        const result = await decide(ctx, {
          model: { providerID: "opencode", id: opt.modelID },
          input: [{ type: "text", text: described }],
          questions,
          timeoutMs: opt.timeoutMs,
          ledger,
          meta: { kind: "prompt", sessionID: event.sessionID },
        });

        const answers = result.answers;
        const taskAnswer = first(answers, "task_type");
        const riskAnswer = first(answers, "risk");
        const agentAnswer = first(answers, "agent");
        const skillAnswer = first(answers, "skill");
        const ambiguousAnswer = first(answers, "ambiguous");

        const task = TASK_TYPES.includes(taskAnswer?.choice) ? taskAnswer.choice : "other";
        const probability =
          typeof riskAnswer?.probability === "number" ? riskAnswer.probability : 0.5;
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
          ensembleResult = await ensemble(ctx, opt, [{ type: "text", text: described }], questions, ledger, event.sessionID);
        }

        await saveRisk(ctx, event.sessionID, {
          probability,
          task,
          verification,
          needsReview: Boolean(ensembleResult?.disagree),
        });

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
        console.warn("[opencode-decisions] failed open:", error?.message || error);
      }
    });

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

    if (opt.riskGate) {
      await ctx.tool.hook("execute.before", async (event) => {
        if (!opt.sensitiveTools.includes(event.tool)) return;
        try {
          const record = await loadRisk(ctx, event.sessionID);
          if (!record || record.probability < opt.highRisk) return;
          await ctx.permission.assert({
            sessionID: event.sessionID,
            agent: event.agent,
            source: { type: "tool", messageID: event.messageID, id: event.id },
            action: event.tool,
            resources: [event.tool],
            save: true,
            metadata: {
              decisionRisk: record.probability,
              task: record.task,
              needsReview: record.needsReview,
            },
          });
        } catch (error) {
          console.warn("[opencode-decisions] permission assert failed:", error?.message || error);
          throw error;
        }
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
              "Switch this session to any available agent discovered from the live catalog (e.g. plan to design first, build to implement). Takes effect from the next step/request.",
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
                if (Array.isArray(opt.agentAllowlist) && opt.agentAllowlist.length) {
                  allowed = allowed.filter((agent) => opt.agentAllowlist.includes(agent.id));
                }
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
                return {
                  content: `Switched to agent '${target}'. The switch applies from the next step/request.`,
                };
              } catch (error) {
                return { content: `Agent switch unavailable: ${error?.message || error}` };
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
          description: "Show recent decisions from the decision ledger",
          execute: async ({ sessionID, prompt, delivery }) => {
            let text = "Decision ledger unavailable.";
            try {
              const page = await ledger.recent(opt.ledgerLimit);
              const lines = (page.entries || []).map((entry) => {
                const value = entry.value || {};
                const answers = Array.isArray(value.answers)
                  ? value.answers.map((item) => item.name).join(",")
                  : "";
                return `${value.at || entry.key} [${value.kind || "?"}] ${value.modelID || value.model?.id || ""} ${answers}`;
              });
              text = lines.length ? `Recent decisions:\n${lines.join("\n")}` : "No decisions recorded.";
            } catch (error) {
              text = `Decision ledger unavailable: ${error?.message || error}`;
            }
            await ctx.session.prompt({ ...prompt, sessionID, delivery, text });
          },
        });
      });
    }
  },
});
