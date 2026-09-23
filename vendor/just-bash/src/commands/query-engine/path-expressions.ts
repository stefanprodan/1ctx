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

  /**
   * delpaths as jq's delpaths_sorted and jv_dels: the paths sorted, grouped
   * by their key at each level, a level's keys deleted together against
   * that level as it was, so negative indices, slices and repeats agree.
   */
  deleteAll(v: QueryValue, paths: readonly Path[]): QueryValue {
    for (const path of paths) checkPath(path, this.ctx);
    if (paths.length === 0) return v;
    const sorted = [...paths].sort(comparePaths);
    if (sorted[0].length === 0) return null;
    return this.deleteSorted(v, sorted, 0);
  }

  private deleteSorted(v: QueryValue, paths: Path[], at: number): QueryValue {
    const whole: PathKey[] = [];
    let result = v;
    for (let i = 0; i < paths.length; ) {
      chargeQueryWork(this.ctx);
      const key = paths[i][at];
      let j = i;
      while (j < paths.length && sameKey(key, paths[j][at])) j++;
      if (paths[i].length === at + 1) {
        // the key goes whole; deeper deletions under it do not matter
        whole.push(key);
      } else {
        const inner = stepInto(result, key);
        if (inner !== null) {
          const updated = this.deleteSorted(inner, paths.slice(i, j), at + 1);
          result = this.setFrom(result, [key], 0, updated);
        }
      }
      i = j;
    }
    return whole.length > 0 ? this.deleteKeys(result, whole) : result;
  }

  private deleteKeys(v: QueryValue, keys: PathKey[]): QueryValue {
    if (v === null) return null;
    if (Array.isArray(v)) {
      const gone = new Set<number>();
      const ranges: [number, number][] = [];
      for (const key of keys) {
        if (typeof key === "number") {
          const i = Math.trunc(key) < 0 ? v.length + Math.trunc(key) : Math.trunc(key);
          if (i >= 0) gone.add(i);
        } else if (typeof key === "string") {
          throw new Error("Cannot delete string element of array");
        } else {
          ranges.push(sliceBounds(key, v.length));
        }
      }
      chargeQueryWork(this.ctx, v.length);
      return this.fresh(
        v.filter(
          (_, i) => !gone.has(i) && !ranges.some(([s, e]) => s <= i && i < e),
        ),
      );
    }
    const obj = asQueryRecord(v);
    if (!obj) throw new Error(`Cannot delete fields from ${typeName(v)}`);
    const owned = this.own(obj);
    for (const key of keys) {
      if (typeof key !== "string") {
        throw new Error(`Cannot delete ${typeof key === "number" ? "number" : "object"} field of object`);
      }
      if (isSafeKey(key)) delete owned[key];
    }
    return owned;
  }
}

function keyRank(key: PathKey): number {
  return typeof key === "number" ? 0 : typeof key === "string" ? 1 : 2;
}

function compareKeys(a: PathKey, b: PathKey): number {
  const rank = keyRank(a) - keyRank(b);
  if (rank !== 0) return rank;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  // jq orders objects by their keys, then values: end before start
  const x = a as SliceKey;
  const y = b as SliceKey;
  return compareJq(x.end, y.end) || compareJq(x.start, y.start);
}

