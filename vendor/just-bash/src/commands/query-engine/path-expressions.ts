/**
 * Path expressions, as jq defines them (1ctx)
 *
 * jq's assignments, `path()`, `del()`, `pick()` and `paths` all rest on one
 * idea: a filter run in path mode yields the location of each value it would
 * output, and the operators are built from `getpath`, `setpath` and
 * `delpaths` over those locations:
 *
 *   lhs = $v      reduce path(lhs) as $p (.; setpath($p; $v))
 *   lhs |= f      each path set to the first output of f, deleted when f
 *                 has none, the deletions applied last
 *   lhs op= rhs   rhs as $x | lhs |= . op $x
 *   del(f)        delpaths([path(f)])
 *
 * Upstream guessed paths from the shape of the AST, which dropped `select`,
 * the left side of a pipe, `,`, `//`, `if` and every function call, and
 * assigned to the wrong value without an error. This module evaluates them.
 */

import { ExecutionLimitError } from "../../interpreter/errors.js";
import {
  assertQueryResultCapacity,
  BreakError,
  bindPattern,
  chargeQueryWork,
  type EvalContext,
  evalBinaryOp,
  evaluate,
} from "./evaluator.js";
import type { AstNode, DestructurePattern } from "./parser.js";
import { asQueryRecord, isSafeKey, safeSet } from "./safe-object.js";
import { compareJq, isTruthy, type QueryValue } from "./value-operations.js";

/** A slice component, `{"start": s, "end": e}`, as jq prints it. */
export type SliceKey = { start: QueryValue; end: QueryValue };
export type PathKey = string | number | SliceKey;
export type Path = PathKey[];
type Located = { path: Path; value: QueryValue };

const IDENTITY: AstNode = { type: "Identity" };

function typeName(v: QueryValue): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// jq prints a value in an error cut to 30 bytes: "Cannot index number with..."
function brief(v: QueryValue): string {
  const text = JSON.stringify(v) ?? "null";
  return text.length > 29 ? `${text.slice(0, 26)}...` : text;
}

function described(v: QueryValue): string {
  return `${typeName(v)} (${brief(v)})`;
}

function isSliceKey(key: unknown): key is SliceKey {
  const rec = asQueryRecord(key);
  return rec !== null && Object.hasOwn(rec, "start") && Object.hasOwn(rec, "end");
}

function sliceKey(start: QueryValue, end: QueryValue): SliceKey {
  const key = Object.create(null) as SliceKey;
  key.start = start;
  key.end = end;
  return key;
}

function invalidPath(result: QueryValue): Error {
  return new Error(`Invalid path expression with result ${brief(result)}`);
}

// jq's slice bounds: floor the start, ceil the end, negative from the end,
// clamped to the length.
function sliceBounds(key: SliceKey, length: number): [number, number] {
  const bound = (v: QueryValue, fallback: number, round: (n: number) => number) => {
    if (v === null) return fallback;
    if (typeof v !== "number") {
      throw new Error("Start and end indices of an array slice must be numbers");
    }
    const n = Number.isNaN(v) ? fallback : round(v);
    const i = n < 0 ? length + n : n;
    return Math.min(Math.max(i, 0), length);
  };
  const start = bound(key.start, 0, Math.floor);
  const end = bound(key.end, length, Math.ceil);
  return [start, Math.max(start, end)];
}

/**
 * The value one step down, as a path expression reads it: a missing key or
 * index is null, a key of the wrong type is jq's error.
 */
export function stepInto(v: QueryValue, key: PathKey): QueryValue {
  if (typeof key === "string") {
    if (v === null) return null;
    const obj = asQueryRecord(v);
    if (!obj) {
      throw new Error(`Cannot index ${typeName(v)} with string (${brief(key)})`);
    }
    return Object.hasOwn(obj, key) ? (obj[key] as QueryValue) : null;
  }
  if (typeof key === "number") {
    if (v === null) return null;
    if (!Array.isArray(v)) {
      throw new Error(`Cannot index ${typeName(v)} with number (${brief(key)})`);
    }
    if (Number.isNaN(key)) return null;
    const i = Math.trunc(key) < 0 ? v.length + Math.trunc(key) : Math.trunc(key);
    return i >= 0 && i < v.length ? v[i] : null;
  }
  if (v === null) return null;
  if (typeof v === "string") {
    const chars = Array.from(v);
    const [start, end] = sliceBounds(key, chars.length);
    return chars.slice(start, end).join("");
  }
  if (!Array.isArray(v)) {
    throw new Error(`Cannot index ${typeName(v)} with object`);
  }
  const [start, end] = sliceBounds(key, v.length);
  return v.slice(start, end);
}

