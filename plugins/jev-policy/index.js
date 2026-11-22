import { Plugin } from "@opencode/plugin";
import { answer, decide } from "./lib/decide.js";
import { makeLedger } from "./lib/ledger.js";
import { loadRisk, saveRisk } from "./lib/risk.js";

const DEFAULT_OPTIONS = {
  enabled: true,
  modelID: "jev-1.13-free",
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
  ensembleModels: ["jev-1.13-free", "gpt-6-luna-decision", "gemini-decision-1"],
  fallbackModelID: "jev-1.13",
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
  id: "jev-policy",
  async setup(ctx) {
    const opt = { ...DEFAULT_OPTIONS, ...(ctx.options || {}) };
    if (opt.enabled === false) return;

    const ledger = makeLedger(ctx, opt.ledger);

    let agents = [];
    let skills = [];
    try {
      agents = ((await ctx.agent.list()).data || []).filter(
        (agent) => agent && (agent.mode === "all" || agent.mode === "primary") && !agent.hidden,
      );
    } catch (error) {
      console.warn("[jev-policy] agent list unavailable:", error?.message || error);
    }
    try {
      skills = ((await ctx.skill.list()).data || []).filter((skill) => skill && skill.id);
    } catch (error) {
      console.warn("[jev-policy] skill list unavailable:", error?.message || error);
    }

    const agentChoices = [
      { value: "keep", description: "Keep the current agent" },
      ...agents.slice(0, opt.maxChoices).map((agent) => ({
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
          instructions: "Which agent is best suited to carry out this request?",
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

      let timer;
      try {
        const pending = decide(ctx, {
          model: { providerID: "opencode", id: opt.modelID },
          input: [{ type: "text", text: described }],
          questions,
          timeoutMs: opt.timeoutMs,
          ledger,
          meta: { kind: "prompt", sessionID: event.sessionID },
        });
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Jev decision timed out")), opt.timeoutMs);
        });
        const result = await Promise.race([pending, timeout]);
        clearTimeout(timer);
        timer = undefined;

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

        const chosenAgent =
          typeof agentAnswer?.choice === "string" && agentAnswer.choice !== "keep"
            ? agentAnswer.choice
            : undefined;
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
          `<jev-policy task="${task}" risk="${probability.toFixed(2)}" verification="${verification}">`,
          `Task guidance: ${TASK_GUIDANCE[task]}`,
          `Verification: ${VERIFY_GUIDANCE[verification]}`,
        ];

        if (chosenAgent && agents.some((agent) => agent.id === chosenAgent)) {
          if (!Array.isArray(prompt.agents) || prompt.agents.length === 0) {
            await ctx.session.switchAgent({ sessionID: event.sessionID, agent: chosenAgent });
            lines.push(`Agent selected by Jev: ${label(agents, chosenAgent)}`);
          } else {
            lines.push(`Agent mention preserved; Jev suggested: ${label(agents, chosenAgent)}`);
          }
        }

        if (chosenSkill && skills.some((skill) => skill.id === chosenSkill)) {
          prompt.skills = Array.isArray(prompt.skills) ? prompt.skills.slice() : [];
          if (!prompt.skills.some((skill) => skill.id === chosenSkill)) {
            prompt.skills.push({ id: chosenSkill });
            lines.push(`Skill selected by Jev: ${label(skills, chosenSkill)}`);
          }
        }

        if (opt.clarify && typeof ambiguousAnswer?.probability === "number" && ambiguousAnswer.probability >= opt.clarifyThreshold) {
          const text = typeof prompt.text === "string" ? prompt.text : "";
          prompt.text = `${text}\n\n[Jev clarification] State the assumptions you are making and ask the user to confirm the key ambiguity before proceeding.`;
          lines.push(`Clarification requested by Jev (${ambiguousAnswer.probability.toFixed(2)})`);
        }

        if (ensembleResult) {
          lines.push(
            ensembleResult.disagree
              ? "Decision models disagree: obtain human review before high-risk actions."
              : "High-risk decision confirmed by multiple decision models.",
          );
        }

        lines.push("</jev-policy>");
        await ctx.session.instructions.entry.put({
          sessionID: event.sessionID,
          key: "jev-policy",
          value: lines.join("\n"),
        });
        console.log(
          `[jev-policy] task=${task} risk=${probability.toFixed(2)} verification=${verification}` +
            (ensembleResult ? ` ensemble=${ensembleResult.disagree ? "disagree" : "agree"}` : ""),
        );
      } catch (error) {
        if (timer) clearTimeout(timer);
        console.warn("[jev-policy] failed open:", error?.message || error);
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
          console.warn("[jev-policy] least-privilege failed open:", error?.message || error);
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
            save: [event.tool],
            metadata: {
              jevRisk: record.probability,
              task: record.task,
              needsReview: record.needsReview,
            },
          });
        } catch (error) {
          console.warn("[jev-policy] permission assert failed:", error?.message || error);
          throw error;
        }
      });
    }

    if (opt.toolDecide) {
      await ctx.tool.transform((editor) => {
        editor.namespace({
          name: "jev",
          description: "Structured decisions using the Jev decision model",
        });
        editor.add({
          name: "decide",
          description:
            "Ask Jev a typed decision question. type=predicate|choice|score; supply choices or levels for the latter two.",
          input: {
            type: "object",
            properties: {
              question: { type: "string", description: "The decision question" },
              type: { type: "string", enum: ["predicate", "choice", "score"], default: "predicate" },
              choices: { type: "array", items: { type: "string" } },
              levels: { type: "array", items: { type: "string" } },
              state: { type: "string", description: "Optional context given to Jev" },
            },
            required: ["question"],
            additionalProperties: false,
          },
          options: { namespace: "jev", codemode: true },
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
      });
    }

    if (opt.commandDecide) {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "decide",
          description: "Ask Jev a yes/no decision question",
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
              resultText = `Jev decision: ${JSON.stringify(result.answers[0] || {})}`;
            } catch (error) {
              resultText = `Jev decision unavailable: ${error?.message || error}`;
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
          name: "jev-ledger",
          description: "Show recent Jev decisions from the decision ledger",
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
              text = lines.length ? `Recent Jev decisions:\n${lines.join("\n")}` : "No Jev decisions recorded.";
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
