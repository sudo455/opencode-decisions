// HTTP-callable decision RPC surface.
// The id and method names stay generic; model selection belongs to the caller.
import { Rpc } from "@opencode/plugin/rpc";

const unauthorized = {
  type: "object",
  properties: { reason: { type: "string" } },
  required: ["reason"],
  additionalProperties: false,
};

export const Decisions = Rpc.define({
  id: "decisions",
  events: {},
  methods: {
    choose: {
      input: {
        type: "object",
        properties: {
          question: { type: "string" },
          choices: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 20 },
          state: { type: "string" },
          model: { type: "string" },
          providerID: { type: "string" },
          token: { type: "string", description: "Per-client RPC token" },
        },
        required: ["question", "choices"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          choice: { type: "string" },
          model: { type: "string" },
          confidence: { type: "number" },
          probabilities: { type: "array", items: { type: "object" } },
        },
        required: ["choice"],
        additionalProperties: false,
      },
      errors: {
        decision_failed: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
          additionalProperties: false,
        },
        unsupported_model: {
          type: "object",
          properties: { model: { type: "string" } },
          required: ["model"],
          additionalProperties: false,
        },
        unauthorized,
      },
    },
    models: {
      input: {
        type: "object",
        properties: { token: { type: "string", description: "Per-client RPC token" } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          models: {
            type: "array",
            items: {
              type: "object",
              properties: {
                providerID: { type: "string" },
                id: { type: "string" },
                name: { type: "string" },
              },
              required: ["providerID", "id"],
              additionalProperties: false,
            },
          },
        },
        required: ["models"],
        additionalProperties: false,
      },
      errors: {
        unauthorized,
        decision_failed: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
          additionalProperties: false,
        },
      },
    },
    ledger: {
      input: {
        type: "object",
        properties: {
          token: { type: "string", description: "Per-client RPC token" },
          kind: { type: "string", description: "Filter by ledger entry kind" },
          audit: { type: "string", description: "Filter by audit action" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          since: { type: "string", description: "ISO timestamp lower bound" },
          until: { type: "string", description: "ISO timestamp upper bound" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                at: { type: "string" },
                kind: { type: "string" },
                sessionID: { type: "string" },
                model: { type: "string" },
                providerID: { type: "string" },
                durationMs: { type: "number" },
                cost: { type: "number" },
                error: { type: "boolean" },
                audit: { type: "string" },
                agent: { type: "string" },
                from: { type: "string" },
                tool: { type: "string" },
                attempt: { type: "number" },
                probability: { type: "number" },
                answers: { type: "array", items: { type: "object" } },
              },
              required: ["id", "kind"],
              additionalProperties: false,
            },
          },
        },
        required: ["entries"],
        additionalProperties: false,
      },
      errors: {
        unauthorized,
        ledger_failed: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
          additionalProperties: false,
        },
      },
    },
    stats: {
      input: {
        type: "object",
        properties: { token: { type: "string", description: "Per-client RPC token" } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          total: { type: "integer" },
          byKind: { type: "object", additionalProperties: { type: "integer" } },
          byModel: { type: "object", additionalProperties: { type: "integer" } },
          errors: { type: "integer" },
          successes: { type: "integer" },
          avgDurationMs: { type: "number" },
          lastAt: { type: "string" },
        },
        required: ["total", "byKind", "byModel", "errors", "successes", "avgDurationMs"],
        additionalProperties: false,
      },
      errors: {
        unauthorized,
        ledger_failed: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
          additionalProperties: false,
        },
      },
    },
  },
});