/** getpath: null past a missing key, jq's error past a scalar. */
export function getAt(v: QueryValue, path: readonly PathKey[]): QueryValue {
  let current = v;
  for (const key of path) {
    if (current === null) return null;
    current = stepInto(current, key);
  }
  return current;
}

function checkPath(path: unknown, ctx: EvalContext): Path {
  if (!Array.isArray(path)) throw new Error("Path must be specified as an array");
  if (path.length > ctx.limits.maxDepth) {
    throw new ExecutionLimitError(
      `query depth limit exceeded (${ctx.limits.maxDepth})`,
      "recursion",
    );
  }
  for (const key of path) {
    if (typeof key !== "string" && typeof key !== "number" && !isSliceKey(key)) {
      throw new Error("Path must be specified as an array of strings, numbers or slices");
    }
  }
  return path as Path;
}

/**
 * Copies containers on first write and mutates the copies after, so a run of
 * setpath or delpaths over one value costs its size, not its size per path.
 */
export class PathWriter {
  private readonly owned = new WeakSet<object>();

  /** `setpath` reports an index past the limit as upstream's builtin does. */
  constructor(
    private readonly ctx: EvalContext,
    private readonly builtin = false,
  ) {}

  private own<T extends object>(v: T): T {
    if (this.owned.has(v)) return v;
    const copy = (
      Array.isArray(v) ? [...v] : Object.assign(Object.create(null), v)
    ) as T;
    this.owned.add(copy);
    return copy;
  }

  private fresh<T extends object>(v: T): T {
    this.owned.add(v);
    return v;
  }

  /**
   * An update may place a copy this writer owns in more than one spot
   * (`{b: .b, c: .b}`), and a later write in place would show in both, so
   * the copies inside a replaced value are given up. Only owned containers
   * hold owned ones, which keeps this to what the writer copied.
   */
  release(v: QueryValue): void {
    const stack: QueryValue[] = [v];
    while (stack.length > 0) {
      const next = stack.pop();
      if (next === null || typeof next !== "object" || !this.owned.has(next)) {
        continue;
      }
      chargeQueryWork(this.ctx);
      this.owned.delete(next);
      for (const child of Array.isArray(next) ? next : Object.values(next)) {
        stack.push(child as QueryValue);
      }
    }
  }

  set(v: QueryValue, path: readonly PathKey[], newVal: QueryValue): QueryValue {
    checkPath(path, this.ctx);
    // Arrays a path could grow, together, stay inside the element limit.
    const max = this.ctx.limits.maxArrayElements;
    let allocation = 0;
    for (const key of path) {
      if (typeof key !== "number" || !(key >= 0) || !Number.isFinite(key)) {
        continue;
      }
      if (Math.trunc(key) >= max) {
        if (!this.builtin) assertQueryResultCapacity(this.ctx, 0, key + 1);
        throw new ExecutionLimitError(
          `query array index limit exceeded (${max})`,
          "array_elements",
        );
      }
      if (allocation > max - (Math.trunc(key) + 1)) {
        throw new ExecutionLimitError(
          `query cumulative array allocation limit exceeded (${max})`,
          "array_elements",
        );
      }
      allocation += Math.trunc(key) + 1;
    }
    return this.setFrom(v, path, 0, newVal);
  }

