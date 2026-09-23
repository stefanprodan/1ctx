/**
 * AWK Built-in Functions
 *
 * Implementation of AWK built-in functions for the AST-based interpreter.
 */

import { BoundedStringBuilder } from "../../bounded-builder.js";
import { utf8ByteLength } from "../../encoding.js";
import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import { createUserRegex, type UserRegex } from "../../regex/index.js";
import type { AwkExpr } from "./ast.js";
import { chars, charLength, charSlice, charsBefore } from "./chars.js";
import { DEFAULT_AWK_STRING_LIMIT, formatPrintf } from "./format.js";
import type { AwkRuntimeContext } from "./interpreter/context.js";
import {
  compileSeparator,
  type FieldSeparator,
  splitText,
} from "./interpreter/fields.js";
import { getField, setField } from "./interpreter/fields.js";
import { closePipe, flushOutput } from "./interpreter/pipes.js";
import {
  looksLikeNumber,
  toAwkString,
  toNumber,
  toStr,
} from "./interpreter/type-coercion.js";
import {
  deleteArray,
  getVariable,
  isArrayName,
  readArrayElement,
  resolveArrayName,
  setArrayElement,
  setVariable,
} from "./interpreter/variables.js";
import type { AwkValue } from "./interpreter/types.js";

/**
 * Interface for evaluating expressions (passed from interpreter)
 */
export interface AwkEvaluator {
  evalExpr: (expr: AwkExpr) => Promise<AwkValue>;
}

export type AwkBuiltinFn = (
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
) => AwkValue | Promise<AwkValue>;

function createAwkStringBuilder(maxBytes: number): BoundedStringBuilder {
  return new BoundedStringBuilder(
    maxBytes,
    "awk string",
    () =>
      new ExecutionLimitError(
        `string size limit exceeded (${maxBytes} bytes)`,
        "string_length",
      ),
  );
}

function awkStringLimit(ctx: AwkRuntimeContext): number {
  return ctx.maxOutputSize > 0 ? ctx.maxOutputSize : DEFAULT_AWK_STRING_LIMIT;
}

function boundedRegexReplace(
  target: string,
  regex: UserRegex,
  shouldReplace: (matchNumber: number) => boolean,
  replacer: (match: RegExpMatchArray) => string,
  maxBytes: number,
): { value: string; replacements: number } {
  const output = createAwkStringBuilder(maxBytes);
  let cursor = 0;
  let matchNumber = 0;
  let replacements = 0;
  for (const match of regex.matchAll(target)) {
    const index = match.index ?? 0;
    matchNumber++;
    output.append(target.slice(cursor, index));
    if (shouldReplace(matchNumber)) {
      output.append(replacer(match));
      replacements++;
    } else {
      output.append(match[0]);
    }
    cursor = index + match[0].length;
  }
  output.append(target.slice(cursor));
  return { value: output.build(), replacements };
}

/**
 * Extract a regex pattern from an AWK expression argument.
 * Handles both regex literals and string expressions.
 */
async function extractPatternArg(
  arg: AwkExpr,
  evaluator: AwkEvaluator,
): Promise<string> {
  if (arg.type === "regex") {
    return arg.pattern;
  }
  let pattern = toAwkString(await evaluator.evalExpr(arg));
  if (pattern.startsWith("/") && pattern.endsWith("/")) {
    pattern = pattern.slice(1, -1);
  }
  return pattern;
}

// (1ctx) The target of sub and gsub: $0 or a field, a variable (a built-in
// included), an array element, or any other expression, which gawk counts
// the replacements in and leaves alone.
type SubTarget =
  | { kind: "field"; index: number }
  | { kind: "variable"; name: string }
  | { kind: "element"; array: string; key: string }
  | { kind: "value"; value: string };

