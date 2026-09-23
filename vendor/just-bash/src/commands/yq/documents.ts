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
  type QuerySource,
  type QueryValue,
} from "../query-engine/index.js";
import { missingPath } from "../query-engine/builtins/dialect-builtins.js";
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
  /** the document splitDoc gave it, apart from the one it was read from */
  index?: number;
  /** the very node splitDoc made a document, not one inside it */
  splitRoot?: boolean;
  /** its path from the root, where known, for key and path */
  path?: (string | number)[];
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
  "ireduce",
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

// scalar arithmetic replaces its left side, a null left side included,
// whose replacement mikefarah makes in its place; a merge of two maps
// keeps the side that was read
function arithmetic(op: string, left: Tagged, right: Tagged): State {
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
      // splitDoc makes each result so far a document of its own
      if (isSplitDoc(ast.right)) {
        return lefts.map((left, index) => ({ ...left, index, splitRoot: true }));
      }
      // the context the engine's own pipe gives its right side, which
      // parent reads
      const leftPath = extractPathFromAst(ast.left);
      const right =
        leftPath === null
          ? ctx
          : { ...ctx, currentPath: [...(ctx.currentPath ?? []), ...leftPath] };
      // a node inside a split document stays in it, as mikefarah's parent
      // chain has it; a function's replacement of a node inside keeps it
      // and one of the split node itself loses it, arithmetic the other
      // way round, since his add copies the node's own index
      const keeps = keepsSplit(ast.right);
      const sameNode = keepsSplit(ast.right) && !isPathOnly(ast.right);
      return lefts.flatMap((left) =>
        walk(ast.right, left, { ...right, sourceNode: left }, vars).map(
          (result) => {
            if (left.index === undefined || result.index !== undefined) {
              return result;
            }
            const arithmetic =
              ast.right.type === "BinaryOp" && ARITHMETIC.has(ast.right.op);
            const kept = keeps
              ? true
              : arithmetic
                ? left.splitRoot === true
                : !left.splitRoot && result.state === "inside";
            if (!kept) return result;
            return {
              ...result,
              index: left.index,
              splitRoot: sameNode ? left.splitRoot : false,
            };
          },
        ),
      );
    }
    case "Comma":
      return [
        ...walk(ast.left, input, ctx, vars),
        ...walk(ast.right, input, ctx, vars),
      ];
    case "Paren":
      return walk(ast.expr, input, ctx, vars);
    case "Array": {
      // walked, so key and path inside [...] see the paths
      if (!ast.elements) break;
      const items = walk(ast.elements, input, ctx, vars).map((r) => r.value);
      const state = replaced(input.state);
      const path = state === "computed" ? [] : (input.path ?? []);
      return [{ value: items, state, path }];
    }
    case "BinaryOp": {
      if (ast.op === "//") {
        const found = walk(ast.left, input, ctx, vars).filter(
          ({ value }) => value !== null && value !== undefined && value !== false,
        );
        return found.length > 0 ? found : walk(ast.right, input, ctx, vars);
      }
      if (!ARITHMETIC.has(ast.op)) break;
      // a missing key read as an operand drops the result, or in + leaves
      // the other side, as the engine's own rule
      const yq = ctx.dialect === "yq";
      const leftMissing = yq && missingPath(input.value, ast.left);
      const rightMissing = yq && missingPath(input.value, ast.right);
      if (leftMissing || rightMissing) {
        if (ast.op !== "+" || (leftMissing && rightMissing)) return [];
        return walk(leftMissing ? ast.right : ast.left, input, ctx, vars);
      }
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
          return walk(ast.body, input, { ...inner, sourceNode: input }, states);
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
      const paths = pathsOf(input, ast, ctx, values.length, step(input.state));
      return values.map((value, index) => ({
        value,
        state: index === 0 ? input.state : step(input.state),
        path: paths?.[index],
      }));
    }
  }
  const state = classify(ast, input.state, input.value, vars);
  const values = evaluate(input.value, ast, ctx);
  const paths = pathsOf(input, ast, ctx, values.length, state);
  return values.map((value, index) => ({
    value,
    state,
    path: paths?.[index],
  }));
}

// a path step or a function returning its input keeps a split document's
// index, as mikefarah's parent chain does
function keepsSplit(ast: AstNode): boolean {
  switch (ast.type) {
    case "Pipe":
      return keepsSplit(ast.left) && keepsSplit(ast.right);
    case "Paren":
      return keepsSplit(ast.expr);
    case "Call":
      return SAME_NODE.has(ast.name);
    case "UpdateOp":
      return true;
    default:
      return isPathOnly(ast);
  }
}