  private setFrom(
    v: QueryValue,
    path: readonly PathKey[],
    at: number,
    newVal: QueryValue,
  ): QueryValue {
    chargeQueryWork(this.ctx);
    if (at === path.length) return newVal;
    const key = path[at];
    if (typeof key === "string") {
      if (v !== null && !asQueryRecord(v)) {
        throw new Error(`Cannot index ${typeName(v)} with string (${brief(key)})`);
      }
      // Prototype keys are never written, as everywhere in this engine.
      if (!isSafeKey(key)) return v ?? this.fresh(Object.create(null));
      const obj =
        v === null
          ? this.fresh(Object.create(null) as Record<string, QueryValue>)
          : this.own(v as Record<string, QueryValue>);
      const current = Object.hasOwn(obj, key) ? obj[key] : null;
      safeSet(obj, key, this.setFrom(current, path, at + 1, newVal));
      return obj;
    }
    if (typeof key === "number") {
      if (v !== null && !Array.isArray(v)) {
        throw new Error(`Cannot index ${typeName(v)} with number (${brief(key)})`);
      }
      if (Number.isNaN(key)) throw new Error("Cannot set array element at NaN index");
      if (!Number.isFinite(key)) throw new Error("array index must be finite");
      const length = Array.isArray(v) ? v.length : 0;
      let i = Math.trunc(key);
      if (i < 0) {
        i += length;
        if (i < 0) throw new Error("Out of bounds negative array index");
      }
      assertQueryResultCapacity(this.ctx, 0, i + 1);
      const arr = v === null ? this.fresh([] as QueryValue[]) : this.own(v as QueryValue[]);
      if (i >= arr.length) {
        chargeQueryWork(this.ctx, i + 1 - arr.length);
        while (arr.length < i) arr.push(null);
        arr.push(null);
      }
      arr[i] = this.setFrom(arr[i], path, at + 1, newVal);
      return arr;
    }
    if (typeof v === "string") throw new Error("Cannot update string slices");
    if (v !== null && !Array.isArray(v)) {
      throw new Error(`Cannot update field at object index of ${typeName(v)}`);
    }
    const arr = (v ?? []) as QueryValue[];
    const [start, end] = sliceBounds(key, arr.length);
    const replaced = this.setFrom(arr.slice(start, end), path, at + 1, newVal);
    if (!Array.isArray(replaced)) {
      throw new Error("A slice of an array can only be assigned another array");
    }
    assertQueryResultCapacity(
      this.ctx,
      arr.length - (end - start),
      replaced.length,
    );
    return this.fresh([...arr.slice(0, start), ...replaced, ...arr.slice(end)]);
  }

  /** delpaths: every path read against the input, the last in jq's order first. */
  deleteAll(v: QueryValue, paths: readonly Path[]): QueryValue {
    const sorted = [...paths].sort((a, b) => compareJq(a, b));
    let result = v;
    for (let i = sorted.length - 1; i >= 0; i--) {
      checkPath(sorted[i], this.ctx);
      result = this.deleteFrom(result, sorted[i], 0);
    }
    return result;
  }

  private deleteFrom(v: QueryValue, path: readonly PathKey[], at: number): QueryValue {
    chargeQueryWork(this.ctx);
    if (path.length === 0) return null;
    if (v === null) return null;
    const key = path[at];
    const last = at === path.length - 1;
    if (typeof key === "string") {
      const obj = asQueryRecord(v);
      if (!obj) {
        throw new Error(
          Array.isArray(v)
            ? "Cannot delete string element of array"
            : `Cannot delete fields from ${typeName(v)}`,
        );
      }
      if (!Object.hasOwn(obj, key) || !isSafeKey(key)) return v;
      const owned = this.own(obj);
      if (last) delete owned[key];
      else owned[key] = this.deleteFrom(owned[key] as QueryValue, path, at + 1);
      return owned;
    }
    if (typeof key === "number") {
      if (!Array.isArray(v)) {
        throw new Error(
          asQueryRecord(v)
            ? "Cannot delete number field of object"
            : `Cannot delete fields from ${typeName(v)}`,
        );
      }
      const i = Math.trunc(key) < 0 ? v.length + Math.trunc(key) : Math.trunc(key);
      if (i < 0 || i >= v.length) {
        if (i < 0 && last) throw new Error("Out of bounds negative array index");
        return v;
      }
      const owned = this.own(v);
      if (last) owned.splice(i, 1);
      else owned[i] = this.deleteFrom(owned[i], path, at + 1);
      return owned;
    }
    if (!Array.isArray(v)) {
      throw new Error(`Cannot delete slice of ${typeName(v)}`);
    }
    const [start, end] = sliceBounds(key, v.length);
    if (last) {
      const owned = this.own(v);
      owned.splice(start, end - start);
      return owned;
    }
    const inner = this.deleteFrom(v.slice(start, end), path, at + 1);
    if (!Array.isArray(inner)) {
      throw new Error("A slice of an array can only be assigned another array");
    }
    return this.fresh([...v.slice(0, start), ...inner, ...v.slice(end)]);
  }
}

