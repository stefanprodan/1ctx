/**
 * Which document a yq result counts as read from (1ctx)
 *
 * mikefarah's yq prints `---` before a result whose document index differs
 * from the last one printed. A node read from a document carries its index
 * through its parents; a value a function computes carries none and counts
 * as document 0. So `.metadata.name` prints the line between documents and
 * `length` or `"\(.kind)"` does not, and `.a // "none"` prints it only
 * where the index moves.
 *
 * The engine works on plain values, so this walker runs the top of the
 * filter itself: it splits the combinators whose results can differ in
 * state (`|`, `,`, `//`, parentheses, `as`, `if`, arithmetic) and hands
 * every other node to `evaluate()` whole, tagging its results by a static
 * classification of the node. The values are exactly what `evaluate()`
 * answers for the whole filter; only the tags are added.
 */

import {
  bindPattern,
  createContext,
  type EvalContext,
  type EvaluateOptions,
  evalBinaryOp,
  evaluate,
  extractPathFromAst,
  type QueryValue,
} from "../query-engine/index.js";
import type { AstNode, DestructurePattern } from "../query-engine/parser.js";
import { asQueryRecord } from "../query-engine/safe-object.js";
import { isTruthy } from "../query-engine/value-operations.js";

/**
 * The document itself, a node inside it reached by a path step, or a value
 * computed from nothing (document 0).
 */
export type State = "document" | "inside" | "computed";

export interface Tagged {
  value: QueryValue;
  state: State;
}

type Vars = ReadonlyMap<string, State>;

// functions that return their input node, so its document stays
const SAME_NODE = new Set([
  "select",
  "del",
  "pick",
  "omit",
  "sort_keys",
  "map_values",
  "explode",
  "with",
  "eval",
  "debug",
]);

// functions that build their result from nothing
const COMPUTED = new Set([
  "keys",
  "with_entries",
  "filter",
  "splitDoc",
  "split_doc",
  "env",
  "strenv",
  "load",
  "load_str",
  "array_to_map",
  "input",
  "inputs",
]);

// functions that step into their input, as a path does
const PATH_STEP = new Set(["recurse", "getpath"]);

function step(state: State): State {
  return state === "computed" ? "computed" : "inside";
}

// a function's result made in place of its input: a node inside a document
// stays there, a whole document's replacement loses its index
function replaced(state: State): State {
  return state === "document" ? "computed" : state;
}

const ARITHMETIC = new Set(["+", "-", "*", "/", "%"]);

/**
 * The state of the results of `ast` run on an input in `state`, from the
 * node alone. `value` is the input when known, which `map` reads.
 */
export function classify(
  ast: AstNode,
  state: State,
  value?: QueryValue,
  vars: Vars = new Map(),
): State {
  switch (ast.type) {
    case "Identity":
    case "UpdateOp":
      return state;
    // a built map keeps its input's document; an empty one is a literal
    case "Object":
      return ast.entries.length === 0 ? "computed" : state;
    case "Field":
    case "Index":
    case "Slice":
    case "Iterate":
      return step(ast.base ? classify(ast.base, state, undefined, vars) : state);
    case "Recurse":
      return step(state);
    case "Optional":
      return classify(ast.expr, state, value, vars);
    case "Paren":
      return classify(ast.expr, state, value, vars);
    case "Pipe":
      return classify(
        ast.right,
        classify(ast.left, state, value, vars),
        undefined,
        vars,
      );
    case "Comma":
      return classify(ast.left, state, value, vars);
    case "Literal":
    case "StringInterp":
    case "Reduce":
    case "Foreach":
    case "Break":
      return "computed";
    case "Array":
      return replaced(state);
    case "UnaryOp":
      return replaced(classify(ast.operand, state, value, vars));
    case "BinaryOp": {
      const left = classify(ast.left, state, value, vars);
      return ast.op === "//" ? left : replaced(left);
    }
    case "Cond":
      return classify(ast.then, state, value, vars);
    case "Try":
      return classify(ast.body, state, value, vars);
    case "Label":
      return classify(ast.body, state, value, vars);
    case "Def":
      return classify(ast.body, state, value, vars);
    case "VarBind":
      return classify(ast.body, state, value, vars);
    case "VarRef":
      return vars.get(ast.name) ?? "computed";
    case "Call":
      if (SAME_NODE.has(ast.name)) return state;
      if (COMPUTED.has(ast.name)) return "computed";
      if (PATH_STEP.has(ast.name)) return step(state);
      // map builds a new list, except on null, where it replaces the input
      if (ast.name === "map") {
        return value === null ? replaced(state) : "computed";
      }
      return replaced(state);
    default:
      return replaced(state);
  }
}

