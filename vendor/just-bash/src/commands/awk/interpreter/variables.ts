/**
 * AWK Variable and Array Operations
 *
 * Handles user variables, built-in variables, and arrays.
 */

import { ExecutionLimitError } from "../../../interpreter/errors.js";
import type { AwkRuntimeContext } from "./context.js";
import { setFieldSeparator } from "./fields.js";
import { toStr, toNumber } from "./type-coercion.js";
import type { AwkValue } from "./types.js";

/**
 * Get a variable value. Handles built-in variables.
 */
export function getVariable(ctx: AwkRuntimeContext, name: string): AwkValue {
  switch (name) {
    case "FS":
      return ctx.FS;
    case "OFS":
      return ctx.OFS;
    case "ORS":
      return ctx.ORS;
    case "OFMT":
      return ctx.OFMT;
    case "CONVFMT":
      return ctx.CONVFMT;
    case "NR":
      return ctx.NR;
    case "NF":
      return ctx.NF;
    case "FNR":
      return ctx.FNR;
    case "FILENAME":
      return ctx.FILENAME;
    case "RSTART":
      return ctx.RSTART;
    case "RLENGTH":
      return ctx.RLENGTH;
    case "SUBSEP":
      return ctx.SUBSEP;
    case "ARGC":
      return ctx.ARGC;
    case "RS":
      return ctx.RS;
    case "RT":
      return ctx.RT;
  }

  return ctx.vars[name] ?? "";
}

/**
 * Set a variable value. Handles built-in variables with special behavior.
 */
export function setVariable(
  ctx: AwkRuntimeContext,
  name: string,
  value: AwkValue,
): void {
  switch (name) {
    case "FS":
      setFieldSeparator(ctx, toStr(ctx, value));
      return;
    case "OFS":
      ctx.OFS = toStr(ctx, value);
      return;
    case "ORS":
      ctx.ORS = toStr(ctx, value);
      return;
    case "OFMT":
      ctx.OFMT = toStr(ctx, value);
      return;
    case "CONVFMT":
      ctx.CONVFMT = toStr(ctx, value);
      return;
    case "NR":
      ctx.NR = Math.floor(toNumber(value));
      return;
    case "NF": {
      const newNF = Math.floor(toNumber(value));
      if (newNF < ctx.NF) {
        ctx.fields = ctx.fields.slice(0, newNF);
        ctx.line = ctx.fields.join(ctx.OFS);
      } else if (newNF > ctx.NF) {
        while (ctx.fields.length < newNF) {
          ctx.fields.push("");
        }
        ctx.line = ctx.fields.join(ctx.OFS);
      }
      ctx.NF = newNF;
      return;
    }
    case "FNR":
      ctx.FNR = Math.floor(toNumber(value));
      return;
    case "FILENAME":
      ctx.FILENAME = toStr(ctx, value);
      return;
    case "RSTART":
      ctx.RSTART = Math.floor(toNumber(value));
      return;
    case "RLENGTH":
      ctx.RLENGTH = Math.floor(toNumber(value));
      return;
    case "SUBSEP":
      ctx.SUBSEP = toStr(ctx, value);
      return;
    case "ARGC":
      // (1ctx) the input walk reads ARGC as it stands
      ctx.ARGC = toNumber(value);
      return;
    case "RS":
      // (1ctx) read by the record reader at each record
      ctx.RS = toStr(ctx, value);
      return;
    case "RT":
      ctx.RT = toStr(ctx, value);
      return;
  }

  ctx.vars[name] = value;
}

/**
 * Resolve array name through aliases (for function parameter passing).
 */
function resolveArrayName(ctx: AwkRuntimeContext, array: string): string {
  // Follow alias chain to get the real array name
  let resolved = array;
  const seen = new Set<string>();
  let alias = ctx.arrayAliases.get(resolved);
  while (alias !== undefined && !seen.has(resolved)) {
    seen.add(resolved);
    resolved = alias;
    alias = ctx.arrayAliases.get(resolved);
  }
  return resolved;
}

/**
 * Get an array element value.
 */
export function getArrayElement(
  ctx: AwkRuntimeContext,
  array: string,
  key: string,
): AwkValue {
  // Resolve aliases for function parameter passing
  const resolvedArray = resolveArrayName(ctx, array);
  return ctx.arrays[resolvedArray]?.[key] ?? "";
}

/**
 * Set an array element value.
 */
export function setArrayElement(
  ctx: AwkRuntimeContext,
  array: string,
  key: string,
  value: AwkValue,
): void {
  // Resolve aliases for function parameter passing
  const resolvedArray = resolveArrayName(ctx, array);
  if (!ctx.arrays[resolvedArray]) {
    // Use null-prototype to prevent prototype pollution with user-controlled keys
    ctx.arrays[resolvedArray] = Object.create(null);
  }
  if (!(key in ctx.arrays[resolvedArray]) && !isUncounted(resolvedArray)) {
    if (ctx.arrayElementCount >= ctx.maxArrayElements) {
      throw new ExecutionLimitError(
        `array element limit exceeded (${ctx.maxArrayElements})`,
        "array_elements",
      );
    }
    ctx.arrayElementCount++;
  }
  ctx.arrays[resolvedArray][key] = value;
}

/**
 * Check if an array element exists.
 */
export function hasArrayElement(
  ctx: AwkRuntimeContext,
  array: string,
  key: string,
): boolean {
  // Resolve aliases for function parameter passing
  const resolvedArray = resolveArrayName(ctx, array);
  return ctx.arrays[resolvedArray]?.[key] !== undefined;
}

/**
 * Delete an array element.
 */
export function deleteArrayElement(
  ctx: AwkRuntimeContext,
  array: string,
  key: string,
): void {
  // Resolve aliases for function parameter passing
  const resolvedArray = resolveArrayName(ctx, array);
  if (ctx.arrays[resolvedArray]) {
    if (key in ctx.arrays[resolvedArray] && !isUncounted(resolvedArray)) {
      ctx.arrayElementCount--;
    }
    delete ctx.arrays[resolvedArray][key];
  }
}

/**
 * Delete an entire array.
 */
export function deleteArray(ctx: AwkRuntimeContext, array: string): void {
  // Resolve aliases for function parameter passing
  const resolvedArray = resolveArrayName(ctx, array);
  const elements = ctx.arrays[resolvedArray];
  if (!elements) return;
  if (isUncounted(resolvedArray)) {
    // (1ctx) ARGV and ENVIRON stay the same objects the context holds
    for (const key of Object.keys(elements)) delete elements[key];
    return;
  }
  ctx.arrayElementCount -= Object.keys(elements).length;
  delete ctx.arrays[resolvedArray];
}

// (1ctx) the arrays awk fills itself, outside the element cap
function isUncounted(array: string): boolean {
  return array === "ARGV" || array === "ENVIRON";
}