const TYPE_SELECTORS: Record<string, (v: QueryValue) => boolean> = Object.assign(
  Object.create(null),
  {
    arrays: (v: QueryValue) => Array.isArray(v),
    objects: (v: QueryValue) => asQueryRecord(v) !== null,
    iterables: (v: QueryValue) => v !== null && typeof v === "object",
    booleans: (v: QueryValue) => typeof v === "boolean",
    numbers: (v: QueryValue) => typeof v === "number",
    strings: (v: QueryValue) => typeof v === "string",
    nulls: (v: QueryValue) => v === null,
    values: (v: QueryValue) => v !== null,
    scalars: (v: QueryValue) => v === null || typeof v !== "object",
  },
);

function push(ctx: EvalContext, out: Located[], item: Located): void {
  if (item.path.length > ctx.limits.maxDepth) {
    throw new ExecutionLimitError(
      `query depth limit exceeded (${ctx.limits.maxDepth})`,
      "recursion",
    );
  }
  assertQueryResultCapacity(ctx, out.length);
  out.push(item);
}

function prefixed(ctx: EvalContext, prefix: Path, items: Located[], out: Located[]): void {
  assertQueryResultCapacity(ctx, out.length, items.length);
  for (const item of items) push(ctx, out, { path: [...prefix, ...item.path], value: item.value });
}

function children(ctx: EvalContext, v: QueryValue, strict: boolean): Located[] {
  if (Array.isArray(v)) {
    assertQueryResultCapacity(ctx, 0, v.length);
    return v.map((value, index) => ({ path: [index], value }));
  }
  const obj = asQueryRecord(v);
  if (obj) {
    const keys = Object.keys(obj);
    assertQueryResultCapacity(ctx, 0, keys.length);
    return keys.map((key) => ({ path: [key], value: obj[key] as QueryValue }));
  }
  if (strict) throw new Error(`Cannot iterate over ${described(v)}`);
  return [];
}

// recurse(f; cond): ., (f | select(cond) | recurse(f; cond)), depth first.
function recursePaths(
  v: QueryValue,
  step: (node: QueryValue) => Located[],
  keep: (node: QueryValue) => boolean,
  ctx: EvalContext,
): Located[] {
  const out: Located[] = [];
  const stack: Located[] = [{ path: [], value: v }];
  while (stack.length > 0) {
    const entry = stack.pop() as Located;
    chargeQueryWork(ctx);
    push(ctx, out, entry);
    const next = step(entry.value).filter((c) => keep(c.value));
    assertQueryResultCapacity(ctx, stack.length, next.length);
    for (let i = next.length - 1; i >= 0; i--) {
      stack.push({ path: [...entry.path, ...next[i].path], value: next[i].value });
    }
  }
  return out;
}

function optional(fn: () => Located[]): Located[] {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ExecutionLimitError || error instanceof BreakError) throw error;
    return [];
  }
}

/** Every location `ast` yields on `v`, with the value found there. */
export function evaluatePaths(v: QueryValue, ast: AstNode, ctx: EvalContext): Located[] {
  chargeQueryWork(ctx);
  ctx.budget.callDepth++;
  if (ctx.budget.callDepth > ctx.limits.maxDepth) {
    ctx.budget.callDepth--;
    throw new ExecutionLimitError(
      `query depth limit exceeded (${ctx.limits.maxDepth})`,
      "recursion",
    );
  }
  try {
    return pathsOf(v, ast, ctx);
  } finally {
    ctx.budget.callDepth--;
  }
}

function each(
  ctx: EvalContext,
  bases: Located[],
  fn: (base: Located) => Located[],
): Located[] {
  const out: Located[] = [];
  for (const base of bases) {
    chargeQueryWork(ctx);
    prefixed(ctx, base.path, fn(base), out);
  }
  return out;
}