function isSplitDoc(ast: AstNode): boolean {
  return (
    ast.type === "Call" &&
    (ast.name === "splitDoc" || ast.name === "split_doc") &&
    ast.args.length === 0
  );
}

// a node made only of path steps, whose results path() can name
function isPathOnly(ast: AstNode): boolean {
  switch (ast.type) {
    case "Identity":
    case "Recurse":
      return true;
    case "Field":
    case "Index":
    case "Slice":
    case "Iterate":
      return ast.base === undefined || isPathOnly(ast.base);
    case "Optional":
      return isPathOnly(ast.expr);
    default:
      return false;
  }
}

// the paths of a node's results from the root, as mikefarah's parent
// chain gives them: path() of a path step under the input's, the input's
// own for a replacement or a function that returns its input, and a fresh
// root for a value computed from nothing
function pathsOf(
  input: Tagged,
  ast: AstNode,
  ctx: EvalContext,
  count: number,
  state: State,
): ((string | number)[] | undefined)[] | undefined {
  const base = input.path ?? [];
  if (!isPathOnly(ast)) {
    const own = state === "computed" ? [] : base;
    return Array.from({ length: count }, () => own);
  }
  try {
    const paths = evaluate(
      input.value,
      { type: "Call", name: "path", args: [ast] },
      ctx,
    );
    if (paths.length !== count) return undefined;
    return paths.map((p) => [...base, ...(p as (string | number)[])]);
  } catch {
    return undefined;
  }
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
  return walk(
    ast,
    { value: document, state: "document", path: [] },
    { ...ctx, sourceNode: { value: document, path: [] } },
    new Map(),
  );
}

/** A document of an eval-all run: its value and where it was read. */
export interface Input {
  value: QueryValue;
  document: number;
  file: number;
  filename: string;
}

/** A result of an eval-all run and the input it came from. */
export interface InputResult extends Tagged {
  input: Input;
}

/**
 * mikefarah's eval-all: the filter runs once over the list of every
 * document of every file. A pipe hands the whole list on, `[...]` at the
 * top collects every result into one array and ireduce folds them; every
 * other node, a comma included, runs per document, as in eval. A variable holds one document at a time, where mikefarah's
 * holds the list.
 */
export function evaluateAll(
  inputs: Input[],
  ast: AstNode,
  options: EvaluateOptions,
  loads: QuerySource["loads"],
): InputResult[] {
  const optionsFor = (input: Input): EvaluateOptions => ({
    ...options,
    source: {
      document: input.document,
      file: input.file,
      filename: input.filename,
      loads,
    },
  });
  const all = (node: AstNode, from: InputResult[]): InputResult[] => {
    switch (node.type) {
      case "Pipe":
        return all(node.right, all(node.left, from));
      case "Paren":
        return all(node.expr, from);
      case "Array": {
        if (!node.elements || from.length === 0) break;
        const items = all(node.elements, from).map((r) => r.value);
        return [{ value: items, state: "computed", input: from[0].input }];
      }
      case "Call": {
        const reduce = node.args[0];
        if (node.name !== "ireduce" || reduce?.type !== "Reduce") break;
        if (from.length === 0) return [];
        // the fold over every result of its expression, from the first
        // document on
        const items = all(reduce.expr, from).map((r) => r.value);
        const folded: AstNode = {
          ...reduce,
          expr: {
            type: "Iterate",
            base: { type: "Literal", value: items },
          },
        };
        const first = from[0];
        return evaluateDocument(first.value, folded, optionsFor(first.input)).map(
          (result) => ({ ...result, state: "computed", input: first.input }),
        );
      }
    }
    return from.flatMap((item) =>
      evaluateDocumentFrom(item, node, optionsFor(item.input)),
    );
  };
  const start = inputs.map(
    (input): InputResult => ({
      value: input.value,
      state: "document",
      path: [],
      input,
    }),
  );
  return all(ast, start);
}

// one node on one result so far, in the state that result is in
function evaluateDocumentFrom(
  item: InputResult,
  ast: AstNode,
  options: EvaluateOptions,
): InputResult[] {
  const ctx = {
    ...createContext(options),
    root: item.input.value,
    currentPath: [],
    sourceNode: item,
  };
  return walk(ast, item, ctx, new Map()).map((result) => ({
    ...result,
    index:
      result.index ??
      (item.index !== undefined && result.state !== "computed"
        ? item.index
        : undefined),
    input: item.input,
  }));
}
