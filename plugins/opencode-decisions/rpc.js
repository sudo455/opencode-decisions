// HTTP-callable decision RPC surface.
// The id and method names stay generic; model selection belongs to the caller.
import { Rpc } from "@opencode/plugin/rpc";
import { DecisionsDefinition } from "./lib/rpc-definition.js";

export const Decisions = Rpc.define(DecisionsDefinition);