function pathsOf(v: QueryValue, ast: AstNode, ctx: EvalContext): Located[] {
  switch (ast.type) {
    case "Identity":
      return [{ path: [], value: v }];

    case "Paren":
      return evaluatePaths(v, ast.expr, ctx);

    case "Field": {
      const bases = ast.base ? evaluatePaths(v, ast.base, ctx) : [{ path: [], value: v }];
      return each(ctx, bases, (b) => [
        { path: [ast.name], value: stepInto(b.value, ast.name) },
      ]);
    }

    case "Index": {
      const bases = ast.base ? evaluatePaths(v, ast.base, ctx) : [{ path: [], value: v }];
      // The index is read from the input of the whole term: .a[.i]
      const indices = evaluate(v, ast.index, ctx);
      return each(ctx, bases, (b) =>
        indices.map((index) => {
          if (typeof index === "string" || typeof index === "number") {
            return { path: [index], value: stepInto(b.value, index) };
          }
          if (index === null && b.value === null) {
            return { path: [null as unknown as PathKey], value: null };
          }
          throw new Error(`Cannot index ${typeName(b.value)} with ${typeName(index)}`);
        }),
      );
    }

    case "Slice": {
      const bases = ast.base ? evaluatePaths(v, ast.base, ctx) : [{ path: [], value: v }];
      const starts = ast.start ? evaluate(v, ast.start, ctx) : [null];
      const ends = ast.end ? evaluate(v, ast.end, ctx) : [null];
      return each(ctx, bases, (b) => {
        const out: Located[] = [];
        for (const start of starts) {
          for (const end of ends) {
            const key = sliceKey(start, end);
            push(ctx, out, { path: [key], value: stepInto(b.value, key) });
          }
        }
        return out;
      });
    }

    case "Iterate": {
      const bases = ast.base ? evaluatePaths(v, ast.base, ctx) : [{ path: [], value: v }];
      return each(ctx, bases, (b) => children(ctx, b.value, true));
    }

    case "Recurse":
      return recursePaths(v, (node) => children(ctx, node, false), () => true, ctx);

    case "Pipe": {
      const lefts = evaluatePaths(v, ast.left, ctx);
      const out: Located[] = [];
      for (const left of lefts) {
        try {
          prefixed(ctx, left.path, evaluatePaths(left.value, ast.right, ctx), out);
        } catch (error) {
          if (error instanceof PathBreak) throw error.withPrepended(out);
          throw error;
        }
      }
      return out;
    }

    case "Comma": {
      const out = evaluatePaths(v, ast.left, ctx);
      let right: Located[];
      try {
        right = evaluatePaths(v, ast.right, ctx);
      } catch (error) {
        if (error instanceof PathBreak) throw error.withPrepended(out);
        throw error;
      }
      assertQueryResultCapacity(ctx, out.length, right.length);
      return [...out, ...right];
    }

    case "Optional":
      return optional(() => evaluatePaths(v, ast.expr, ctx));

    case "Try": {
      if (!ast.catch) return optional(() => evaluatePaths(v, ast.body, ctx));
      try {
        return evaluatePaths(v, ast.body, ctx);
      } catch (error) {
        if (error instanceof ExecutionLimitError || error instanceof PathBreak) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const handled = evaluate(message, ast.catch, ctx);
        if (handled.length === 0) return [];
        throw invalidPath(handled[0]);
      }
    }

    case "Cond": {
      const out: Located[] = [];
      for (const cond of evaluate(v, ast.cond, ctx)) {
        let branch: AstNode = ast.else ?? IDENTITY;
        if (isTruthy(cond)) branch = ast.then;
        else {
          for (const elif of ast.elifs) {
            if (evaluate(v, elif.cond, ctx).some(isTruthy)) {
              branch = elif.then;
              break;
            }
          }
        }
        prefixed(ctx, [], evaluatePaths(v, branch, ctx), out);
      }
      return out;
    }

    case "BinaryOp": {
      if (ast.op !== "//") break;
      const lefts = optional(() => evaluatePaths(v, ast.left, ctx)).filter((l) =>
        isTruthy(l.value),
      );
      return lefts.length > 0 ? lefts : evaluatePaths(v, ast.right, ctx);
    }

    case "VarBind": {
      const out: Located[] = [];
      for (const bound of evaluate(v, ast.value, ctx)) {
        const patterns: DestructurePattern[] = [];
        if (ast.pattern) patterns.push(ast.pattern);
        else if (ast.name) patterns.push({ type: "var", name: ast.name });
        if (ast.alternatives) patterns.push(...ast.alternatives);
        let next: EvalContext | null = null;
        for (const pattern of patterns) {
          next = bindPattern(ctx, pattern, bound);
          if (next !== null) break;
        }
        if (next === null) continue;
        prefixed(ctx, [], evaluatePaths(v, ast.body, next), out);
      }
      return out;
    }

    case "Def": {
      const funcs = new Map(ctx.funcs ?? []);
      funcs.set(`${ast.name}/${ast.params.length}`, {
        params: ast.params,
        body: ast.funcBody,
        closure: new Map(ctx.funcs ?? []),
      });
      return evaluatePaths(v, ast.body, { ...ctx, funcs });
    }

    case "Label": {
      try {
        return evaluatePaths(v, ast.body, {
          ...ctx,
          labels: new Set([...(ctx.labels ?? []), ast.name]),
        });
      } catch (error) {
        if (error instanceof PathBreak && error.label === ast.name) return error.partial;
        throw error;
      }
    }

    case "Break":
      throw new PathBreak(ast.name);

    case "Call": {
      const called = callPaths(v, ast.name, ast.args, ctx);
      if (called !== null) return called;
      break;
    }

    default:
      break;
  }
  // Not a path expression: jq names the first value it would have output.
  const results = evaluate(v, ast, ctx);
  if (results.length === 0) return [];
  throw invalidPath(results[0]);
}

