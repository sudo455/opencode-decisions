import { Plugin } from "@opencode/plugin";

const DEFAULT_OPTIONS = {
  enabled: true,
  modelID: "jev-1.13-free",
  timeoutMs: 6000,
  highRisk: 0.6,
  mediumRisk: 0.3,
  maxChoices: 12,
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
  return Array.isArray(answers) ? answers.find((a) => a && a.name === name) : undefined;
}

function label(list, id) {
  const item = list.find((x) => x.id === id || x.name === id);
  return item?.name || item?.id || id;
}

export default Plugin.define({
  id: "jev-policy",
  async setup(ctx) {
    const opt = { ...DEFAULT_OPTIONS, ...(ctx.options || {}) };
    if (opt.enabled === false) return;

    let agents = [];
    let skills = [];
    try {
      agents = ((await ctx.agent.list()).data || []).filter(
        (a) => a && (a.mode === "all" || a.mode === "primary") && !a.hidden,
      );
    } catch (error) {
      console.warn("[jev-policy] agent list unavailable:", error?.message || error);
    }
    try {
      skills = ((await ctx.skill.list()).data || []).filter((s) => s && s.id);
    } catch (error) {
      console.warn("[jev-policy] skill list unavailable:", error?.message || error);
    }

    const agentChoices = [
      { value: "keep", description: "Keep the current agent" },
      ...agents.slice(0, opt.maxChoices).map((a) => ({
        value: a.id,
        description: a.description || `Agent: ${a.name || a.id}`,
      })),
    ];
    const skillChoices = [
      { value: "none", description: "No skill" },
      ...skills.slice(0, opt.maxChoices).map((s) => ({
        value: s.id,
        description: s.description || `Skill: ${s.name || s.id}`,
      })),
    ];

    await ctx.session.hook("prompt", async (event) => {
      const prompt = event.prompt || {};
      const described = [
        typeof prompt.text === "string" ? prompt.text.slice(0, 4000) : "",
        Array.isArray(prompt.files) && prompt.files.length
          ? `Attachments: ${prompt.files.map((f) => f.name || f.uri).join(", ")}`
          : "",
        Array.isArray(prompt.agents) && prompt.agents.length
          ? `Agent mentions: ${prompt.agents.map((a) => a.name).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      let timer;
      try {
        const pending = ctx.experimental.generate.decisions({
          model: { providerID: "opencode", id: opt.modelID },
          input: [{ type: "text", text: described }],
          questions: [
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
          ],
        });
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Jev decision timed out")), opt.timeoutMs);
        });
        const result = await Promise.race([pending, timeout]);
        clearTimeout(timer);
        timer = undefined;

        const answers = result?.answers || [];
        const taskAnswer = first(answers, "task_type");
        const riskAnswer = first(answers, "risk");
        const agentAnswer = first(answers, "agent");
        const skillAnswer = first(answers, "skill");

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

        const lines = [
          `<jev-policy task="${task}" risk="${probability.toFixed(2)}" verification="${verification}">`,
          `Task guidance: ${TASK_GUIDANCE[task]}`,
          `Verification: ${VERIFY_GUIDANCE[verification]}`,
        ];

        if (chosenAgent && agents.some((a) => a.id === chosenAgent)) {
          if (!Array.isArray(prompt.agents) || prompt.agents.length === 0) {
            await ctx.session.switchAgent({ sessionID: event.sessionID, agent: chosenAgent });
            lines.push(`Agent selected by Jev: ${label(agents, chosenAgent)}`);
          } else {
            lines.push(`Agent mention preserved; Jev suggested: ${label(agents, chosenAgent)}`);
          }
        }

        if (chosenSkill && skills.some((s) => s.id === chosenSkill)) {
          prompt.skills = Array.isArray(prompt.skills) ? prompt.skills.slice() : [];
          if (!prompt.skills.some((s) => s.id === chosenSkill)) {
            prompt.skills.push({ id: chosenSkill });
            lines.push(`Skill selected by Jev: ${label(skills, chosenSkill)}`);
          }
        }

        lines.push("</jev-policy>");
        await ctx.session.instructions.entry.put({
          sessionID: event.sessionID,
          key: "jev-policy",
          value: lines.join("\n"),
        });
        console.log(
          `[jev-policy] task=${task} risk=${probability.toFixed(2)} verification=${verification}`,
        );
      } catch (error) {
        if (timer) clearTimeout(timer);
        console.warn("[jev-policy] failed open:", error?.message || error);
      }
    });
  },
});