function patternNames(pattern: DestructurePattern, names: string[]): void {
  if (pattern.type === "var") {
    names.push(pattern.name);
  } else if (pattern.type === "array") {
    for (const element of pattern.elements) patternNames(element, names);
  } else {
    for (const field of pattern.fields) {
      if (field.keyVar) names.push(field.keyVar);
      patternNames(field.pattern, names);
    }
  }
}

function isMap(value: QueryValue): boolean {
  return asQueryRecord(value) !== null;
}

// scalar arithmetic replaces its left side; null + x is x; a merge of two
// maps keeps the side that was read
function arithmetic(op: string, left: Tagged, right: Tagged): State {
  if (op === "+" && left.value === null) return right.state;
  if ((op === "+" || op === "*") && isMap(left.value) && isMap(right.value)) {
    return left.state === "computed" ? right.state : left.state;
  }
  return replaced(left.state);
}

function walk(
  ast: AstNode,
  input: Tagged,
  ctx: EvalContext,
  vars: Vars,
): Tagged[] {
  switch (ast.type) {
    case "Pipe": {
      const lefts = walk(ast.left, input, ctx, vars);
      // the context the engine's own pipe gives its right side, which
      // parent and path read
      const leftPath = extractPathFromAst(ast.left);
      const right =
        leftPath === null
          ? ctx
          : { ...ctx, currentPath: [...(ctx.currentPath ?? []), ...leftPath] };
      return lefts.flatMap((left) => walk(ast.right, left, right, vars));
    }
    case "Comma":
      return [
        ...walk(ast.left, input, ctx, vars),
        ...walk(ast.right, input, ctx, vars),
      ];
    case "Paren":
      return walk(ast.expr, input, ctx, vars);
    case "BinaryOp": {
      if (ast.op === "//") {
        const found = walk(ast.left, input, ctx, vars).filter(
          ({ value }) => value !== null && value !== undefined && value !== false,
        );
        return found.length > 0 ? found : walk(ast.right, input, ctx, vars);
      }
      if (!ARITHMETIC.has(ast.op)) break;
      const lefts = walk(ast.left, input, ctx, vars);
      const rights = walk(ast.right, input, ctx, vars);
      const results: Tagged[] = [];
      for (const left of lefts) {
        for (const right of rights) {
          const values = evalBinaryOp(
            input.value,
            ast.op,
            { type: "Literal", value: left.value },
            { type: "Literal", value: right.value },
            ctx,
          );
          const state = arithmetic(ast.op, left, right);
          for (const value of values) results.push({ value, state });
        }
      }
      return results;
    }
    case "VarBind": {
      const patterns: DestructurePattern[] = ast.pattern
        ? [ast.pattern]
        : [{ type: "var", name: ast.name }];
      if (ast.alternatives) patterns.push(...ast.alternatives);
      return walk(ast.value, input, ctx, vars).flatMap((bound) => {
        for (const pattern of patterns) {
          const inner = bindPattern(ctx, pattern, bound.value);
          if (inner === null) continue;
          const names: string[] = [];
          patternNames(pattern, names);
          const states = new Map(vars);
          for (const name of names) states.set(name, bound.state);
          return walk(ast.body, input, inner, states);
        }
        return [];
      });
    }
    case "Cond":
      return evaluate(input.value, ast.cond, ctx).flatMap((cond) => {
        if (isTruthy(cond)) return walk(ast.then, input, ctx, vars);
        for (const elif of ast.elifs) {
          if (evaluate(input.value, elif.cond, ctx).some(isTruthy)) {
            return walk(elif.then, input, ctx, vars);
          }
        }
        return ast.else ? walk(ast.else, input, ctx, vars) : [input];
      });
    case "Recurse": {
      // .. answers the input itself first, then the nodes inside it
      const values = evaluate(input.value, ast, ctx);
      return values.map((value, index) => ({
        value,
        state: index === 0 ? input.state : step(input.state),
      }));
    }
  }
  const state = classify(ast, input.state, input.value, vars);
  return evaluate(input.value, ast, ctx).map((value) => ({ value, state }));
}

/**
 * The filter's results on one document, each tagged with the state that
 * decides which document it counts as read from.
 */
export function evaluateDocument(
  document: QueryValue,
  ast: AstNode,
  options: EvaluateOptions,
): Tagged[] {
  const ctx = { ...createContext(options), root: document, currentPath: [] };
  return walk(ast, { value: document, state: "document" }, ctx, new Map());
}