/** A break seen in path mode, carrying the locations yielded before it. */
class PathBreak extends Error {
  constructor(
    readonly label: string,
    readonly partial: Located[] = [],
  ) {
    super(`break ${label}`);
  }

  withPrepended(items: Located[]): PathBreak {
    return new PathBreak(this.label, [...items, ...this.partial]);
  }
}

function indexArg(v: QueryValue, arg: AstNode, ctx: EvalContext): number[] {
  return evaluate(v, arg, ctx).map((n) => {
    if (typeof n !== "number") throw new Error("Cannot index array with non-number");
    return n;
  });
}

function callPaths(
  v: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext,
): Located[] | null {
  const selector = TYPE_SELECTORS[name];
  if (selector && args.length === 0) return selector(v) ? [{ path: [], value: v }] : [];

  switch (`${name}/${args.length}`) {
    case "empty/0":
      return [];
    case "select/1": {
      const out: Located[] = [];
      for (const c of evaluate(v, args[0], ctx)) {
        if (isTruthy(c)) push(ctx, out, { path: [], value: v });
      }
      return out;
    }
    case "recurse/0":
      return recursePaths(v, (node) => children(ctx, node, false), () => true, ctx);
    case "recurse/1":
      return recursePaths(v, (node) => evaluatePaths(node, args[0], ctx), () => true, ctx);
    case "recurse/2":
      return recursePaths(
        v,
        (node) => evaluatePaths(node, args[0], ctx),
        (node) => evaluate(node, args[1], ctx).some(isTruthy),
        ctx,
      );
    case "first/0":
      return [{ path: [0], value: stepInto(v, 0) }];
    case "last/0":
      return [{ path: [-1], value: stepInto(v, -1) }];
    case "nth/1":
      return indexArg(v, args[0], ctx).map((n) => ({ path: [n], value: stepInto(v, n) }));
    case "first/1":
      return evaluatePaths(v, args[0], ctx).slice(0, 1);
    case "last/1":
      return evaluatePaths(v, args[0], ctx).slice(-1);
    case "limit/2": {
      const out: Located[] = [];
      for (const n of indexArg(v, args[0], ctx)) {
        if (n > 0) prefixed(ctx, [], evaluatePaths(v, args[1], ctx).slice(0, n), out);
      }
      return out;
    }
    case "nth/2": {
      const out: Located[] = [];
      const all = evaluatePaths(v, args[1], ctx);
      for (const n of indexArg(v, args[0], ctx)) {
        if (n < 0) throw new Error("Out of bounds negative array index");
        if (n < all.length) push(ctx, out, all[n]);
      }
      return out;
    }
    case "getpath/1": {
      const out: Located[] = [];
      for (const p of evaluate(v, args[0], ctx)) {
        const path = checkPath(p, ctx);
        push(ctx, out, { path: [...path], value: getAt(v, path) });
      }
      return out;
    }
    case "debug/0":
    case "debug/1":
    case "stderr/0":
      evaluate(v, { type: "Call", name, args }, ctx);
      return [{ path: [], value: v }];
    default:
      break;
  }

  // A function the query defined: its body in path mode, each argument a
  // filter closed over the caller's functions, so `def f(g): g; f(.a) = 1`
  // reaches .a as in jq.
  const funcKey = `${name}/${args.length}`;
  const userFunc = ctx.funcs?.get(funcKey);
  if (!userFunc) return null;
  const funcs = new Map(userFunc.closure ?? ctx.funcs ?? new Map());
  funcs.set(funcKey, userFunc);
  for (let i = 0; i < userFunc.params.length; i++) {
    funcs.set(`${userFunc.params[i]}/0`, {
      params: [],
      body: args[i],
      closure: new Map(ctx.funcs ?? []),
    });
  }
  return evaluatePaths(v, userFunc.body, { ...ctx, funcs } as EvalContext);
}

