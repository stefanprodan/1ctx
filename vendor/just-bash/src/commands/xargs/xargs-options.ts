/**
 * (1ctx) xargs' arguments read as GNU xargs 4.11 reads them through getopt:
 * a short option's value attached or apart, booleans clustered with a
 * value option last, long options with `=` or apart and by any unique
 * prefix, `--` ending the options and the first operand starting the
 * command.
 */

import type { ExecResult } from "../../types.js";

export type XargsInputMode = "blank" | "null" | "delimiter";

export interface XargsOptions {
  mode: XargsInputMode;
  /** the -d character */
  delimiter: string;
  /** the logical end-of-file item, or null for none */
  eof: string | null;
  replace: string | null;
  maxLines: number | null;
  maxArgs: number | null;
  /** 0 asks for as many as possible */
  maxProcs: number;
  /** -s as given, or null for the default */
  maxChars: number | null;
  argFile: string | null;
  slotVar: string | null;
  noRunIfEmpty: boolean;
  verbose: boolean;
  exit: boolean;
  interactive: boolean;
  openTty: boolean;
  showLimits: boolean;
  command: string[];
  /** warnings in the order GNU prints them */
  warnings: string[];
}

export type ParsedArgs =
  | { kind: "run"; options: XargsOptions }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; result: ExecResult };

/** GNU's largest -P, an int. */
const MAX_PROCS_LIMIT = 2147483647;

const TRY = "Try 'xargs --help' for more information.\n";

function usageError(message: string): ParsedArgs {
  return {
    kind: "error",
    result: { stdout: "", stderr: `xargs: ${message}\n${TRY}`, exitCode: 1 },
  };
}

function plainError(message: string): ParsedArgs {
  return {
    kind: "error",
    result: { stdout: "", stderr: `xargs: ${message}\n`, exitCode: 1 },
  };
}

type ArgKind = "none" | "required" | "optional";

interface LongOption {
  name: string;
  arg: ArgKind;
  /** the short option it stands for */
  short: string;
}

// GNU's table order, which its ambiguity message lists
const LONG_OPTIONS: LongOption[] = [
  { name: "null", arg: "none", short: "0" },
  { name: "arg-file", arg: "required", short: "a" },
  { name: "delimiter", arg: "required", short: "d" },
  { name: "eof", arg: "optional", short: "e" },
  { name: "replace", arg: "optional", short: "i" },
  { name: "max-lines", arg: "optional", short: "l" },
  { name: "max-args", arg: "required", short: "n" },
  { name: "open-tty", arg: "none", short: "o" },
  { name: "no-run-if-empty", arg: "none", short: "r" },
  { name: "max-chars", arg: "required", short: "s" },
  { name: "verbose", arg: "none", short: "t" },
  { name: "show-limits", arg: "none", short: "show-limits" },
  { name: "exit", arg: "none", short: "x" },
  { name: "max-procs", arg: "required", short: "P" },
  { name: "version", arg: "none", short: "version" },
  { name: "help", arg: "none", short: "help" },
  { name: "interactive", arg: "none", short: "p" },
  { name: "process-slot-var", arg: "required", short: "process-slot-var" },
];

const SHORT_OPTIONS: Record<string, ArgKind> = {
  "0": "none",
  a: "required",
  d: "required",
  E: "required",
  e: "optional",
  I: "required",
  i: "optional",
  L: "required",
  l: "optional",
  n: "required",
  o: "none",
  P: "required",
  p: "none",
  r: "none",
  s: "required",
  t: "none",
  x: "none",
};

/** A number as strtol reads it: leading blanks, a sign, digits, nothing after. */
function readNumber(value: string): bigint | null {
  const match = /^[ \t\n\v\f\r]*([+-]?\d+)$/.exec(value);
  return match ? BigInt(match[1]) : null;
}

function clampInt(n: bigint, max: number): number {
  return n > BigInt(max) ? max : Number(n);
}

const C_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
};