async function resolveTarget(
  targetExpr: AwkExpr | undefined,
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<SubTarget> {
  if (!targetExpr) return { kind: "field", index: 0 };
  if (targetExpr.type === "variable") {
    return { kind: "variable", name: targetExpr.name };
  }
  if (targetExpr.type === "field") {
    const index = Math.floor(
      toNumber(await evaluator.evalExpr(targetExpr.index)),
    );
    return { kind: "field", index };
  }
  if (targetExpr.type === "array_access") {
    const key = toStr(ctx, await evaluator.evalExpr(targetExpr.key));
    return { kind: "element", array: targetExpr.array, key };
  }
  const value = toStr(ctx, await evaluator.evalExpr(targetExpr));
  return { kind: "value", value };
}

function getTargetValue(target: SubTarget, ctx: AwkRuntimeContext): string {
  switch (target.kind) {
    case "field":
      return toStr(ctx, getField(ctx, target.index));
    case "variable":
      return toStr(ctx, getVariable(ctx, target.name));
    case "element":
      return toStr(ctx, readArrayElement(ctx, target.array, target.key));
    case "value":
      return target.value;
  }
}

// gawk assigns nothing when nothing matched, though a field past NF is
// made by being named, without rebuilding $0
function changes(
  target: SubTarget,
  replacements: number,
  ctx: AwkRuntimeContext,
): boolean {
  if (replacements > 0) return true;
  if (target.kind === "field" && target.index > ctx.NF) {
    while (ctx.fields.length < target.index) ctx.fields.push("");
    ctx.NF = ctx.fields.length;
  }
  return false;
}

function applyTargetValue(
  target: SubTarget,
  newValue: string,
  ctx: AwkRuntimeContext,
): void {
  switch (target.kind) {
    case "field":
      setField(ctx, target.index, newValue);
      return;
    case "variable":
      setVariable(ctx, target.name, newValue);
      return;
    case "element":
      setArrayElement(ctx, target.array, target.key, newValue);
      return;
    case "value":
      return;
  }
}

// ─── String Functions ───────────────────────────────────────────

async function awkLength(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<number> {
  if (args.length === 0) {
    return charLength(ctx.line);
  }
  // (1ctx) the number of elements of an array, a parameter holding one too
  const arg = args[0];
  if (arg.type === "variable" && isArrayName(ctx, arg.name)) {
    return Object.keys(ctx.arrays[resolveArrayName(ctx, arg.name)]).length;
  }
  const str = toAwkString(await evaluator.evalExpr(arg), ctx.CONVFMT);
  // (1ctx) characters, not UTF-16 units
  return charLength(str);
}

async function awkSubstr(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<string> {
  if (args.length < 2) return "";
  const str = toAwkString(await evaluator.evalExpr(args[0]), ctx.CONVFMT);
  const start = Math.max(
    0,
    Math.floor(toNumber(await evaluator.evalExpr(args[1]))) - 1,
  );

  // (1ctx) positions and lengths count characters, as gawk does
  if (args.length >= 3) {
    const len = Math.floor(toNumber(await evaluator.evalExpr(args[2])));
    return len > 0 ? charSlice(str, start, start + len) : "";
  }
  return charSlice(str, start);
}

async function awkIndex(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<number> {
  if (args.length < 2) return 0;
  const str = toAwkString(await evaluator.evalExpr(args[0]), ctx.CONVFMT);
  const target = toAwkString(await evaluator.evalExpr(args[1]), ctx.CONVFMT);
  const idx = str.indexOf(target);
  // (1ctx) a character position
  return idx === -1 ? 0 : charsBefore(str, idx) + 1;
}

/**
 * (1ctx) The resolved name of an array argument, or gawk's fatal error
 * when the argument is not a variable or holds a scalar.
 */
function arrayArgument(
  ctx: AwkRuntimeContext,
  arg: AwkExpr,
  fn: string,
  position: string,
): string {
  if (arg.type === "variable") {
    const resolved = resolveArrayName(ctx, arg.name);
    if (ctx.vars[resolved] === undefined) return resolved;
  }
  throw new Error(`${fn}: ${position} argument is not an array`);
}

// (1ctx) split as gawk does: both arrays cleared first, the separator read
// as FS is (" ", one character, "" or a regex), and seps filled when given.
async function awkSplit(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<number> {
  if (args.length < 2) return 0;
  const arrayName = arrayArgument(ctx, args[1], "split", "second");
  const sepsName =
    args.length >= 4
      ? arrayArgument(ctx, args[3], "split", "fourth")
      : undefined;
  if (sepsName === arrayName) {
    throw new Error(
      "split: cannot use the same array for second and fourth args",
    );
  }
  const str = toAwkString(await evaluator.evalExpr(args[0]), ctx.CONVFMT);

  let sep: FieldSeparator = ctx.fieldSep;
  if (args.length >= 3) {
    const sepExpr = args[2];
    sep =
      sepExpr.type === "regex"
        ? { kind: "regex", regex: createUserRegex(sepExpr.pattern) }
        : compileSeparator(
            toAwkString(await evaluator.evalExpr(sepExpr), ctx.CONVFMT),
          );
  }
  const { fields, seps } = splitText(str, sep);

  const previous =
    Object.keys(ctx.arrays[arrayName] ?? {}).length +
    (sepsName ? Object.keys(ctx.arrays[sepsName] ?? {}).length : 0);
  const wanted = fields.length + (sepsName ? seps.size : 0);
  if (wanted > ctx.maxArrayElements - ctx.arrayElementCount + previous) {
    throw new ExecutionLimitError(
      `array element limit exceeded (${ctx.maxArrayElements})`,
      "array_elements",
    );
  }

  deleteArray(ctx, arrayName);
  ctx.arrays[arrayName] ??= Object.create(null);
  for (let i = 0; i < fields.length; i++) {
    setArrayElement(ctx, arrayName, String(i + 1), fields[i]);
  }
  if (sepsName) {
    deleteArray(ctx, sepsName);
    ctx.arrays[sepsName] ??= Object.create(null);
    for (const [i, text] of seps) {
      setArrayElement(ctx, sepsName, String(i), text);
    }
  }
  return fields.length;
}

// (1ctx) asort and asorti as gawk 5.4.1 orders them. The default is
// "@val_type_asc" for asort and "@ind_str_asc" for asorti; "@val_num"
// breaks a tie by the value as a string, "@val_type" ranks an
// uninitialized value before a number before a string, and every order
// breaks its last tie by the index as a string; "_desc" reverses the
// whole comparison, as gawk does.
const SORT_ORDERS = new Set([
  "@ind_str_asc",
  "@ind_str_desc",
  "@ind_num_asc",
  "@ind_num_desc",
  "@val_str_asc",
  "@val_str_desc",
  "@val_num_asc",
  "@val_num_desc",
  "@val_type_asc",
  "@val_type_desc",
]);

interface SortEntry {
  index: string;
  value: AwkValue | undefined;
}

// code points, as gawk compares strings in a UTF-8 locale
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  if (!/[\uD800-\uDFFF]/.test(a + b)) return a < b ? -1 : 1;
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < x.length && i < y.length; i++) {
    const c = (x[i].codePointAt(0) ?? 0) - (y[i].codePointAt(0) ?? 0);
    if (c !== 0) return c;
  }
  return x.length - y.length;
}

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function valueClass(value: AwkValue | undefined): number {
  if (value === undefined) return 0;
  return looksLikeNumber(value) ? 1 : 2;
}

function sortComparator(
  how: string,
  convfmt: string,
): (a: SortEntry, b: SortEntry) => number {
  const [subject, kind, direction] = how.split("_");
  const sign = direction === "desc" ? -1 : 1;
  const text = (v: AwkValue | undefined) =>
    v === undefined ? "" : toAwkString(v, convfmt);
  const number = (v: AwkValue | undefined) =>
    v === undefined ? 0 : toNumber(v);
  const byIndex = (a: SortEntry, b: SortEntry) =>
    compareStrings(a.index, b.index);
  let compare: (a: SortEntry, b: SortEntry) => number;
  if (subject === "@ind" && kind === "num") {
    compare = (a, b) =>
      compareNumbers(toNumber(a.index), toNumber(b.index)) || byIndex(a, b);
  } else if (subject === "@ind") {
    compare = byIndex;
  } else if (kind === "str") {
    compare = (a, b) =>
      compareStrings(text(a.value), text(b.value)) || byIndex(a, b);
  } else if (kind === "num") {
    compare = (a, b) =>
      compareNumbers(number(a.value), number(b.value)) ||
      compareStrings(text(a.value), text(b.value)) ||
      byIndex(a, b);
  } else {
    compare = (a, b) => {
      const ca = valueClass(a.value);
      const cb = valueClass(b.value);
      if (ca !== cb) return ca - cb;
      if (ca === 1) {
        return compareNumbers(number(a.value), number(b.value)) || byIndex(a, b);
      }
      if (ca === 2) {
        return compareStrings(text(a.value), text(b.value)) || byIndex(a, b);
      }
      return byIndex(a, b);
    };
  }
  return (a, b) => sign * compare(a, b);
}

async function sortArray(
  fn: "asort" | "asorti",
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<number> {
  const source = arrayArgument(ctx, args[0], fn, "first");
  const dest =
    args.length >= 2 ? arrayArgument(ctx, args[1], fn, "second") : source;
  let how = fn === "asort" ? "@val_type_asc" : "@ind_str_asc";
  if (args.length >= 3) {
    how = toAwkString(await evaluator.evalExpr(args[2]), ctx.CONVFMT);
    if (!SORT_ORDERS.has(how)) {
      throw new Error(
        ctx.functions.has(how)
          ? `${fn}: a user comparison function is not supported`
          : `sort comparison function '${how}' is not defined`,
      );
    }
  }
  const elements = ctx.arrays[source] ?? {};
  const entries: SortEntry[] = Object.keys(elements).map((index) => ({
    index,
    value: elements[index],
  }));
  entries.sort(sortComparator(how, ctx.CONVFMT));

  if (dest !== source) {
    const room =
      ctx.maxArrayElements -
      ctx.arrayElementCount +
      Object.keys(ctx.arrays[dest] ?? {}).length;
    if (entries.length > room) {
      throw new ExecutionLimitError(
        `array element limit exceeded (${ctx.maxArrayElements})`,
        "array_elements",
      );
    }
  }
  deleteArray(ctx, dest);
  ctx.arrays[dest] ??= Object.create(null);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    setArrayElement(
      ctx,
      dest,
      String(i + 1),
      fn === "asort" ? e.value : e.index,
    );
  }
  return entries.length;
}

const awkAsort: AwkBuiltinFn = (args, ctx, evaluator) =>
  sortArray("asort", args, ctx, evaluator);
const awkAsorti: AwkBuiltinFn = (args, ctx, evaluator) =>
  sortArray("asorti", args, ctx, evaluator);

async function awkSub(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<number> {
  if (args.length < 2) return 0;

  const pattern = await extractPatternArg(args[0], evaluator);
  const replacement = toAwkString(await evaluator.evalExpr(args[1]), ctx.CONVFMT);
  const target = await resolveTarget(args[2], ctx, evaluator);
  const text = getTargetValue(target, ctx);

  try {
    const regex = createUserRegex(pattern, "g");
    const replaced = boundedRegexReplace(
      text,
      regex,
      (matchNumber) => matchNumber === 1,
      (match) =>
        createSubReplacement(replacement, match[0], awkStringLimit(ctx)),
      awkStringLimit(ctx),
    );
    if (changes(target, replaced.replacements, ctx)) {
      applyTargetValue(target, replaced.value, ctx);
    }
    return replaced.replacements;
  } catch (error) {
    rethrowFatalExecutionError(error);
    return 0;
  }
}

async function awkGsub(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<number> {
  if (args.length < 2) return 0;

  const pattern = await extractPatternArg(args[0], evaluator);
  const replacement = toAwkString(await evaluator.evalExpr(args[1]), ctx.CONVFMT);
  const target = await resolveTarget(args[2], ctx, evaluator);
  const text = getTargetValue(target, ctx);

  try {
    const regex = createUserRegex(pattern, "g");
    const replaced = boundedRegexReplace(
      text,
      regex,
      () => true,
      (match) =>
        createSubReplacement(replacement, match[0], awkStringLimit(ctx)),
      awkStringLimit(ctx),
    );
    if (changes(target, replaced.replacements, ctx)) {
      applyTargetValue(target, replaced.value, ctx);
    }
    return replaced.replacements;
  } catch (error) {
    rethrowFatalExecutionError(error);
    return 0;
  }
}

// (1ctx) gawk's own rules for the replacement of sub and gsub: \\\& gives
// \&, \\\\ gives \\, \\& gives a backslash and the match, \& gives &, and
// any other backslash is kept as it is.
function createSubReplacement(
  replacement: string,
  match: string,
  maxBytes: number,
): string {
  const result = createAwkStringBuilder(maxBytes);
  let i = 0;
  while (i < replacement.length) {
    const ch = replacement[i];
    if (ch === "&") {
      result.append(match);
      i++;
      continue;
    }
    if (ch !== "\\") {
      result.append(ch);
      i++;
      continue;
    }
    const four = replacement.slice(i, i + 4);
    if (four === "\\\\\\&" || four === "\\\\\\\\") {
      result.append(four.slice(2));
      i += 4;
    } else if (four.startsWith("\\\\&")) {
      result.append("\\");
      result.append(match);
      i += 3;
    } else if (four.startsWith("\\&")) {
      result.append("&");
      i += 2;
    } else {
      result.append("\\");
      i++;
    }
  }
  return result.build();
}

async function awkMatch(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<number> {
  if (args.length < 2) {
    ctx.RSTART = 0;
    ctx.RLENGTH = -1;
    return 0;
  }

  // (1ctx) gawk's third argument, checked before anything is matched
  const arrayName =
    args.length >= 3
      ? arrayArgument(ctx, args[2], "match", "third")
      : undefined;

  const str = toAwkString(await evaluator.evalExpr(args[0]), ctx.CONVFMT);
  const pattern = await extractPatternArg(args[1], evaluator);

  // Only a pattern that does not compile is a failed match; a limit or an
  // array error is not
  let regex: UserRegex | undefined;
  try {
    regex = createUserRegex(pattern);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  const spans = regex?.groups(str) ?? null;

  if (arrayName !== undefined) {
    deleteArray(ctx, arrayName);
    ctx.arrays[arrayName] ??= Object.create(null);
  }
  if (!spans) {
    ctx.RSTART = 0;
    ctx.RLENGTH = -1;
    return 0;
  }

  // (1ctx) character positions, not UTF-16 offsets
  ctx.RSTART = charsBefore(str, spans[0].start) + 1;
  ctx.RLENGTH = charLength(str.slice(spans[0].start, spans[0].end));
  if (arrayName !== undefined) {
    for (let n = 0; n < spans.length; n++) {
      const { start, end } = spans[n];
      if (start < 0) continue;
      const text = str.slice(start, end);
      setArrayElement(ctx, arrayName, String(n), text);
      setArrayElement(
        ctx,
        arrayName,
        `${n}${ctx.SUBSEP}start`,
        charsBefore(str, start) + 1,
      );
      setArrayElement(
        ctx,
        arrayName,
        `${n}${ctx.SUBSEP}length`,
        charLength(text),
      );
    }
  }
  return ctx.RSTART;
}

async function awkGensub(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<string> {
  if (args.length < 3) return "";

  const pattern = await extractPatternArg(args[0], evaluator);
  const replacement = toAwkString(await evaluator.evalExpr(args[1]), ctx.CONVFMT);
  const how = toAwkString(await evaluator.evalExpr(args[2]), ctx.CONVFMT);
  const target =
    args.length >= 4
      ? toAwkString(await evaluator.evalExpr(args[3]), ctx.CONVFMT)
      : ctx.line;

  try {
    const isGlobal = how.toLowerCase() === "g";
    const occurrenceNum = isGlobal ? 0 : parseInt(how, 10) || 1;

    if (isGlobal) {
      const regex = createUserRegex(pattern, "g");
      return boundedRegexReplace(
        target,
        regex,
        () => true,
        (match) =>
          processGensub(
            replacement,
            match[0],
            match.slice(1),
            awkStringLimit(ctx),
          ),
        awkStringLimit(ctx),
      ).value;
    } else {
      const regex = createUserRegex(pattern, "g");
      return boundedRegexReplace(
        target,
        regex,
        (matchNumber) => matchNumber === occurrenceNum,
        (match) =>
          processGensub(
            replacement,
            match[0],
            match.slice(1),
            awkStringLimit(ctx),
          ),
        awkStringLimit(ctx),
      ).value;
    }
  } catch (error) {
    rethrowFatalExecutionError(error);
    return target;
  }
}

function processGensub(
  replacement: string,
  match: string,
  groups: string[],
  maxBytes: number,
): string {
  const result = createAwkStringBuilder(maxBytes);
  let i = 0;
  while (i < replacement.length) {
    if (replacement[i] === "\\" && i + 1 < replacement.length) {
      const next = replacement[i + 1];
      if (next === "&") {
        result.append("&");
        i += 2;
      } else if (next === "0") {
        result.append(match);
        i += 2;
      } else if (next >= "1" && next <= "9") {
        const idx = parseInt(next, 10) - 1;
        result.append(groups[idx] || "");
        i += 2;
      } else if (next === "n") {
        result.append("\n");
        i += 2;
      } else if (next === "t") {
        result.append("\t");
        i += 2;
      } else {
        result.append(next);
        i += 2;
      }
    } else if (replacement[i] === "&") {
      result.append(match);
      i++;
    } else {
      result.append(replacement[i]);
      i++;
    }
  }
  return result.build();
}

async function awkTolower(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<string> {
  if (args.length === 0) return "";
  return toAwkString(await evaluator.evalExpr(args[0]), ctx.CONVFMT).toLowerCase();
}

async function awkToupper(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<string> {
  if (args.length === 0) return "";
  return toAwkString(await evaluator.evalExpr(args[0]), ctx.CONVFMT).toUpperCase();
}

async function awkSprintf(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<string> {
  // (1ctx) gawk's fatal error, when the call runs
  if (args.length === 0) throw new Error("sprintf: no arguments");
  const format = toAwkString(await evaluator.evalExpr(args[0]), ctx.CONVFMT);
  const values: AwkValue[] = [];
  for (let i = 1; i < args.length; i++) {
    values.push(await evaluator.evalExpr(args[i]));
  }
  return formatPrintf(format, values, awkStringLimit(ctx), ctx.CONVFMT);
}

// ─── Math Functions ─────────────────────────────────────────────

async function awkInt(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<number> {
  if (args.length === 0) return 0;
  // (1ctx) toward zero, as gawk truncates
  return Math.trunc(toNumber(await evaluator.evalExpr(args[0])));
}

async function awkSqrt(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<number> {
  if (args.length === 0) return 0;
  return Math.sqrt(toNumber(await evaluator.evalExpr(args[0])));
}

async function awkSin(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<number> {
  if (args.length === 0) return 0;
  return Math.sin(toNumber(await evaluator.evalExpr(args[0])));
}

async function awkCos(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<number> {
  if (args.length === 0) return 0;
  return Math.cos(toNumber(await evaluator.evalExpr(args[0])));
}

async function awkAtan2(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<number> {
  const y = args.length > 0 ? toNumber(await evaluator.evalExpr(args[0])) : 0;
  const x = args.length > 1 ? toNumber(await evaluator.evalExpr(args[1])) : 0;
  return Math.atan2(y, x);
}

async function awkLog(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<number> {
  if (args.length === 0) return 0;
  return Math.log(toNumber(await evaluator.evalExpr(args[0])));
}

async function awkExp(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<number> {
  if (args.length === 0) return 1;
  return Math.exp(toNumber(await evaluator.evalExpr(args[0])));
}

function awkRand(
  _args: AwkExpr[],
  ctx: AwkRuntimeContext,
  _evaluator: AwkEvaluator,
): number {
  return ctx.random ? ctx.random() : Math.random();
}

async function awkSrand(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<number> {
  const seed =
    args.length > 0 ? toNumber(await evaluator.evalExpr(args[0])) : Date.now();
  ctx.vars._srand_seed = seed;
  return seed;
}

// (1ctx) close(name) ends what gawk would: the file getline reads (by
// path), the command getline reads (by its text, so it runs again), and
// the output file of that name, so the next ">" truncates it.
async function awkClose(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<number> {
  if (args.length === 0) return -1;
  const name = toAwkString(await evaluator.evalExpr(args[0]), ctx.CONVFMT);
  // an output pipe answers its command's exit status
  const status = await closePipe(ctx, name);
  if (status !== null) return status;
  let closed = ctx.getlineCommandStreams.delete(name);
  if (ctx.fs && ctx.cwd) {
    const path = ctx.fs.resolvePath(ctx.cwd, name);
    if (ctx.getlineFileStreams.delete(path)) closed = true;
    if (ctx.openedFiles.delete(path)) closed = true;
  }
  return closed ? 0 : -1;
}

async function awkFflush(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator,
): Promise<number> {
  if (args.length === 0) {
    flushOutput(ctx);
    return 0;
  }
  const name = toAwkString(await evaluator.evalExpr(args[0]), ctx.CONVFMT);
  if (name === "/dev/stdout" || name === "/dev/stderr") {
    flushOutput(ctx);
    return 0;
  }
  if (ctx.outputPipes.has(name)) return 0;
  const path = ctx.fs && ctx.cwd ? ctx.fs.resolvePath(ctx.cwd, name) : name;
  return ctx.openedFiles.has(path) ? 0 : -1;
}

// ─── Unsupported Functions ──────────────────────────────────────

function unsupported(name: string, reason: string): AwkBuiltinFn {
  return () => {
    throw new Error(`${name}() is not supported - ${reason}`);
  };
}

function unimplemented(name: string): AwkBuiltinFn {
  return () => {
    throw new Error(`function '${name}()' is not implemented`);
  };
}

// ─── Built-in Function Registry ─────────────────────────────────

export const awkBuiltins: Map<string, AwkBuiltinFn> = new Map([
  // String functions
  ["length", awkLength],
  ["substr", awkSubstr],
  ["index", awkIndex],
  ["split", awkSplit],
  ["asort", awkAsort],
  ["asorti", awkAsorti],
  ["sub", awkSub],
  ["gsub", awkGsub],
  ["match", awkMatch],
  ["gensub", awkGensub],
  ["tolower", awkTolower],
  ["toupper", awkToupper],
  ["sprintf", awkSprintf],

  // Math functions
  ["int", awkInt],
  ["sqrt", awkSqrt],
  ["sin", awkSin],
  ["cos", awkCos],
  ["atan2", awkAtan2],
  ["log", awkLog],
  ["exp", awkExp],
  ["rand", awkRand],
  ["srand", awkSrand],

  // Unsupported functions (security/sandboxing)
  [
    "system",
    unsupported(
      "system",
      "shell execution not allowed in sandboxed environment",
    ),
  ],
  // (1ctx) close() ends a getline stream or an output file of that name
  ["close", awkClose],
  // (1ctx) fflush() marks our output written, so a pipe closed later
  // follows it; a pipe's own command still runs only when it is closed
  ["fflush", awkFflush],

  // Unimplemented functions
  ["systime", unimplemented("systime")],
  ["mktime", unimplemented("mktime")],
  ["strftime", unimplemented("strftime")],
]);
