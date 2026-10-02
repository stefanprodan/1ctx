/**
 * Index-related jq builtins
 *
 * Handles index, rindex, and indices functions for finding positions in arrays/strings.
 */

import type { EvalContext } from "../evaluator.js";
import type { AstNode } from "../parser.js";
import type { QueryValue } from "../value-operations.js";

type EvalFn = (
  value: QueryValue,
  ast: AstNode,
  ctx: EvalContext,
) => QueryValue[];

type DeepEqualFn = (a: QueryValue, b: QueryValue) => boolean;

/**
 * Handle index builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not an index builtin handled here.
 */
export function evalIndexBuiltin(
  value: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext,
  evaluate: EvalFn,
  deepEqual: DeepEqualFn,
): QueryValue[] | null {
  // jq's definitions, in indicesOf (1ctx jq-indices)
  switch (name) {
    case "index":
    case "rindex":
    case "indices": {
      if (args.length !== 1) return null;
      const needles = evaluate(value, args[0], ctx);
      return needles.map((needle) => {
        const found = indicesOf(value, needle, ctx, evaluate, deepEqual);
        if (name === "indices") return found;
        // index is `indices($i) | .[0]`, rindex `.[-1:][0]`
        if (found === null) return null;
        if (!Array.isArray(found)) {
          throw new Error(`Cannot index ${typeName(found)} with number`);
        }
        const at = name === "index" ? 0 : found.length - 1;
        return found.length > 0 ? found[at] : null;
      });
    }

    default:
      return null;
  }
}

function typeName(v: QueryValue): string {
  if (v === null) return "null";
  return Array.isArray(v) ? "array" : typeof v;
}

/**
 * jq's `def indices($i)`: an array's positions of $i, or of the run $i
 * when it is an array; a string's code point offsets of $i, overlapping,
 * none for an empty one; anything else `.[$i]`. Upstream counted UTF-16
 * units, looped forever on `"" | indices("")` and answered `[]` for the
 * rest (1ctx jq-indices)
 */
function indicesOf(
  value: QueryValue,
  needle: QueryValue,
  ctx: EvalContext,
  evaluate: EvalFn,
  deepEqual: DeepEqualFn,
): QueryValue {
  if (Array.isArray(value)) {
    const run = Array.isArray(needle) ? needle : [needle];
    const result: number[] = [];
    if (run.length === 0) return result;
    for (let i = 0; i + run.length <= value.length; i++) {
      if (run.every((item, j) => deepEqual(value[i + j], item))) result.push(i);
    }
    return result;
  }
  if (typeof value === "string" && typeof needle === "string") {
    const result: number[] = [];
    if (needle === "") return result;
    let points = 0;
    let counted = 0;
    for (let at = value.indexOf(needle); at !== -1; ) {
      for (; counted < at; counted++) {
        const code = value.charCodeAt(counted);
        // the second half of a surrogate pair is no code point of its own
        if (code < 0xdc00 || code > 0xdfff) points++;
      }
      result.push(points);
      const step = value.codePointAt(at) as number > 0xffff ? 2 : 1;
      at = value.indexOf(needle, at + step);
    }
    return result;
  }
  return (
    evaluate(
      value,
      { type: "Index", index: { type: "Literal", value: needle } },
      ctx,
    )[0] ?? null
  );
}
