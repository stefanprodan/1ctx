/**
 * Path-related jq builtins
 *
 * Handles path manipulation functions like getpath, setpath, delpaths, paths, etc.
 */

import { ExecutionLimitError } from "../../../interpreter/errors.js";
import {
  assertQueryResultCapacity,
  chargeQueryWork,
  type EvalContext,
} from "../evaluator.js";
import type { AstNode } from "../parser.js";
import {
  deletePathList,
  deletePaths,
  getAt,
  pathsFor,
  pickPaths,
  setPathValue,
} from "../path-expressions.js";
import { asQueryRecord } from "../safe-object.js";
import type { QueryValue } from "../value-operations.js";

type EvalFn = (
  value: QueryValue,
  ast: AstNode,
  ctx: EvalContext,
) => QueryValue[];

type IsTruthyFn = (v: QueryValue) => boolean;

function collectContainerPaths(
  value: QueryValue,
  ctx: EvalContext,
  leavesOnly: boolean,
): (string | number)[][] {
  const paths: (string | number)[][] = [];
  const stack: Array<{
    value: QueryValue;
    path: (string | number)[];
    isRoot: boolean;
  }> = [{ value, path: [], isRoot: true }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    chargeQueryWork(ctx);
    if (entry.path.length > ctx.limits.maxDepth) {
      throw new ExecutionLimitError(
        `query depth limit exceeded (${ctx.limits.maxDepth})`,
        "recursion",
      );
    }
    const isContainer = entry.value !== null && typeof entry.value === "object";
    if (!isContainer) {
      if (leavesOnly || !entry.isRoot) {
        assertQueryResultCapacity(ctx, paths.length);
        paths.push(entry.path);
      }
      continue;
    }
    if (!leavesOnly && !entry.isRoot) {
      assertQueryResultCapacity(ctx, paths.length);
      paths.push(entry.path);
    }
    const children: Array<readonly [string | number, QueryValue]> =
      Array.isArray(entry.value)
        ? entry.value.map((child, index) => [index, child] as const)
        : Object.keys(entry.value as Record<string, QueryValue>).map(
            (key) =>
              [
                key,
                // @banned-pattern-ignore: Object.keys returns own properties only
                (entry.value as Record<string, QueryValue>)[key],
              ] as const,
          );
    assertQueryResultCapacity(
      ctx,
      paths.length,
      stack.length + children.length,
    );
    for (let index = children.length - 1; index >= 0; index--) {
      const [key, child] = children[index];
      const childPath = [...entry.path, key];
      stack.push({ value: child, path: childPath, isRoot: false });
    }
  }
  return paths;
}

/**
 * Handle path builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not a path builtin handled here.
 */
export function evalPathBuiltin(
  value: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext,
  evaluate: EvalFn,
  isTruthy: IsTruthyFn,
): QueryValue[] | null {
  // getpath, setpath, delpaths, path, del and pick go through
  // path-expressions.ts, jq's own definitions (1ctx)
  switch (name) {
    case "getpath": {
      if (args.length === 0) return [null];
      return evaluate(value, args[0], ctx).map((path) => {
        if (!Array.isArray(path)) {
          throw new Error("Path must be specified as an array");
        }
        return getAt(value, path);
      });
    }

    case "setpath": {
      if (args.length < 2) return [null];
      const out: QueryValue[] = [];
      for (const path of evaluate(value, args[0], ctx)) {
        for (const newVal of evaluate(value, args[1], ctx)) {
          assertQueryResultCapacity(ctx, out.length);
          out.push(setPathValue(value, path, newVal, ctx));
        }
      }
      return out;
    }

    case "delpaths": {
      if (args.length === 0) return [value];
      return evaluate(value, args[0], ctx).map((paths) =>
        deletePathList(value, paths, ctx),
      );
    }

    case "path": {
      if (args.length === 0) return [[]];
      return pathsFor(value, args[0], ctx);
    }

    case "del": {
      if (args.length === 0) return [value];
      return [deletePaths(value, args[0], ctx)];
    }

    case "pick": {
      if (args.length === 0) return [null];
      return [pickPaths(value, args[0], ctx)];
    }

    case "paths": {
      const paths = collectContainerPaths(value, ctx, false);
      if (args.length > 0) {
        return paths.filter((p) => {
          let v: QueryValue = value;
          for (const k of p) {
            if (Array.isArray(v) && typeof k === "number") {
              v = v[k];
            } else if (typeof k === "string") {
              // Defense against prototype pollution: only access own properties
              const obj = asQueryRecord(v);
              if (!obj || !Object.hasOwn(obj, k)) {
                return false;
              }
              v = obj[k];
            } else {
              return false;
            }
          }
          const results = evaluate(v, args[0], ctx);
          return results.some(isTruthy);
        });
      }
      return paths;
    }

    case "leaf_paths": {
      const paths = collectContainerPaths(value, ctx, true);
      // Return each path as a separate output (like paths does)
      return paths;
    }

    default:
      return null;
  }
}