function comparePaths(a: Path, b: Path): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareKeys(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

function sameKey(a: PathKey, b: PathKey): boolean {
  return b !== undefined && compareKeys(a, b) === 0;
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

function children(ctx: EvalContext, v: QueryValue): Located[] {
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
  return [];
}

/**
 * An error or a break met in path mode, with the locations yielded before
 * it: jq streams its outputs, so `(.[0], error)?`, `first(f)` and a `break`
 * keep what came first. `label` is null for an error, whose `cause` it is.
 */
class PathInterrupt extends Error {
  constructor(
    readonly label: string | null,
    readonly cause: unknown,
    readonly partial: Located[],
  ) {
    super(label === null ? "path error" : `break ${label}`);
  }

  after(before: Located[], prefix: Path): PathInterrupt {
    return new PathInterrupt(this.label, this.cause, [
      ...before,
      ...this.partial.map((l) => ({ path: [...prefix, ...l.path], value: l.value })),
    ]);
  }
}

function interrupt(error: unknown, before: Located[], prefix: Path): unknown {
  if (error instanceof ExecutionLimitError) return error;
  if (error instanceof PathInterrupt) return error.after(before, prefix);
  if (error instanceof BreakError) return new PathInterrupt(error.label, null, before);
  return new PathInterrupt(null, error, before);
}

// Each located source through fn, the results prefixed by its path; when
// the sources stopped early, what they gave still goes through fn first.
function through(
  ctx: EvalContext,
  sources: () => Located[],
  fn: (source: Located) => Located[],
): Located[] {
  let bases: Located[];
  let stopped: PathInterrupt | null = null;
  try {
    bases = sources();
  } catch (error) {
    if (!(error instanceof PathInterrupt)) throw error;
    bases = error.partial;
    stopped = error;
  }
  const out: Located[] = [];
  for (const base of bases) {
    chargeQueryWork(ctx);
    try {
      prefixed(ctx, base.path, fn(base), out);
    } catch (error) {
      throw interrupt(error, out, base.path);
    }
  }
  if (stopped) throw new PathInterrupt(stopped.label, stopped.cause, out);
  return out;
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
    let next: Located[];
    try {
      next = step(entry.value).filter((c) => keep(c.value));
    } catch (error) {
      throw interrupt(error, out, entry.path);
    }
    assertQueryResultCapacity(ctx, stack.length, next.length);
    for (let i = next.length - 1; i >= 0; i--) {
      stack.push({ path: [...entry.path, ...next[i].path], value: next[i].value });
    }
  }
  return out;
}

// f? and try f: what f gave before an error, the error dropped.
function optional(fn: () => Located[]): Located[] {
  try {
    return fn();
  } catch (error) {
    if (error instanceof PathInterrupt && error.label === null) return error.partial;
    throw error;
  }
}

// The first n of fn's locations, which jq has before any later error.
function leading(fn: () => Located[], n: number): Located[] {
  try {
    return fn().slice(0, n);
  } catch (error) {
    if (error instanceof PathInterrupt && error.partial.length >= n) {
      return error.partial.slice(0, n);
    }
    throw error;
  }
}

/** Every location `ast` yields on `v`, with the value found there. */
function evaluatePaths(v: QueryValue, ast: AstNode, ctx: EvalContext): Located[] {
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
  } catch (error) {
    throw interrupt(error, [], []);
  } finally {
    ctx.budget.callDepth--;
  }
}

const HERE = (v: QueryValue): Located[] => [{ path: [], value: v }];