/** The paths `f` yields on `v`, as `path(f)` outputs them. */
export function pathsFor(v: QueryValue, ast: AstNode, ctx: EvalContext): Path[] {
  return evaluatePaths(v, ast, ctx).map((located) => located.path);
}

/** `lhs |= f`, with `update` standing in for f. */
function modify(
  root: QueryValue,
  paths: readonly Path[],
  update: (current: QueryValue) => QueryValue[],
  ctx: EvalContext,
): QueryValue {
  const writer = new PathWriter(ctx);
  const deletions: Path[] = [];
  let result = root;
  for (const path of paths) {
    const current = getAt(result, path);
    const next = update(current);
    if (next.length === 0) deletions.push(path);
    else {
      if (next[0] !== current) writer.release(current);
      result = writer.set(result, path, next[0]);
    }
  }
  return deletions.length > 0 ? writer.deleteAll(result, deletions) : result;
}

const ARITHMETIC: Record<string, string> = Object.assign(Object.create(null), {
  "+=": "+",
  "-=": "-",
  "*=": "*",
  "/=": "/",
  "%=": "%",
  "//=": "//",
});

/** Every output of `lhs op rhs` on `root`. */
export function applyAssignment(
  root: QueryValue,
  lhs: AstNode,
  op: string,
  rhs: AstNode,
  ctx: EvalContext,
): QueryValue[] {
  if (op === "|=") {
    const paths = pathsFor(root, lhs, ctx);
    return [modify(root, paths, (current) => evaluate(current, rhs, ctx), ctx)];
  }
  const values = evaluate(root, rhs, ctx);
  if (values.length === 0) return [];
  const paths = pathsFor(root, lhs, ctx);
  const out: QueryValue[] = [];
  for (const x of values) {
    chargeQueryWork(ctx);
    if (op === "=") {
      const writer = new PathWriter(ctx);
      let result = root;
      for (const path of paths) result = writer.set(result, path, x);
      out.push(result);
      continue;
    }
    const binary = ARITHMETIC[op];
    if (!binary) throw new Error(`Unknown assignment operator ${op}`);
    const operand: AstNode = { type: "Literal", value: x };
    out.push(
      modify(
        root,
        paths,
        (current) => evalBinaryOp(current, binary, IDENTITY, operand, ctx).slice(0, 1),
        ctx,
      ),
    );
  }
  return out;
}

/** del(f) */
export function deletePaths(root: QueryValue, f: AstNode, ctx: EvalContext): QueryValue {
  return new PathWriter(ctx).deleteAll(root, pathsFor(root, f, ctx));
}

/** delpaths(ps) */
export function deletePathList(root: QueryValue, paths: QueryValue, ctx: EvalContext): QueryValue {
  if (!Array.isArray(paths)) throw new Error("Paths must be specified as an array");
  return new PathWriter(ctx).deleteAll(
    root,
    paths.map((p) => checkPath(p, ctx)),
  );
}

/** setpath(p; v) */
export function setPathValue(
  root: QueryValue,
  path: QueryValue,
  value: QueryValue,
  ctx: EvalContext,
): QueryValue {
  return new PathWriter(ctx, true).set(root, checkPath(path, ctx), value);
}

/** pick(f): null with only the paths f yields, taken from the input. */
export function pickPaths(root: QueryValue, f: AstNode, ctx: EvalContext): QueryValue {
  const writer = new PathWriter(ctx);
  let result: QueryValue = null;
  for (const path of pathsFor(root, f, ctx)) {
    result = writer.set(result, path, getAt(root, path));
  }
  return result;
}
