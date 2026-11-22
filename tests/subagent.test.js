import test from "node:test";
import assert from "node:assert/strict";
import { chooseSubagentAgent } from "../plugins/opencode-decisions/lib/subagent.js";

const OPT = { timeoutMs: 1000, subagentMaxChoices: 12 };

function makeCtx() {
  return {
    agent: {
      list: async () => ({
        data: [
          { id: "build", mode: "primary", name: "Build" },
          { id: "explore", mode: "subagent", name: "Explore", description: "Read code" },
          { id: "general", mode: "all", name: "General" },
          { id: "hidden-agent", mode: "subagent", hidden: true },
        ],
      }),
    },
  };
}

function makeLedgerMock() {
  const entries = [];
  return {
    entries,
    async record(entry) {
      entries.push(entry);
    },
  };
}

function makeTools(ledger, decide) {
  return {
    decide,
    ledger,
    cache: undefined,
    first: (answers, name) => answers.find((answer) => answer.name === name),
    onFailure: () => {},
  };
}

test("native subagent input gets an eligible agent chosen by the decision model", async () => {
  const event = {
    tool: "subagent",
    sessionID: "s1",
    messageID: "m1",
    id: "t1",
    input: { description: "probe", prompt: "Inspect the repo" },
  };
  let seen;
  const ledger = makeLedgerMock();
  const decide = async (_ctx, request) => {
    seen = request;
    return { answers: [{ type: "choice", name: "agent", choice: "explore" }] };
  };

  const picked = await chooseSubagentAgent(makeCtx(), event, OPT, makeTools(ledger, decide));

  assert.equal(picked, "explore");
  assert.equal(event.input.agent, "explore");
  assert.equal(seen.input[0].text, "Inspect the repo");
  assert.deepEqual(
    seen.questions[0].choices.map((choice) => choice.value),
    ["explore", "general"],
  );
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].kind, "subagent-agent");
  assert.equal(ledger.entries[0].agent, "explore");
  assert.equal(ledger.entries[0].toolID, "t1");
});

test("an explicit agent is never overwritten", async () => {
  const event = {
    tool: "subagent",
    sessionID: "s1",
    input: { agent: "plan", prompt: "Do the thing" },
  };
  const original = structuredClone(event.input);
  const ledger = makeLedgerMock();
  let called = false;
  const decide = async () => {
    called = true;
    return { answers: [] };
  };

  const picked = await chooseSubagentAgent(makeCtx(), event, OPT, makeTools(ledger, decide));

  assert.equal(picked, undefined);
  assert.equal(called, false);
  assert.deepEqual(event.input, original);
  assert.equal(ledger.entries.length, 0);
});

test("a choice outside the live agent list is ignored", async () => {
  const event = { tool: "subagent", sessionID: "s1", input: { prompt: "Task" } };
  const ledger = makeLedgerMock();
  const decide = async () => ({ answers: [{ type: "choice", name: "agent", choice: "not-live" }] });

  const picked = await chooseSubagentAgent(makeCtx(), event, OPT, makeTools(ledger, decide));

  assert.equal(picked, undefined);
  assert.equal(event.input.agent, undefined);
  assert.equal(ledger.entries.length, 0);
});

test("decision failure is fail-open and records an audit entry", async () => {
  const event = { tool: "subagent", sessionID: "s1", input: { prompt: "Task" } };
  const ledger = makeLedgerMock();
  const failures = [];
  const tools = makeTools(ledger, async () => {
    throw new Error("decision down");
  });
  tools.onFailure = (scope, error) => failures.push({ scope, error });

  const picked = await chooseSubagentAgent(makeCtx(), event, OPT, tools);

  assert.equal(picked, undefined);
  assert.equal(event.input.agent, undefined);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].scope, "subagent decision");
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].audit, "subagent-decision-failure");
});