function pathsOf(v: QueryValue, ast: AstNode, ctx: EvalContext): Located[] {
  switch (ast.type) {
    case "Identity":
      return HERE(v);

    case "Paren":
      return evaluatePaths(v, ast.expr, ctx);

    case "Field": {
      const base = ast.base;
      return through(
        ctx,
        () => (base ? evaluatePaths(v, base, ctx) : HERE(v)),
        (b) => [{ path: [ast.name], value: stepInto(b.value, ast.name) }],
      );
    }

    case "Index": {
      const base = ast.base;
      // The index is read from the input of the whole term: .a[.i]
      const indices = evaluate(v, ast.index, ctx);
      return through(
        ctx,
        () => (base ? evaluatePaths(v, base, ctx) : HERE(v)),
        (b) =>
          indices.map((index) => {
            if (typeof index === "string" || typeof index === "number") {
              return { path: [index], value: stepInto(b.value, index) };
            }
            throw new Error(`Cannot index ${typeName(b.value)} with ${typeName(index)}`);
          }),
      );
    }

    case "Slice": {
      const base = ast.base;
      const starts = ast.start ? evaluate(v, ast.start, ctx) : [null];
      const ends = ast.end ? evaluate(v, ast.end, ctx) : [null];
      return through(
        ctx,
        () => (base ? evaluatePaths(v, base, ctx) : HERE(v)),
        (b) => {
          const out: Located[] = [];
          for (const start of starts) {
            for (const end of ends) {
              const key = sliceKey(start, end);
              push(ctx, out, { path: [key], value: stepInto(b.value, key) });
            }
          }
          return out;
        },
      );
    }

    case "Iterate": {
      const base = ast.base;
      // null iterates to nothing, as mikefarah's yq and this engine's value
      // mode do, so a stream edit skips the documents without the key; jq
      // stops on it
      return through(
        ctx,
        () => (base ? evaluatePaths(v, base, ctx) : HERE(v)),
        (b) => {
          if (b.value !== null && typeof b.value !== "object") {
            throw new Error(`Cannot iterate over ${described(b.value)}`);
          }
          return children(ctx, b.value);
        },
      );
    }

    case "Recurse":
      return recursePaths(v, (node) => children(ctx, node), () => true, ctx);

    case "Pipe":
      return through(
        ctx,
        () => evaluatePaths(v, ast.left, ctx),
        (left) => evaluatePaths(left.value, ast.right, ctx),
      );

    case "Comma": {
      const out = evaluatePaths(v, ast.left, ctx);
      let right: Located[];
      try {
        right = evaluatePaths(v, ast.right, ctx);
      } catch (error) {
        throw interrupt(error, out, []);
      }
      assertQueryResultCapacity(ctx, out.length, right.length);
      return [...out, ...right];
    }

    case "Optional":
      return optional(() => evaluatePaths(v, ast.expr, ctx));

    case "Try": {
      const handler = ast.catch;
      if (!handler) return optional(() => evaluatePaths(v, ast.body, ctx));
      try {
        return evaluatePaths(v, ast.body, ctx);
      } catch (error) {
        if (!(error instanceof PathInterrupt) || error.label !== null) throw error;
        const cause = error.cause;
        const message = cause instanceof Error ? cause.message : String(cause);
        const handled = evaluate(message, handler, ctx);
        if (handled.length > 0) throw invalidPath(handled[0]);
        return error.partial;
      }
    }

    case "Cond":
      return through(
        ctx,
        () => evaluate(v, ast.cond, ctx).map((cond) => ({ path: [], value: cond })),
        ({ value: cond }) => {
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
          return evaluatePaths(v, branch, ctx);
        },
      );

    case "BinaryOp": {
      if (ast.op !== "//") break;
      const lefts = optional(() => evaluatePaths(v, ast.left, ctx)).filter((l) =>
        isTruthy(l.value),
      );
      return lefts.length > 0 ? lefts : evaluatePaths(v, ast.right, ctx);
    }

    case "VarBind":
      return through(
        ctx,
        () => evaluate(v, ast.value, ctx).map((bound) => ({ path: [], value: bound })),
        ({ value: bound }) => {
          const patterns: DestructurePattern[] = [];
          if (ast.pattern) patterns.push(ast.pattern);
          else if (ast.name) patterns.push({ type: "var", name: ast.name });
          if (ast.alternatives) patterns.push(...ast.alternatives);
          for (const pattern of patterns) {
            const next = bindPattern(ctx, pattern, bound);
            if (next !== null) return evaluatePaths(v, ast.body, next);
          }
          return [];
        },
      );

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
        if (error instanceof PathInterrupt && error.label === ast.name) {
          return error.partial;
        }
        throw error;
      }
    }

    case "Break":
      throw new PathInterrupt(ast.name, null, []);

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
  if (selector && args.length === 0) return selector(v) ? HERE(v) : [];

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
      return recursePaths(v, (node) => children(ctx, node), () => true, ctx);
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
      return leading(() => evaluatePaths(v, args[0], ctx), 1);
    case "last/1":
      return evaluatePaths(v, args[0], ctx).slice(-1);
    case "limit/2": {
      const out: Located[] = [];
      for (const n of indexArg(v, args[0], ctx)) {
        if (n > 0) prefixed(ctx, [], leading(() => evaluatePaths(v, args[1], ctx), n), out);
      }
      return out;
    }
    case "nth/2": {
      const out: Located[] = [];
      for (const n of indexArg(v, args[0], ctx)) {
        if (n < 0) throw new Error("Out of bounds negative array index");
        const found = leading(() => evaluatePaths(v, args[1], ctx), n + 1);
        if (n < found.length) push(ctx, out, found[n]);
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
      return HERE(v);
    default:
      break;
  }

  // A function the query defined: its body in path mode. A filter argument
  // is closed over the caller's functions, so `def f(g): g; f(.a) = 1`
  // reaches .a; a `$x` argument runs the body once per value, bound as $x
  // and as x, as jq defines it.
  const funcKey = `${name}/${args.length}`;
  const userFunc = ctx.funcs?.get(funcKey);
  if (!userFunc) return null;
  const funcs = new Map(userFunc.closure ?? ctx.funcs ?? new Map());
  funcs.set(funcKey, userFunc);
  const values: { name: string; values: QueryValue[] }[] = [];
  for (let i = 0; i < userFunc.params.length; i++) {
    const param = userFunc.params[i];
    if (param.startsWith("$")) {
      values.push({ name: param, values: evaluate(v, args[i], ctx) });
    } else {
      funcs.set(`${param}/0`, {
        params: [],
        body: args[i],
        closure: new Map(ctx.funcs ?? []),
      });
    }
  }
  const bind = (at: number, inner: EvalContext): Located[] => {
    if (at === values.length) return evaluatePaths(v, userFunc.body, inner);
    const { name: param, values: choices } = values[at];
    return through(
      ctx,
      () => choices.map((value) => ({ path: [], value })),
      ({ value }) => {
        const scoped = new Map(inner.funcs ?? []);
        scoped.set(`${param.slice(1)}/0`, {
          params: [],
          body: { type: "Literal", value },
        });
        const next = bindPattern(
          { ...inner, funcs: scoped },
          { type: "var", name: param },
          value,
        );
        return bind(at + 1, next ?? inner);
      },
    );
  };
  return bind(0, { ...ctx, funcs } as EvalContext);
}

/** The located values `f` yields, an error or a stray break as jq's. */
function located(v: QueryValue, ast: AstNode, ctx: EvalContext): Located[] {
  try {
    return evaluatePaths(v, ast, ctx);
  } catch (error) {
    if (!(error instanceof PathInterrupt)) throw error;
    if (error.label !== null) throw new BreakError(error.label);
    throw error.cause;
  }
}

/** The paths `f` yields on `v`, as `path(f)` outputs them. */
export function pathsFor(v: QueryValue, ast: AstNode, ctx: EvalContext): Path[] {
  return located(v, ast, ctx).map((l) => l.path);
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
