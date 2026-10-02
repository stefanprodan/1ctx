/**
 * debug, stderr, input, inputs and input_filename, as jq answers them,
 * kept out of the evaluator so an upstream sync meets few hunks
 * (1ctx jq-stderr jq-inputs)
 */

import { assertQueryResultCapacity, type EvalContext } from "../evaluator.js";
import type { AstNode } from "../parser.js";
import { jqJson } from "../jq-text.js";
import type { QueryValue } from "../value-operations.js";

type EvalFn = (
  value: QueryValue,
  ast: AstNode,
  ctx: EvalContext,
) => QueryValue[];

/** The builtin's outputs, or null when the name is not one of these. */
export function evalIoBuiltin(
  value: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext,
  evaluate: EvalFn,
): QueryValue[] | null {
  switch (name) {
    case "debug":
      // jq writes ["DEBUG:",v] to stderr, for debug(m) each m; upstream
      // wrote nothing (1ctx jq-stderr)
      if (args.length > 1) return null;
      for (const shown of args.length === 0
        ? [value]
        : evaluate(value, args[0], ctx)) {
        ctx.log?.(`["DEBUG:",${jqJson(shown)}]\n`);
      }
      return [value];
    case "stderr":
      // the input as is, a string raw, with no newline (1ctx jq-stderr)
      if (args.length > 0) return null;
      ctx.log?.(typeof value === "string" ? value : jqJson(value));
      return [value];
    case "input": {
      // the next input; with none left jq 1.8 stops with `break` (1ctx jq-inputs)
      if (args.length > 0) return null;
      const next = ctx.input?.();
      if (!next) throw new Error("break");
      return [next.value];
    }
    case "inputs": {
      if (args.length > 0) return null;
      const out: QueryValue[] = [];
      for (let next = ctx.input?.(); next; next = ctx.input?.()) {
        assertQueryResultCapacity(ctx, out.length, 1);
        out.push(next.value);
      }
      return out;
    }
    case "input_filename":
      // the file the input came from, <stdin> for stdin, null without
      // input (1ctx jq-stderr)
      if (args.length > 0) return null;
      return [ctx.source?.filename ?? null];
    default:
      return null;
  }
}