/** The -d character, or GNU's words for a specification it refuses. */
export function parseDelimiter(
  spec: string,
): { ok: true; char: string } | { ok: false; message: string } {
  const invalid = {
    ok: false as const,
    message:
      `Invalid input delimiter specification ${spec}: the delimiter must ` +
      "be either a single character or an escape sequence starting with \\.",
  };
  if (spec.length === 1 && spec.charCodeAt(0) < 0x80) {
    return { ok: true, char: spec };
  }
  if (spec.length < 2 || spec[0] !== "\\") return invalid;
  const body = spec.slice(1);
  let code: number | null = null;
  let used = 0;
  if (C_ESCAPES[body[0]] !== undefined) {
    code = C_ESCAPES[body[0]].charCodeAt(0);
    used = 1;
  } else if (body[0] === "x") {
    const hex = /^x([0-9a-fA-F]{1,2})/.exec(body);
    if (hex) {
      code = Number.parseInt(hex[1], 16);
      used = hex[0].length;
    }
  } else if (/[0-7]/.test(body[0])) {
    const oct = /^[0-7]{1,3}/.exec(body);
    if (oct) {
      code = Number.parseInt(oct[0], 8);
      used = oct[0].length;
    }
  }
  if (code === null || code > 0xff) {
    return {
      ok: false,
      message: `Invalid escape sequence ${spec} in input delimiter specification.`,
    };
  }
  if (used < body.length) {
    return {
      ok: false,
      message:
        `Invalid escape sequence ${spec} in input delimiter specification; ` +
        `trailing characters ${body.slice(used)} not recognised.`,
    };
  }
  return { ok: true, char: String.fromCharCode(code) };
}

