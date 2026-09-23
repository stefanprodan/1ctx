/**
 * Where jq and mikefarah's yq part (1ctx)
 *
 * jq and yq run one engine, and the two tools answer some builtins
 * differently. `ctx.dialect` says whose rules apply: "yq" for the yq
 * command, jq's otherwise. Where jq 1.8 and mikefarah agree and upstream
 * answered something else (null out of a function that should fail,
 * `to_entries` on an array, a capture without its name), both dialects
 * change here. These run before the other builtins and answer null to
 * leave a call to them.
 */

import type { RE2JS } from "re2js";
import YAML from "yaml";
import { createUserRegex, type UserRegex } from "../../../regex/index.js";
import type { Dialect, EvalContext } from "../evaluator.js";
import { type AstNode, parse } from "../parser.js";
import { asQueryRecord, safeSet, sanitizeParsedData } from "../safe-object.js";
import {
  canonical,
  compareJq,
  deepEqual,
  type QueryValue,
} from "../value-operations.js";

type EvalFn = (
  value: QueryValue,
  ast: AstNode,
  ctx: EvalContext,
) => QueryValue[];

/** jq's name for a value's type. */
export function jqType(value: QueryValue): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value;
}

// jq's words for a value in an error: its type and its text, cut
function described(value: QueryValue): string {
  let text = JSON.stringify(value) ?? "null";
  if (text.length > 11) text = `${text.slice(0, 10)}...`;
  return `${jqType(value)} (${text})`;
}

/** The tag mikefarah's yq answers for a value. */
export function yamlTag(value: QueryValue): string {
  if (value === null || value === undefined) return "!!null";
  if (Array.isArray(value)) return "!!seq";
  if (typeof value === "object") return "!!map";
  if (typeof value === "boolean") return "!!bool";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "!!int" : "!!float";
  }
  return "!!str";
}

const OPERATION: Record<string, string> = {
  "+": "added",
  "-": "subtracted",
  "*": "multiplied",
  "/": "divided",
  "%": "divided (remainder)",
};

/** jq's error for two operands its arithmetic does not take. */
export function unsupported(op: string, l: QueryValue, r: QueryValue): never {
  throw new Error(
    `${described(l)} and ${described(r)} cannot be ${OPERATION[op] ?? "combined"}`,
  );
}

function isScalar(value: QueryValue): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

// the map keys and list indexes a path of steps names, null for any other
// node
function pathSteps(ast: AstNode): (string | number)[] | null {
  switch (ast.type) {
    case "Identity":
      return [];
    case "Paren":
    case "Optional":
      return pathSteps(ast.expr);
    case "Pipe": {
      const left = pathSteps(ast.left);
      const right = left === null ? null : pathSteps(ast.right);
      return left === null || right === null ? null : [...left, ...right];
    }
    case "Field": {
      const base = ast.base ? pathSteps(ast.base) : [];
      return base === null ? null : [...base, ast.name];
    }
    case "Index": {
      const base = ast.base ? pathSteps(ast.base) : [];
      if (base === null || ast.index.type !== "Literal") return null;
      const index = ast.index.value;
      if (typeof index !== "string" && typeof index !== "number") return null;
      return [...base, index];
    }
    default:
      return null;
  }
}

/**
 * Whether a path of steps names a map key that is not there, or steps
 * into a scalar. mikefarah's arithmetic reads its operands without
 * creating what is missing, so `.n * 2` on a document without `n` answers
 * nothing where `.n | . * 2` fails on the null it made; a list index past
 * the end still makes a null.
 */
export function missingPath(value: QueryValue, ast: AstNode): boolean {
  const steps = pathSteps(ast);
  if (steps === null) return false;
  let at = value;
  for (const step of steps) {
    if (typeof step === "string") {
      const map = asQueryRecord(at);
      if (map === null) return !Array.isArray(at);
      if (!Object.hasOwn(map, step)) return true;
      at = map[step] as QueryValue;
    } else {
      if (isScalar(at)) return true;
      at = Array.isArray(at) ? (at[step] ?? null) : null;
    }
  }
  return false;
}

