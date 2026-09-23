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

/**
 * mikefarah's answer for arithmetic his yq takes and jq does not: a string
 * and a number or boolean concatenate, a null in -, *, / or % drops the
 * result (a missing key does there; our values cannot tell it from a null
 * one), a map and a scalar fail. Undefined leaves the operands to jq's
 * rules.
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
    return undefined;
  }
  if (op === "-" || op === "*" || op === "/" || op === "%") {
    if (l === null || r === null) return [];
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

/** ==: in mikefarah's yq a * in a right-hand string is a wildcard. */
export function equalOperands(
  l: QueryValue,
  r: QueryValue,
  dialect: Dialect | undefined,
): boolean {
  if (
    dialect === "yq" &&
    typeof l === "string" &&
    typeof r === "string" &&
    r.includes("*")
  ) {
    return globMatch(l, r);
  }
  return deepEqual(l, r);
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

// first-seen order, as mikefarah's unique and group_by keep it
function byKey(
  value: QueryValue[],
  key: (item: QueryValue) => QueryValue,
): QueryValue[][] {
  const groups: { key: QueryValue; items: QueryValue[] }[] = [];
  for (const item of value) {
    const k = key(item);
    const group = groups.find((g) => deepEqual(g.key, k));
    if (group) group.items.push(item);
    else groups.push({ key: k, items: [item] });
  }
  return groups.map((g) => g.items);
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
// as a call of the name and `=` (1ctx)
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
// function it does not follow has none
function sourcePath(
  value: QueryValue,
  ctx: EvalContext,
): (string | number)[] | undefined {
  const node = ctx.sourceNode;
  if (node === undefined) return ctx.currentPath;
  return Object.is(node.value, value) && node.path ? [...node.path] : undefined;
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
    case "map_values":
      if (args.length === 0) return null;
      if (value === null && yq) return [[]];
      if (value === null || !(Array.isArray(value) || asQueryRecord(value))) {
        return cannotIterate(value);
      }
      return null;
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
      const groups = byKey(value, key);
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
      const path = sourcePath(value, ctx);
      return [path && path.length > 0 ? path[path.length - 1] : null];
    }
    case "path":
      if (args.length > 0) return null;
      return [sourcePath(value, ctx) ?? null];
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
  }
  if (NODE_TEXT.has(name) && args.length === 0) return [""];
  if (SETTERS.has(name)) {
    if (!yq) throw new Error(`${name} is mikefarah's yq, not jq`);
    // the value is evaluated for its errors; the node keeps its style,
    // comments and tags, which our values do not carry
    evaluate(value, args[1], ctx);
    return [value];
  }
  return null;
}