export function parseXargsArgs(args: string[]): ParsedArgs {
  const o: XargsOptions = {
    mode: "blank",
    delimiter: "\n",
    eof: null,
    replace: null,
    maxLines: null,
    maxArgs: null,
    maxProcs: 1,
    maxChars: null,
    argFile: null,
    slotVar: null,
    noRunIfEmpty: false,
    verbose: false,
    exit: false,
    interactive: false,
    openTty: false,
    showLimits: false,
    command: [],
    warnings: [],
  };
  const exclusive = (previous: string, next: string) =>
    o.warnings.push(
      `options ${previous} and ${next} are mutually exclusive, ` +
        `ignoring previous ${previous} value`,
    );
  const setMaxLines = (n: number) => {
    if (o.maxArgs !== null) {
      exclusive("--max-args", "-L");
      o.maxArgs = null;
    }
    if (o.replace !== null) {
      exclusive("--replace", "-L");
      o.replace = null;
    }
    o.maxLines = n;
  };
  const setReplace = (r: string) => {
    if (o.maxArgs !== null) {
      exclusive("--max-args", "--replace/-I/-i");
      o.maxArgs = null;
    }
    if (o.maxLines !== null) {
      exclusive("--max-lines", "--replace/-I/-i");
      o.maxLines = null;
    }
    o.replace = r;
  };
  const setMaxArgs = (n: number) => {
    // -n1 does not conflict with -I, which runs one line at a time
    if (o.replace !== null && n === 1) return;
    if (o.replace !== null) {
      exclusive("--replace", "--max-args/-n");
      o.replace = null;
    }
    if (o.maxLines !== null) {
      exclusive("--max-lines", "--max-args/-n");
      o.maxLines = null;
    }
    o.maxArgs = n;
  };
  const lineCount = (value: string, letter: string): number | ParsedArgs => {
    const n = readNumber(value);
    if (n === null) {
      return usageError(`invalid number "${value}" for -${letter} option`);
    }
    if (n < 1n) {
      return usageError(`value ${n} for -${letter} option should be >= 1`);
    }
    return clampInt(n, MAX_PROCS_LIMIT);
  };

  /** Applies one option; returns a result that ends the parse. */
  const apply = (
    key: string,
    value: string | undefined,
  ): ParsedArgs | undefined => {
    switch (key) {
      case "0":
        o.mode = "null";
        return;
      case "a":
        o.argFile = value as string;
        return;
      case "d": {
        const d = parseDelimiter(value as string);
        if (!d.ok) return plainError(d.message);
        o.mode = "delimiter";
        o.delimiter = d.char;
        return;
      }
      case "E":
      case "e":
        o.eof = value ? value : null;
        return;
      case "I":
        setReplace(value as string);
        return;
      case "i":
        setReplace(value ?? "{}");
        return;
      case "L":
      case "l": {
        if (key === "l" && value === undefined) {
          setMaxLines(1);
          return;
        }
        const n = lineCount(value as string, key);
        if (typeof n !== "number") return n;
        setMaxLines(n);
        return;
      }
      case "n": {
        const n = readNumber(value as string);
        if (n === null) {
          return usageError(`invalid number "${value}" for -n option`);
        }
        if (n < 1n) return usageError(`value ${n} for -n option should be >= 1`);
        setMaxArgs(clampInt(n, MAX_PROCS_LIMIT));
        return;
      }
      case "P": {
        const n = readNumber(value as string);
        if (n === null) {
          return usageError(`invalid number "${value}" for -P option`);
        }
        if (n < 0n) return usageError(`value ${n} for -P option should be >= 0`);
        if (n > BigInt(MAX_PROCS_LIMIT)) {
          return usageError(
            `value ${n} for -P option should be <= ${MAX_PROCS_LIMIT}`,
          );
        }
        o.maxProcs = Number(n);
        return;
      }
      case "s": {
        const n = readNumber(value as string);
        if (n === null) {
          return usageError(`invalid number "${value}" for -s option`);
        }
        if (n < 1n) {
          o.warnings.push(`value ${n} for -s option should be >= 1`);
          o.maxChars = 1;
          return;
        }
        o.maxChars = clampInt(n, Number.MAX_SAFE_INTEGER);
        return;
      }
      case "o":
        o.openTty = true;
        return;
      case "p":
        o.interactive = true;
        o.verbose = true;
        return;
      case "r":
        o.noRunIfEmpty = true;
        return;
      case "t":
        o.verbose = true;
        return;
      case "x":
        o.exit = true;
        return;
      case "show-limits":
        o.showLimits = true;
        return;
      case "process-slot-var":
        if ((value as string).includes("=")) {
          return plainError(
            "option --process-slot-var may not be set to a value which includes `='",
          );
        }
        if (value === "") {
          return plainError(
            "failed to unset environment variable : Invalid argument",
          );
        }
        o.slotVar = value as string;
        return;
      case "version":
        return { kind: "version" };
      case "help":
        return { kind: "help" };
    }
    return undefined;
  };

  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = arg.slice(2, eq === -1 ? undefined : eq);
      const attached = eq === -1 ? undefined : arg.slice(eq + 1);
      const exact = LONG_OPTIONS.find((l) => l.name === name);
      const matches = exact
        ? [exact]
        : LONG_OPTIONS.filter((l) => l.name.startsWith(name));
      if (matches.length === 0) {
        return usageError(`unrecognized option '${arg}'`);
      }
      if (matches.length > 1) {
        const names = matches.map((l) => `'--${l.name}'`).join(" ");
        return usageError(
          `option '${arg}' is ambiguous; possibilities: ${names}`,
        );
      }
      const long = matches[0];
      let value = attached;
      if (long.arg === "none" && value !== undefined) {
        return usageError(`option '--${long.name}' doesn't allow an argument`);
      }
      if (long.arg === "required" && value === undefined) {
        if (i + 1 >= args.length) {
          return usageError(`option '--${long.name}' requires an argument`);
        }
        value = args[++i];
      }
      const done = apply(long.short, value);
      if (done) return done;
      continue;
    }
    if (arg.length < 2 || arg[0] !== "-") break;
    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j];
      const kind = SHORT_OPTIONS[letter];
      if (kind === undefined) {
        return usageError(`invalid option -- '${letter}'`);
      }
      let value: string | undefined;
      if (kind !== "none") {
        const rest = arg.slice(j + 1);
        if (rest !== "") {
          value = rest;
        } else if (kind === "required") {
          if (i + 1 >= args.length) {
            return usageError(`option requires an argument -- '${letter}'`);
          }
          value = args[++i];
        }
        j = arg.length;
      }
      const done = apply(letter, value);
      if (done) return done;
    }
  }
  o.command = args.slice(i);
  if (o.eof !== null && o.mode !== "blank") {
    o.warnings.push("the -E option has no effect if -0 or -d is used.");
    o.eof = null;
  }
  return { kind: "run", options: o };
}