/**
 * mikefarah's answer for arithmetic his yq takes and jq does not: a string
 * and a number or boolean concatenate, a null on the left of + or - gives
 * the right side, a null on the right of * the left, a map and a scalar
 * fail. Undefined leaves the operands to jq's rules.
 */
export function mixedOperands(
  op: string,
  l: QueryValue,
  r: QueryValue,
  dialect: Dialect | undefined,
): QueryValue[] | undefined {
  if (dialect !== "yq") return undefined;
  if (op === "+") {
    if (
      (typeof l === "string" && isScalar(r)) ||
      (typeof r === "string" && isScalar(l))
    ) {
      return [`${l}${r}`];
    }
    if (r === null && l !== null && !Array.isArray(l) && typeof l !== "string") {
      unsupported(op, l, r);
    }
    return undefined;
  }
  if (op === "-" && l === null) return [r];
  if (op === "*") {
    if (r === null) return [l];
    if (l === null && (Array.isArray(r) || asQueryRecord(r))) return [r];
  }
  return undefined;
}

// a * in the pattern matches any run of characters, in linear time
function globMatch(text: string, pattern: string): boolean {
  let t = 0;
  let p = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === text[t]) {
      t++;
      p++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/**
 * ==: in mikefarah's yq a * in a right-hand string is a wildcard, and two
 * maps are equal only in the same key order; jq compares maps by key.
 */
export function equalOperands(
  l: QueryValue,
  r: QueryValue,
  dialect: Dialect | undefined,
): boolean {
  if (dialect !== "yq") return deepEqual(l, r);
  if (typeof l === "string" && typeof r === "string" && r.includes("*")) {
    return globMatch(l, r);
  }
  return JSON.stringify(l) === JSON.stringify(r);
}

const REGEX_FUNCTIONS = new Set([
  "sub",
  "gsub",
  "test",
  "match",
  "capture",
  "split",
  "splits",
  "scan",
]);

// mikefarah's sub("a", "b"): one comma argument is the arguments
function commaArguments(ast: AstNode): AstNode[] {
  if (ast.type === "Comma") {
    return [...commaArguments(ast.left), ...commaArguments(ast.right)];
  }
  return [ast];
}

function firstString(
  value: QueryValue,
  arg: AstNode | undefined,
  ctx: EvalContext,
  evaluate: EvalFn,
  fallback: string,
): string {
  if (!arg) return fallback;
  const [first] = evaluate(value, arg, ctx);
  return first === null || first === undefined ? fallback : String(first);
}

interface Group {
  start: number;
  end: number;
  text: string | null;
  name: string | null;
}

interface Match {
  start: number;
  end: number;
  groups: Group[];
}

// every match with its groups' offsets and names, which UserRegex's own
// methods do not give
function matches(
  regex: UserRegex,
  input: string,
  global: boolean,
  limit: number,
): Match[] {
  const re2 = (regex as unknown as { _re2: RE2JS })._re2;
  const names: (string | null)[] = [];
  for (const [name, index] of Object.entries(re2.namedGroups() ?? {})) {
    names[index as number] = name;
  }
  const count = re2.groupCount();
  const matcher = re2.matcher(input);
  const found: Match[] = [];
  let position = 0;
  while (position <= input.length && matcher.find(position)) {
    if (found.length >= limit) {
      throw new Error(`query result element limit exceeded (${limit})`);
    }
    const start = matcher.start(0);
    const end = matcher.end(0);
    const groups: Group[] = [];
    for (let i = 1; i <= count; i++) {
      const text = matcher.group(i);
      groups.push({
        start: text === null ? -1 : matcher.start(i),
        end: text === null ? -1 : matcher.end(i),
        text,
        name: names[i] ?? null,
      });
    }
    found.push({ start, end, groups });
    if (!global) break;
    position = end > start ? end : end + 1;
  }
  return found;
}

function record(entries: [string, QueryValue][]): Record<string, QueryValue> {
  const out: Record<string, QueryValue> = Object.create(null);
  for (const [key, value] of entries) safeSet(out, key, value);
  return out;
}

// jq's match object, its fields in jq's order
function matchObject(m: Match, input: string): QueryValue {
  return record([
    ["offset", m.start],
    ["length", m.end - m.start],
    ["string", input.slice(m.start, m.end)],
    [
      "captures",
      m.groups.map((g) =>
        record([
          // jq orders an unmatched group's fields this way
          ...((g.text === null
            ? [
                ["offset", -1],
                ["string", null],
                ["length", 0],
              ]
            : [
                ["offset", g.start],
                ["length", g.end - g.start],
                ["string", g.text],
              ]) as [string, QueryValue][]),
          ["name", g.name],
        ]),
      ),
    ],
  ]);
}

function captureObject(m: Match): Record<string, QueryValue> {
  return record(
    m.groups
      .filter((g) => g.name !== null)
      .map((g) => [g.name as string, g.text]),
  );
}

function notString(value: QueryValue): never {
  throw new Error(`${described(value)} cannot be matched, as it is not a string`);
}

function regexBuiltin(
  value: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext,
  evaluate: EvalFn,
): QueryValue[] | null {
  const yq = ctx.dialect === "yq";
  switch (name) {
    case "test":
      if (typeof value !== "string") notString(value);
      return null;
    case "split":
      if (value === null && yq) return [];
      if (typeof value !== "string") {
        throw new Error("split input and separator must be strings");
      }
      return null;
    case "splits":
    case "scan":
      if (typeof value !== "string") notString(value);
      return null;
    case "match":
    case "capture": {
      if (typeof value !== "string") notString(value);
      if (args.length === 0) return null;
      const pattern = firstString(value, args[0], ctx, evaluate, "");
      const flags = firstString(value, args[1], ctx, evaluate, "");
      const regex = createUserRegex(pattern, flags.replaceAll("g", ""));
      const found = matches(
        regex,
        value,
        flags.includes("g"),
        ctx.limits.maxArrayElements,
      );
      return name === "match"
        ? found.map((m) => matchObject(m, value))
        : found.map(captureObject);
    }
    case "sub":
    case "gsub": {
      if (typeof value !== "string") notString(value);
      if (args.length < 2) return null;
      const pattern = firstString(value, args[0], ctx, evaluate, "");
      let flags = firstString(value, args[2], ctx, evaluate, "");
      // mikefarah's sub replaces every match
      if (name === "gsub" || yq) flags += "g";
      // mikefarah's replacement is text, with ${name} and $1 for groups
      if (yq) {
        const replacement = firstString(value, args[1], ctx, evaluate, "");
        return [createUserRegex(pattern, flags).replace(value, replacement)];
      }
      const regex = createUserRegex(pattern, flags.replaceAll("g", ""));
      const found = matches(
        regex,
        value,
        flags.includes("g"),
        ctx.limits.maxArrayElements,
      );
      // jq's replacement is a filter on the capture object, and each of its
      // outputs makes a result
      let results = [""];
      let last = 0;
      for (const m of found) {
        const outputs = evaluate(captureObject(m), args[1], ctx);
        const next: string[] = [];
        for (const prefix of results) {
          for (const output of outputs) {
            if (typeof output !== "string") {
              throw new Error(
                `${described(output)} cannot be added to a string`,
              );
            }
            next.push(prefix + value.slice(last, m.start) + output);
          }
        }
        if (next.length > ctx.limits.maxArrayElements) {
          throw new Error(
            `query result element limit exceeded (${ctx.limits.maxArrayElements})`,
          );
        }
        results = next;
        last = m.end;
      }
      return results.map((prefix) => prefix + value.slice(last));
    }
  }
  return null;
}

function hasNoKeys(value: QueryValue): never {
  throw new Error(`${described(value)} has no keys`);
}

function cannotIterate(value: QueryValue): never {
  throw new Error(`Cannot iterate over ${described(value)}`);
}

function entries(value: QueryValue[]): QueryValue[] {
  return value.map((item, key) =>
    record([
      ["key", key],
      ["value", item],
    ]),
  );
}

// the key of an entry with_entries wrote: jq takes only a string
function entryKey(key: QueryValue, yq: boolean): string {
  if (typeof key === "string") return key;
  if (yq && (typeof key === "number" || typeof key === "boolean")) {
    return String(key);
  }
  throw new Error(`Cannot use ${described(key)} as object key`);
}

// first-seen order, as mikefarah's unique and group_by keep it; his maps
// are equal only in one key order, jq's by key
function byKey(
  value: QueryValue[],
  key: (item: QueryValue) => QueryValue,
  yq: boolean,
): QueryValue[][] {
  const groups = new Map<string, { key: QueryValue; items: QueryValue[] }>();
  for (const item of value) {
    const k = key(item);
    const text = yq ? JSON.stringify(k) : canonical(k);
    const group = groups.get(text);
    if (group) group.items.push(item);
    else groups.set(text, { key: k, items: [item] });
  }
  return [...groups.values()].map((g) => g.items);
}

function yamlValue(text: string): QueryValue {
  return sanitizeParsedData(YAML.parse(text, { maxAliasCount: 100 }));
}

// env(NAME) names its variable bare, as mikefarah writes it
function variableName(
  value: QueryValue,
  arg: AstNode,
  ctx: EvalContext,
  evaluate: EvalFn,
): string {
  if (arg.type === "Call" && arg.args.length === 0) return arg.name;
  return firstString(value, arg, ctx, evaluate, "");
}

/** mikefarah's properties text: `a.b.0 = value`, one line each. */
export function propsText(value: QueryValue): string {
  const lines: string[] = [];
  const walk = (node: QueryValue, path: string): void => {
    if (Array.isArray(node) || asQueryRecord(node)) {
      const items = Array.isArray(node)
        ? node.map((item, i) => [String(i), item] as const)
        : Object.entries(node as Record<string, QueryValue>);
      for (const [key, item] of items) {
        walk(item, path === "" ? key : `${path}.${key}`);
      }
      return;
    }
    const text = node === null || node === undefined ? "null" : String(node);
    lines.push(path === "" ? text : `${path} = ${text}`);
  };
  walk(value, "");
  return lines.map((line) => `${line}\n`).join("");
}

// a scalar as mikefarah's csv writes it
function csvText(value: QueryValue): string {
  return value === null || value === undefined ? "null" : String(value);
}

// Go's csv quoting: a field holding the separator, a quote, a newline or a
// leading space
function csvField(text: string, separator: string): string {
  if (
    text.includes(separator) ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r") ||
    text.startsWith(" ")
  ) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

/**
 * mikefarah's @csv and @tsv: a scalar as it is, a list of scalars as one
 * row, a list of lists as rows, a list of maps under a header of the
 * first map's keys, anything else an error.
 */
export function csvRows(value: QueryValue, separator: string): string {
  const row = (cells: QueryValue[]): string => {
    for (const cell of cells) {
      if (cell !== null && typeof cell === "object") {
        throw new Error(
          `csv encoding only works for arrays of scalars (string/numbers/booleans), got ${yamlTag(cell)}`,
        );
      }
    }
    return cells.map((cell) => csvField(csvText(cell), separator)).join(separator);
  };
  if (!Array.isArray(value)) {
    if (value !== null && typeof value === "object") {
      throw new Error(`csv encoding only works for arrays, got: ${yamlTag(value)}`);
    }
    return csvText(value);
  }
  if (value.length === 0) return "";
  if (Array.isArray(value[0])) {
    return value
      .map((item) => {
        if (!Array.isArray(item)) {
          throw new Error(
            `csv encoding only works for arrays of scalars (string/numbers/booleans), got ${yamlTag(item)}`,
          );
        }
        return row(item);
      })
      .join("\n");
  }
  const first = asQueryRecord(value[0]);
  if (first) {
    const headers = Object.keys(first);
    const rows = value.map((item) => {
      const map = asQueryRecord(item);
      if (!map) {
        throw new Error(
          `csv object encoding only works for arrays of flat objects, got ${yamlTag(item)}`,
        );
      }
      return row(headers.map((h) => (Object.hasOwn(map, h) ? (map[h] as QueryValue) : "")));
    });
    return [row(headers), ...rows].join("\n");
  }
  return row(value);
}

// jq's @sh: a string quoted, a number, boolean or null as its text, a list
// of them joined by spaces, anything else an error
function shellText(value: QueryValue, yq: boolean): string {
  const one = (item: QueryValue): string => {
    if (typeof item === "string") return `'${item.replaceAll("'", "'\\''")}'`;
    if (item === null || item === undefined) return "null";
    if (typeof item === "object") {
      throw new Error(`${described(item)} can not be escaped for shell`);
    }
    return String(item);
  };
  if (yq && typeof value !== "string") {
    throw new Error(
      `cannot encode ${yamlTag(value)} as a shell word, can only operate on strings`,
    );
  }
  if (Array.isArray(value)) return value.map(one).join(" ");
  return one(value);
}

// a scalar retyped by mikefarah's `tag = "!!int"`, where the value can
// take the tag; a tagged node that reads back differently is refused
function retyped(value: QueryValue, tag: QueryValue): QueryValue {
  if (typeof tag !== "string") throw new Error("tag takes a string like !!str");
  const refuse = (): never => {
    throw new Error(`${described(value)} cannot be given the tag ${tag}`);
  };
  if (value !== null && typeof value === "object") refuse();
  const text = value === null || value === undefined ? "null" : String(value);
  switch (tag) {
    case "!!str":
      return text;
    case "!!int":
      if (typeof value === "number" && Number.isInteger(value)) return value;
      if (typeof value === "string" && /^[-+]?\d+$/.test(value.trim())) {
        return Number(value);
      }
      return refuse();
    case "!!float":
      if (typeof value === "number") return value;
      if (typeof value === "string" && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value.trim())) {
        return Number(value);
      }
      return refuse();
    case "!!bool":
      if (typeof value === "boolean") return value;
      if (text === "true" || text === "false") return text === "true";
      return refuse();
    case "!!null":
      if (value === null || text === "null" || text === "~" || text === "") {
        return null;
      }
      return refuse();
    default:
      return refuse();
  }
}

// the functions mikefarah's yq answers from a node's comments, style and
// anchors, which our values never carry: his answers for a node without
const NODE_TEXT = new Set([
  "anchor",
  "alias",
  "style",
  "line_comment",
  "head_comment",
  "foot_comment",
]);

// the setters mikefarah writes after a path (`.a style="double"`), parsed
// as a call of the name and `=`: tag= retypes a scalar, a comment setter
// with an empty string on `.` or `..` strips what the output never has,
// and the rest are refused, since our values carry no style, comments or
// anchors (1ctx)
const SETTERS = new Set([
  "style=",
  "tag=",
  "anchor=",
  "alias=",
  "line_comment=",
  "head_comment=",
  "foot_comment=",
  "comments=",
]);

// a comment setter with an empty string on `.` or `..`
function clearsComments(ast: AstNode): boolean {
  if (ast.type !== "Call" || ast.args.length !== 2) return false;
  if (!ast.name.endsWith("comment=") && ast.name !== "comments=") return false;
  const [path, text] = ast.args;
  return (
    (path.type === "Identity" || path.type === "Recurse") &&
    text.type === "Literal" &&
    text.value === ""
  );
}

/** Whether a call strips every comment of the document: `... comments=""`. */
export function stripsComments(ast: AstNode): boolean {
  return (
    ast.type === "Call" &&
    clearsComments(ast) &&
    ast.args[0].type === "Recurse"
  );
}

let sortKeysAst: AstNode | null = null;

// sort_keys(f): f |= its keys sorted, where it is a map
function sortKeysUpdate(path: AstNode): AstNode {
  sortKeysAst ??= parse(
    'if kind == "map" then to_entries | sort_by(.key) | from_entries else . end',
  );
  return { type: "UpdateOp", op: "|=", path, value: sortKeysAst };
}

function loaded(ctx: EvalContext, name: string, raw: boolean): QueryValue {
  const file = ctx.source?.loads.get(name);
  if (!file) {
    throw new Error(`load takes a file name as a string: ${name}`);
  }
  if ("error" in file) throw new Error(file.error);
  if (raw) return file.text;
  return sanitizeParsedData(
    name.toLowerCase().endsWith(".json")
      ? JSON.parse(file.text)
      : YAML.parse(file.text, { maxAliasCount: 100, merge: true }),
  );
}

// the path the yq walker knows for this very value; a value inside a
// function it does not follow has none, and a quiet null would mislead
function sourcePath(
  value: QueryValue,
  name: string,
  ctx: EvalContext,
): (string | number)[] | undefined {
  const node = ctx.sourceNode;
  if (node === undefined) return ctx.currentPath;
  if (Object.is(node.value, value) && node.path) return [...node.path];
  throw new Error(
    `${name} is known after a path step or select at the top of the filter, as in .[] | select(...) | ${name}, not inside map, with_entries or del`,
  );
}

function jsonText(value: QueryValue, indent: number): string {
  return indent === 0
    ? JSON.stringify(value)
    : `${JSON.stringify(value, null, indent)}\n`;
}

export function evalDialectBuiltin(
  value: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext,
  evaluate: EvalFn,
): QueryValue[] | null {
  const yq = ctx.dialect === "yq";
  if (
    yq &&
    args.length === 1 &&
    args[0].type === "Comma" &&
    REGEX_FUNCTIONS.has(name)
  ) {
    return evaluate(
      value,
      { type: "Call", name, args: commaArguments(args[0]) },
      ctx,
    );
  }
  if (REGEX_FUNCTIONS.has(name)) {
    return regexBuiltin(value, name, args, ctx, evaluate);
  }
  switch (name) {
    case "keys":
      if (Array.isArray(value)) return null;
      if (asQueryRecord(value)) return yq ? [Object.keys(value as object)] : null;
      return hasNoKeys(value);
    case "to_entries":
      if (Array.isArray(value)) return [entries(value)];
      if (value === null && yq) return [];
      if (asQueryRecord(value)) return null;
      return hasNoKeys(value);
    case "with_entries": {
      if (args.length === 0) return null;
      if (value === null && yq) return [];
      if (asQueryRecord(value)) return null;
      if (!Array.isArray(value)) return hasNoKeys(value);
      const out: Record<string, QueryValue> = Object.create(null);
      for (const entry of entries(value)) {
        for (const item of evaluate(entry, args[0], ctx)) {
          const obj = asQueryRecord(item);
          if (!obj) continue;
          const key = obj.key ?? obj.k ?? obj.name ?? obj.Name ?? obj.K ?? obj.Key;
          safeSet(out, entryKey(key, yq), obj.value ?? obj.v ?? null);
        }
      }
      return [out];
    }
    case "map":
    case "map_values": {
      if (args.length === 0) return null;
      if (value === null && yq) return [[]];
      const map = asQueryRecord(value);
      if (value === null || !(Array.isArray(value) || map)) {
        return cannotIterate(value);
      }
      // map over a map is [.[] | f], which upstream answered null
      if (name === "map" && map) {
        return [
          Object.values(map).flatMap((item) =>
            evaluate(item as QueryValue, args[0], ctx),
          ),
        ];
      }
      return null;
    }
    case "min":
    case "max":
      if (value === null && yq) return [];
      if (!Array.isArray(value)) {
        throw new Error(
          `${described(value)} and ${described(value)} cannot be iterated over`,
        );
      }
      return null;
    case "join":
    case "flatten":
      if (value === null || isScalar(value)) cannotIterate(value);
      return null;
    case "any":
    case "all":
      if (args.length === 0 && (value === null || isScalar(value))) {
        cannotIterate(value);
      }
      return null;
    case "sort":
    case "sort_by":
    case "unique":
    case "unique_by":
    case "group_by": {
      if (!Array.isArray(value)) {
        if (name === "sort" || name === "unique") {
          throw new Error(
            `${described(value)} cannot be sorted, as it is not an array`,
          );
        }
        return cannotIterate(value);
      }
      if (name === "sort" || name === "sort_by") return null;
      const key =
        name === "unique"
          ? (item: QueryValue) => item
          : (item: QueryValue) => evaluate(item, args[0], ctx)[0] ?? null;
      // mikefarah keeps the order things were first seen in, jq sorts by key
      const groups = byKey(value, key, yq);
      if (!yq) groups.sort((a, b) => compareJq(key(a[0]), key(b[0])));
      return name === "group_by" ? [groups] : [groups.map((g) => g[0])];
    }
    case "reverse":
      if (value === null && !yq) return [[]];
      if (yq && !Array.isArray(value) && typeof value !== "string") {
        throw new Error(`${described(value)} cannot be reversed`);
      }
      return null;
    case "@base64":
      if (typeof value === "string") return null;
      if (yq) throw new Error(`${described(value)} cannot be base64 encoded`);
      return [Buffer.from(JSON.stringify(value), "utf-8").toString("base64")];
    case "@csv":
    case "@tsv": {
      if (yq) return [csvRows(value, name === "@csv" ? "," : "\t")];
      if (!Array.isArray(value)) {
        throw new Error(
          `${described(value)} cannot be ${name.slice(1)}-formatted, only array`,
        );
      }
      // jq quotes every string in a csv row and escapes a tsv cell
      const cell = (item: QueryValue): string => {
        if (item === null || item === undefined) return "";
        if (typeof item === "object") {
          throw new Error(
            `${described(item)} is not valid in a ${name.slice(1)} row`,
          );
        }
        if (typeof item !== "string") return String(item);
        return name === "@csv"
          ? `"${item.replaceAll('"', '""')}"`
          : item
              .replaceAll("\\", "\\\\")
              .replaceAll("\t", "\\t")
              .replaceAll("\n", "\\n")
              .replaceAll("\r", "\\r");
      };
      return [value.map(cell).join(name === "@csv" ? "," : "\t")];
    }
    case "@sh":
      return [shellText(value, yq)];
    case "@uri":
      if (yq && typeof value !== "string") {
        throw new Error(
          `cannot encode ${yamlTag(value)} as URI, can only operate on strings`,
        );
      }
      return null;
    case "tostring":
      // mikefarah spells a map or a list as YAML
      if (yq && value !== null && typeof value === "object") {
        return [YAML.stringify(value, { indent: 2 }).trimEnd()];
      }
      return null;
    case "type":
      return yq ? [yamlTag(value)] : null;
    case "tag":
      return [yamlTag(value)];
    case "kind":
      if (Array.isArray(value)) return ["seq"];
      return [asQueryRecord(value) ? "map" : "scalar"];
    case "upcase":
    case "downcase":
    case "ascii_upcase":
    case "ascii_downcase":
      if (typeof value !== "string") {
        throw new Error(`${described(value)} cannot change case`);
      }
      if (name === "upcase") return [value.toUpperCase()];
      if (name === "downcase") return [value.toLowerCase()];
      return null;
    case "env": {
      if (args.length === 0) return null;
      const variable = variableName(value, args[0], ctx, evaluate);
      const text = ctx.env?.get(variable);
      if (text === undefined) {
        throw new Error(
          `value for env variable '${variable}' not provided in env()`,
        );
      }
      return [yamlValue(text)];
    }
    case "strenv": {
      if (args.length === 0) return null;
      const variable = variableName(value, args[0], ctx, evaluate);
      return [ctx.env?.get(variable) ?? ""];
    }
    case "tojson":
      return yq ? [jsonText(value, 2)] : null;
    case "to_json": {
      const indent =
        args.length > 0 ? Number(evaluate(value, args[0], ctx)[0]) : 2;
      return [jsonText(value, Number.isFinite(indent) ? indent : 2)];
    }
    case "documentIndex":
    case "di":
      return [ctx.source?.document ?? 0];
    case "fileIndex":
    case "fi":
      return [ctx.source?.file ?? 0];
    case "filename":
      return [ctx.source?.filename ?? null];
    case "to_number":
      if (typeof value === "number") return [value];
      if (typeof value === "string" && /^\s*[-+]?(\d|\.\d)/.test(value)) {
        const number = Number(value);
        if (Number.isFinite(number)) return [number];
      }
      throw new Error(`${described(value)} cannot be parsed as a number`);
    case "to_string":
      return evaluate(value, { type: "Call", name: "tostring", args: [] }, ctx);
    case "@yaml":
    case "to_yaml":
      return [YAML.stringify(value, { indent: 2 })];
    case "@yamld":
    case "from_yaml":
      if (typeof value !== "string") notString(value);
      return [yamlValue(value)];
    case "@jsond":
    case "from_json":
      return evaluate(value, { type: "Call", name: "fromjson", args: [] }, ctx);
    case "@props":
      return [propsText(value)];
    case "sort_keys":
      if (args.length === 0) return null;
      return evaluate(value, sortKeysUpdate(args[0]), ctx);
    case "pick":
    case "omit": {
      // mikefarah's array of keys; jq's pick takes a path expression
      if (!yq || args.length !== 1 || args[0].type !== "Array") {
        return null;
      }
      const wanted = evaluate(value, args[0], ctx)[0] as QueryValue[];
      if (Array.isArray(value)) {
        const keep = (i: number) => wanted.includes(i) === (name === "pick");
        return [
          name === "pick"
            ? wanted.filter((i) => typeof i === "number" && i < value.length)
                .map((i) => value[i as number])
            : value.filter((_, i) => keep(i)),
        ];
      }
      const map = asQueryRecord(value);
      if (!map) return name === "pick" ? [null] : [value];
      const keys =
        name === "pick"
          ? wanted.filter(
              (k): k is string => typeof k === "string" && Object.hasOwn(map, k),
            )
          : Object.keys(map).filter((k) => !wanted.includes(k));
      return [record(keys.map((k) => [k, map[k]]))];
    }
    case "filter":
      if (args.length === 0) return null;
      return evaluate(
        value,
        {
          type: "Array",
          elements: {
            type: "Pipe",
            left: { type: "Iterate" },
            right: { type: "Call", name: "select", args },
          },
        },
        ctx,
      );
    case "any_c":
    case "all_c": {
      if (args.length === 0) return null;
      if (!Array.isArray(value) && !asQueryRecord(value)) cannotIterate(value);
      const items = Object.values(value as object) as QueryValue[];
      const test = (item: QueryValue) =>
        evaluate(item, args[0], ctx).some(
          (v) => v !== null && v !== undefined && v !== false,
        );
      return [name === "any_c" ? items.some(test) : items.every(test)];
    }
    case "key": {
      const path = sourcePath(value, name, ctx);
      return [path && path.length > 0 ? path[path.length - 1] : null];
    }
    case "path":
      if (args.length > 0) return null;
      return [sourcePath(value, name, ctx) ?? null];
    case "with":
      if (args.length !== 2) return null;
      return evaluate(
        value,
        { type: "UpdateOp", op: "|=", path: args[0], value: args[1] },
        ctx,
      );
    case "splitDoc":
    case "split_doc":
      return [value];
    case "load":
    case "load_str": {
      if (args.length !== 1) return null;
      const file =
        args[0].type === "Literal" && typeof args[0].value === "string"
          ? args[0].value
          : "";
      return [loaded(ctx, file, name === "load_str")];
    }
    case "explode":
      // mikefarah's explode(.): aliases are copies once read, so nothing is
      // left to explode; jq's explode/0 splits a string into codepoints
      return args.length === 1 ? [value] : null;
    case "line":
    case "column":
      return [0];
    case "ireduce":
      if (!yq) throw new Error("ireduce is mikefarah's yq, not jq: use reduce");
      return evaluate(value, args[0], ctx);
  }
  if (NODE_TEXT.has(name) && args.length === 0) return [""];
  if (name === "tag=" && args.length === 1) {
    return [retyped(value, evaluate(value, args[0], ctx)[0] ?? null)];
  }
  if (SETTERS.has(name)) {
    if (!yq) throw new Error(`${name} is mikefarah's yq, not jq`);
    if (name === "tag=") {
      const tags = evaluate(value, args[1], ctx);
      return evaluate(
        value,
        {
          type: "UpdateOp",
          op: "|=",
          path: args[0],
          value: { type: "Call", name, args: [{ type: "Literal", value: tags[0] ?? null }] },
        },
        ctx,
      );
    }
    if (clearsComments({ type: "Call", name, args })) return [value];
    const what = name.slice(0, -1);
    throw new Error(
      `${what} cannot be set: values here carry no style, comments or anchors, and the output has none`,
    );
  }
  return null;
}
