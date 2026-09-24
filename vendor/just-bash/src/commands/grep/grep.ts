import { decodeBytesToUtf8, utf8ByteLength } from "../../encoding.js";
import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import type { UserRegex } from "../../regex/index.js";
import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import { matchGlob } from "../../utils/glob.js";
import { showHelp } from "../help.js";
import { GnuPatternError } from "../search-engine/gnu-regex.js";
import {
  buildPatterns,
  type RegexMode,
  searchContent,
} from "../search-engine/index.js";

/**
 * The name GNU grep prints for the `-` operand. It appears wherever a real
 * file name would: the multi-file `file:line` prefix, `-l`/`-L` listings and
 * `-c` counts.
 */
const STDIN_FILENAME = "(standard input)";

/** File entry with optional type info from glob expansion */
interface FileEntry {
  path: string;
  isFile?: boolean; // undefined means we need to stat
  /** True for the `-` operand, which names standard input instead of a file. */
  isStdin?: boolean;
  /**
   * True when an earlier `-` already drained stdin. stdin is a stream, so the
   * second `-` of `grep pat - -` reads EOF and contributes nothing.
   */
  stdinAtEof?: boolean;
  /** (1ctx) a read or a walk failed here: what to say */
  error?: string;
}

interface GrepTraversalBudget {
  operations: number;
  results: number;
  maxOperations: number;
  maxResults: number;
}

function getMatcherWorkLimit(ctx: RuntimeCommandContext): number {
  const loopLimit = ctx.limits.maxLoopIterations;
  const arrayLimit = ctx.limits.maxArrayElements;
  return Math.max(loopLimit, Math.min(arrayLimit, loopLimit * 10));
}

function useTraversalOperation(budget: GrepTraversalBudget): void {
  if (++budget.operations > budget.maxOperations) {
    throw new ExecutionLimitError(
      `grep: glob operation limit exceeded (${budget.maxOperations})`,
      "glob_operations",
    );
  }
}

function addTraversalResult(budget: GrepTraversalBudget): void {
  if (budget.results >= budget.maxResults) {
    throw new ExecutionLimitError(
      `grep: array element limit exceeded (${budget.maxResults})`,
      "array_elements",
    );
  }
  budget.results++;
}

/**
 * A regex that can never match anything, used when the pattern list is empty
 * (e.g. `grep -f /dev/null`). `[^\s\S]` is the empty character class: no
 * codepoint is both non-whitespace and non-non-whitespace. Wrapping it for
 * -x (`^(?:...)$`) keeps it unmatchable.
 */
const NEVER_MATCHES = "[^\\s\\S]";

/**
 * Split a `-e`/positional PATTERNS operand into individual patterns.
 *
 * GNU grep documents PATTERNS as "one or more patterns separated by newline
 * characters", so a trailing newline yields a trailing empty pattern (which
 * matches every line). Verified against GNU grep 3.12:
 *   grep -e $'cherry\n' FILE   # prints every line
 */
function splitPatternOperand(value: string): string[] {
  return value.split("\n");
}

/**
 * Split the contents of a `-f FILE` pattern file into individual patterns.
 *
 * Unlike `-e`, the final newline of a pattern file is a terminator rather than
 * a separator, so it does not produce a trailing empty pattern. An empty file
 * contributes no patterns at all. Interior empty lines are kept: an empty
 * pattern matches every line. Verified against GNU grep 3.12.
 */
function splitPatternFile(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const grepHelp = {
  name: "grep",
  summary: "print lines that match patterns",
  usage: "grep [OPTION]... PATTERNS [FILE]...",
  description: [
    "Search for PATTERNS in each FILE.",
    "With no FILE, read standard input, or . with -r.",
  ],
  options: [
    "-E, --extended-regexp     PATTERNS are extended regular expressions",
    "-F, --fixed-strings       PATTERNS are strings",
    "-G, --basic-regexp        PATTERNS are basic regular expressions",
    "-P, --perl-regexp         PATTERNS are Perl regular expressions",
    "-e, --regexp=PATTERNS     use PATTERNS for matching",
    "-f, --file=FILE           take PATTERNS from FILE",
    "-i, --ignore-case         ignore case distinctions in patterns and data",
    "    --no-ignore-case      do not ignore case distinctions (default)",
    "-w, --word-regexp         match only whole words",
    "-x, --line-regexp         match only whole lines",
    "-z, --null-data           a data line ends in 0 byte, not newline",
    "-s, --no-messages         suppress error messages",
    "-v, --invert-match        select non-matching lines",
    "-V, --version             display version information and exit",
    "-m, --max-count=NUM       stop after NUM selected lines",
    "-b, --byte-offset         print the byte offset with output lines",
    "-n, --line-number         print line number with output lines",
    "-H, --with-filename       print file name with output lines",
    "-h, --no-filename         suppress the file name prefix on output",
    "    --label=LABEL         use LABEL as the standard input file name prefix",
    "-o, --only-matching       show only nonempty parts of lines that match",
    "-q, --quiet, --silent     suppress all normal output",
    "    --binary-files=TYPE   assume that binary files are TYPE;",
    "                          TYPE is 'binary', 'text', or 'without-match'",
    "-a, --text                equivalent to --binary-files=text",
    "-I                        equivalent to --binary-files=without-match",
    "-d, --directories=ACTION  how to handle directories: read, recurse, skip",
    "-r, --recursive           like --directories=recurse",
    "-R, --dereference-recursive  likewise, but follow all symlinks",
    "    --include=GLOB        search only files that match GLOB",
    "    --exclude=GLOB        skip files that match GLOB",
    "    --exclude-from=FILE   skip files that match any file pattern from FILE",
    "    --exclude-dir=GLOB    skip directories that match GLOB",
    "-L, --files-without-match print only names of FILEs with no selected lines",
    "-l, --files-with-matches  print only names of FILEs with selected lines",
    "-c, --count               print only a count of selected lines per FILE",
    "-T, --initial-tab         make tabs line up (if needed)",
    "-Z, --null                print 0 byte after FILE name",
    "-B, --before-context=NUM  print NUM lines of leading context",
    "-A, --after-context=NUM   print NUM lines of trailing context",
    "-C, --context=NUM         print NUM lines of output context",
    "-NUM                      same as --context=NUM",
    "    --group-separator=SEP  print SEP on line between matches with context",
    "    --no-group-separator  do not print separator for matches with context",
    "    --color[=WHEN]        WHEN is 'never' or 'auto'; 'always' is refused",
    "    --help                display this help and exit",
  ],
};

/** (1ctx) What a version probe gets: GNU grep's words, as we answer as it. */
const VERSION = `grep (GNU grep) 3.12
Copyright (C) 2025 Free Software Foundation, Inc.
License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.
This is free software: you are free to change and redistribute it.
There is NO WARRANTY, to the extent permitted by law.
`;

const USAGE =
  "Usage: grep [OPTION]... PATTERNS [FILE]...\n" +
  "Try 'grep --help' for more information.\n";

/** (1ctx) An argument GNU grep refuses, exit 2. */
class GrepUsageError extends Error {
  constructor(
    message: string,
    readonly usage = true,
  ) {
    super(message);
  }
}

/** (1ctx) What the arguments ask for, in GNU grep's terms. */
interface GrepOptions {
  matcher: "G" | "E" | "F" | "P" | null;
  /** -e values and -f files, in the order given */
  sources: { kind: "e" | "f"; value: string }[];
  ignoreCase: boolean;
  invertMatch: boolean;
  countOnly: boolean;
  filesWithMatches: boolean;
  filesWithoutMatch: boolean;
  showLineNumbers: boolean;
  onlyMatching: boolean;
  quietMode: boolean;
  wholeWord: boolean;
  lineRegexp: boolean;
  noMessages: boolean;
  withFilename: boolean | null;
  maxCount: number | undefined;
  before: number | undefined;
  after: number | undefined;
  context: number | undefined;
  directories: "read" | "skip" | "recurse";
  dereference: boolean;
  includePatterns: string[];
  excludePatterns: string[];
  excludeDirPatterns: string[];
  /** --exclude-from files, read once the options are parsed */
  excludeFrom: string[];
  byteOffset: boolean;
  initialTab: boolean;
  /** -Z: a NUL after a file name */
  nullAfterName: boolean;
  /** -z: NUL-terminated lines */
  nullData: boolean;
  binaryFiles: "binary" | "text" | "without-match";
  label: string | null;
  /** null for --no-group-separator */
  groupSeparator: string | null;
  /** -V, or --help for an unknown --color word, as GNU does */
  version: boolean;
  help: boolean;
}

type ArgKind = "none" | "required" | "optional";

interface OptionSpec {
  arg: ArgKind;
  apply: (o: GrepOptions, value: string) => void;
}

function contextLength(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new GrepUsageError(`${value}: invalid context length argument`, false);
  }
  return Number(value);
}

function setMatcher(o: GrepOptions, matcher: "G" | "E" | "F" | "P"): void {
  if (o.matcher !== null && o.matcher !== matcher) {
    throw new GrepUsageError("conflicting matchers specified", false);
  }
  o.matcher = matcher;
}

function choice<T extends string>(
  name: string,
  value: string,
  valid: readonly T[],
): T {
  if ((valid as readonly string[]).includes(value)) return value as T;
  throw new GrepUsageError(
    `invalid argument '${value}' for '--${name}'\nValid arguments are:\n${valid
      .map((v) => `  - '${v}'`)
      .join("\n")}`,
  );
}

/** (1ctx) Escapes never help a model, so only plain output is accepted. */
function color(o: GrepOptions, value: string): void {
  if (["always", "yes", "force"].includes(value)) {
    throw new GrepUsageError(
      `--color=${value} is not supported: output is always plain`,
      false,
    );
  }
  // GNU answers an unknown word with its help, and exit 0
  if (!["", "never", "no", "none", "auto", "tty", "if-tty"].includes(value)) {
    o.help = true;
  }
}

const flag =
  (apply: (o: GrepOptions) => void): OptionSpec["apply"] =>
  (o) =>
    apply(o);

const SPECS = {
  E: { arg: "none", apply: flag((o) => setMatcher(o, "E")) },
  F: { arg: "none", apply: flag((o) => setMatcher(o, "F")) },
  G: { arg: "none", apply: flag((o) => setMatcher(o, "G")) },
  P: { arg: "none", apply: flag((o) => setMatcher(o, "P")) },
  e: {
    arg: "required",
    apply: (o, v) => o.sources.push({ kind: "e", value: v }),
  },
  f: {
    arg: "required",
    apply: (o, v) => o.sources.push({ kind: "f", value: v }),
  },
  i: { arg: "none", apply: flag((o) => (o.ignoreCase = true)) },
  v: { arg: "none", apply: flag((o) => (o.invertMatch = true)) },
  w: { arg: "none", apply: flag((o) => (o.wholeWord = true)) },
  x: { arg: "none", apply: flag((o) => (o.lineRegexp = true)) },
  c: { arg: "none", apply: flag((o) => (o.countOnly = true)) },
  l: { arg: "none", apply: flag((o) => (o.filesWithMatches = true)) },
  L: { arg: "none", apply: flag((o) => (o.filesWithoutMatch = true)) },
  n: { arg: "none", apply: flag((o) => (o.showLineNumbers = true)) },
  h: { arg: "none", apply: flag((o) => (o.withFilename = false)) },
  H: { arg: "none", apply: flag((o) => (o.withFilename = true)) },
  y: { arg: "none", apply: flag((o) => (o.ignoreCase = true)) },
  b: { arg: "none", apply: flag((o) => (o.byteOffset = true)) },
  T: { arg: "none", apply: flag((o) => (o.initialTab = true)) },
  Z: { arg: "none", apply: flag((o) => (o.nullAfterName = true)) },
  z: { arg: "none", apply: flag((o) => (o.nullData = true)) },
  a: { arg: "none", apply: flag((o) => (o.binaryFiles = "text")) },
  I: { arg: "none", apply: flag((o) => (o.binaryFiles = "without-match")) },
  // CR stripping is DOS-only, so -U changes nothing here
  U: { arg: "none", apply: flag(() => {}) },
  V: { arg: "none", apply: flag((o) => (o.version = true)) },
  D: {
    arg: "required",
    apply: (_o, v) => {
      choice("devices", v, ["read", "skip"] as const);
    },
  },
  o: { arg: "none", apply: flag((o) => (o.onlyMatching = true)) },
  q: { arg: "none", apply: flag((o) => (o.quietMode = true)) },
  s: { arg: "none", apply: flag((o) => (o.noMessages = true)) },
  r: {
    arg: "none",
    apply: flag((o) => {
      o.directories = "recurse";
    }),
  },
  R: {
    arg: "none",
    apply: flag((o) => {
      o.directories = "recurse";
      o.dereference = true;
    }),
  },
  d: {
    arg: "required",
    apply: (o, v) => {
      o.directories = choice("directories", v, [
        "read",
        "recurse",
        "skip",
      ] as const);
    },
  },
  m: {
    arg: "required",
    apply: (o, v) => {
      if (!/^-?[0-9]+$/.test(v)) {
        throw new GrepUsageError("invalid max count", false);
      }
      const n = Number(v);
      o.maxCount = n < 0 ? undefined : n;
    },
  },
  A: { arg: "required", apply: (o, v) => (o.after = contextLength(v)) },
  B: { arg: "required", apply: (o, v) => (o.before = contextLength(v)) },
  C: { arg: "required", apply: (o, v) => (o.context = contextLength(v)) },
} satisfies Record<string, OptionSpec>;

const COLOR: OptionSpec = { arg: "optional", apply: (o, v) => color(o, v) };

const LONG: Record<string, OptionSpec> = {
  "extended-regexp": SPECS.E,
  "fixed-strings": SPECS.F,
  "basic-regexp": SPECS.G,
  "perl-regexp": SPECS.P,
  regexp: SPECS.e,
  file: SPECS.f,
  "ignore-case": SPECS.i,
  "invert-match": SPECS.v,
  "word-regexp": SPECS.w,
  "line-regexp": SPECS.x,
  count: SPECS.c,
  "files-with-matches": SPECS.l,
  "files-without-match": SPECS.L,
  "line-number": SPECS.n,
  "no-filename": SPECS.h,
  "with-filename": SPECS.H,
  "no-ignore-case": { arg: "none", apply: flag((o) => (o.ignoreCase = false)) },
  "byte-offset": SPECS.b,
  "initial-tab": SPECS.T,
  null: SPECS.Z,
  "null-data": SPECS.z,
  text: SPECS.a,
  binary: SPECS.U,
  "line-buffered": { arg: "none", apply: flag(() => {}) },
  version: SPECS.V,
  devices: SPECS.D,
  "binary-files": {
    arg: "required",
    apply: (o, v) => {
      o.binaryFiles = choice("binary-files", v, [
        "binary",
        "text",
        "without-match",
      ] as const);
    },
  },
  label: { arg: "required", apply: (o, v) => (o.label = v) },
  "group-separator": {
    arg: "required",
    apply: (o, v) => (o.groupSeparator = v),
  },
  "no-group-separator": {
    arg: "none",
    apply: flag((o) => (o.groupSeparator = null)),
  },
  color: COLOR,
  colour: COLOR,
  "exclude-from": {
    arg: "required",
    apply: (o, v) => o.excludeFrom.push(v),
  },
  "only-matching": SPECS.o,
  quiet: SPECS.q,
  silent: SPECS.q,
  "no-messages": SPECS.s,
  recursive: SPECS.r,
  "dereference-recursive": SPECS.R,
  directories: SPECS.d,
  "max-count": SPECS.m,
  "after-context": SPECS.A,
  "before-context": SPECS.B,
  context: SPECS.C,
  include: {
    arg: "required",
    apply: (o, v) => o.includePatterns.push(v),
  },
  exclude: {
    arg: "required",
    apply: (o, v) => o.excludePatterns.push(v),
  },
  "exclude-dir": {
    arg: "required",
    // GNU strips the trailing slashes a directory is often written with
    apply: (o, v) => o.excludeDirPatterns.push(v.replace(/(.)\/+$/, "$1")),
  },
  help: { arg: "none", apply: flag((o) => (o.help = true)) },
};

/**
 * (1ctx) GNU grep's getopt_long: options may follow operands, `--` ends
 * them, a value follows in the same argument or the next, a value-taking
 * option may end a cluster, -NUM is -C NUM, and a long option may be
 * shortened to any unambiguous prefix.
 */
function parseGrepArgs(args: string[]): {
  options: GrepOptions;
  operands: string[];
} {
  const o: GrepOptions = {
    matcher: null,
    sources: [],
    ignoreCase: false,
    invertMatch: false,
    countOnly: false,
    filesWithMatches: false,
    filesWithoutMatch: false,
    showLineNumbers: false,
    onlyMatching: false,
    quietMode: false,
    wholeWord: false,
    lineRegexp: false,
    noMessages: false,
    withFilename: null,
    maxCount: undefined,
    before: undefined,
    after: undefined,
    context: undefined,
    directories: "read",
    dereference: false,
    includePatterns: [],
    excludePatterns: [],
    excludeDirPatterns: [],
    excludeFrom: [],
    byteOffset: false,
    initialTab: false,
    nullAfterName: false,
    nullData: false,
    binaryFiles: "binary",
    label: null,
    groupSeparator: "--",
    version: false,
    help: false,
  };
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      let spec = LONG[name];
      if (!spec) {
        const candidates = Object.keys(LONG).filter((n) => n.startsWith(name));
        const distinct = new Set(candidates.map((n) => LONG[n]));
        if (candidates.length === 0) {
          throw new GrepUsageError(
            `unrecognized option '${eq === -1 ? arg : arg.slice(0, eq)}'`,
          );
        }
        if (distinct.size > 1) {
          throw new GrepUsageError(
            `option '--${name}' is ambiguous; possibilities: ${candidates
              .map((n) => `'--${n}'`)
              .join(" ")}`,
          );
        }
        spec = LONG[candidates[0]];
      }
      const full = Object.keys(LONG).find((n) => LONG[n] === spec) ?? name;
      if (spec.arg === "none") {
        if (eq !== -1) {
          throw new GrepUsageError(
            `option '--${full}' doesn't allow an argument`,
          );
        }
        spec.apply(o, "");
      } else if (eq !== -1) {
        spec.apply(o, arg.slice(eq + 1));
      } else if (spec.arg === "optional") {
        spec.apply(o, "");
      } else if (i + 1 < args.length) {
        spec.apply(o, args[++i]);
      } else {
        throw new GrepUsageError(`option '--${full}' requires an argument`);
      }
      continue;
    }
    // a run of digits in one argument is one number, a new argument a new one
    let digits = "";
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (ch >= "0" && ch <= "9") {
        digits += ch;
        o.context = contextLength(digits);
        continue;
      }
      digits = "";
      const spec = (SPECS as Record<string, OptionSpec>)[ch];
      if (!spec) throw new GrepUsageError(`invalid option -- '${ch}'`);
      if (spec.arg === "none") {
        spec.apply(o, "");
        continue;
      }
      const rest = arg.slice(j + 1);
      if (rest !== "") spec.apply(o, rest);
      else if (i + 1 < args.length) spec.apply(o, args[++i]);
      else throw new GrepUsageError(`option requires an argument -- '${ch}'`);
      break;
    }
  }
  return { options: o, operands };
}

function usageError(error: GrepUsageError): ExecResult {
  return {
    stdout: "",
    stderr: `grep: ${error.message}\n${error.usage ? USAGE : ""}`,
    exitCode: 2,
  };
}

/**
 * (1ctx) A name suffix, as GNU grep matches --include and --exclude against
 * a command-line file: the whole name, or any part after a slash.
 */
function suffixMatches(name: string, patterns: string[]): boolean {
  const suffixes = [name];
  for (let i = name.indexOf("/"); i !== -1; i = name.indexOf("/", i + 1)) {
    if (i + 1 < name.length) suffixes.push(name.slice(i + 1));
  }
  return patterns.some((p) =>
    suffixes.some((s) => matchGlob(s, p, { stripQuotes: true })),
  );
}

function includedFile(
  name: string,
  include: string[],
  exclude: string[],
  commandLine: boolean,
): boolean {
  const base = name.split("/").pop() || name;
  const matches = (patterns: string[]) =>
    commandLine
      ? suffixMatches(name, patterns)
      : patterns.some((p) => matchGlob(base, p, { stripQuotes: true }));
  if (exclude.length > 0 && matches(exclude)) return false;
  if (include.length > 0 && !matches(include)) return false;
  return true;
}

export const grepCommand: RuntimeCommand = {
  name: "grep",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    let parsed: ReturnType<typeof parseGrepArgs>;
    try {
      parsed = parseGrepArgs(args);
    } catch (error) {
      if (error instanceof GrepUsageError) return usageError(error);
      throw error;
    }
    const { options: o, operands } = parsed;
    if (o.version) return { stdout: VERSION, stderr: "", exitCode: 0 };
    if (o.help) return showHelp(grepHelp);
    for (const excludeFile of o.excludeFrom) {
      try {
        const text = await ctx.fs.readFile(
          ctx.fs.resolvePath(ctx.cwd, excludeFile),
        );
        o.excludePatterns.push(...splitPatternFile(text));
      } catch (error) {
        rethrowFatalExecutionError(error);
        return {
          stdout: "",
          stderr: `grep: ${excludeFile}: ${fileErrorWords(error)}\n`,
          exitCode: 2,
        };
      }
    }

    const {
      ignoreCase,
      invertMatch,
      countOnly,
      filesWithMatches,
      filesWithoutMatch,
      showLineNumbers,
      onlyMatching,
      quietMode,
      wholeWord,
      lineRegexp,
      noMessages,
      maxCount,
      includePatterns,
      excludePatterns,
      excludeDirPatterns,
    } = o;
    const recursive = o.directories === "recurse";
    const beforeContext = o.before ?? o.context ?? 0;
    const afterContext = o.after ?? o.context ?? 0;
    // any context option separates groups, -A0 included
    const contextGiven =
      o.before !== undefined ||
      o.after !== undefined ||
      o.context !== undefined;

    // The first operand is the pattern only when no -e/-f pattern was given.
    if (o.sources.length === 0) {
      const pattern = operands.shift();
      if (pattern === undefined) {
        return { stdout: "", stderr: USAGE, exitCode: 2 };
      }
      o.sources.push({ kind: "e", value: pattern });
    }
    const files = operands;

    // Collect patterns: -e and -f in the order given, OR-combined as GNU does.
    const patterns: string[] = [];
    /** Where each pattern came from, for an error: a -f file and line. */
    const origins: (string | null)[] = [];
    /** True once `-f -` has drained stdin, so it can't also be searched. */
    let stdinUsedForPatterns = false;
    for (const source of o.sources) {
      if (source.kind === "e") {
        for (const pattern of splitPatternOperand(source.value)) {
          patterns.push(pattern);
          origins.push(null);
        }
        continue;
      }
      const patternFile = source.value;
      let content: string;
      if (patternFile === "") {
        // `-f ""` / `--file=` never names a file; GNU reports the empty name
        // rather than resolving it relative to the working directory.
        return {
          stdout: "",
          stderr: "grep: : No such file or directory\n",
          exitCode: 2,
        };
      }
      if (patternFile === "-") {
        // stdin is a stream: the first `-f -` drains it, any later one reads
        // EOF and contributes nothing.
        content = stdinUsedForPatterns ? "" : decodeBytesToUtf8(ctx.stdin);
        stdinUsedForPatterns = true;
      } else {
        try {
          const path = ctx.fs.resolvePath(ctx.cwd, patternFile);
          const stat = await ctx.fs.stat(path);
          if (stat.isDirectory) {
            return {
              stdout: "",
              stderr: `grep: ${patternFile}: Is a directory\n`,
              exitCode: 2,
            };
          }
          content = await ctx.fs.readFile(path);
        } catch (error) {
          rethrowFatalExecutionError(error);
          return {
            stdout: "",
            stderr: `grep: ${patternFile}: ${fileErrorWords(error)}\n`,
            exitCode: 2,
          };
        }
      }
      const filePatterns = splitPatternFile(content);
      if (patterns.length + filePatterns.length > ctx.limits.maxArrayElements) {
        throw new ExecutionLimitError(
          `grep: array element limit exceeded (${ctx.limits.maxArrayElements})`,
          "array_elements",
        );
      }
      patterns.push(...filePatterns);
      const shown = patternFile === "-" ? STDIN_FILENAME : patternFile;
      filePatterns.forEach((_, line) => {
        origins.push(`${shown}:${line + 1}: `);
      });
    }

    // -m 0 selects nothing and reads nothing, as GNU grep
    if (maxCount === 0) return { stdout: "", stderr: "", exitCode: 1 };

    // An empty pattern list (e.g. `grep -f /dev/null`) selects no lines at all.
    // GNU grep short-circuits: no output, no per-file counts, no "no such file"
    // diagnostics, exit 1. With -v every line is selected instead, and -L still
    // has to visit the files, so both keep the normal path with a regex that
    // can never match.
    if (patterns.length === 0 && !invertMatch && !filesWithoutMatch) {
      return { stdout: "", stderr: "", exitCode: 1 };
    }
    // Likewise -v with only the empty pattern, which every line matches.
    if (
      patterns.length === 1 &&
      patterns[0] === "" &&
      invertMatch &&
      !lineRegexp &&
      !wholeWord &&
      !filesWithoutMatch
    ) {
      return { stdout: "", stderr: "", exitCode: 1 };
    }

    const regexMode: RegexMode =
      o.matcher === "F"
        ? "fixed"
        : o.matcher === "E"
          ? "extended"
          : o.matcher === "P"
            ? "perl"
            : "basic";
    // GNU's PCRE backend cannot express an alternation of independent
    // patterns, so it refuses more than one under -P. Duplicates are folded
    // first, matching GNU: `-P -e apple -e apple` is accepted.
    if (regexMode === "perl" && new Set(patterns).size > 1) {
      return {
        stdout: "",
        stderr: "grep: the -P option only supports a single pattern\n",
        exitCode: 2,
      };
    }

    let regex: UserRegex;
    let kResetGroup: number | undefined;
    let conditions: import("../search-engine/regex.js").LineCondition[] = [];
    let preFilter: import("../search-engine/regex.js").PreFilter | undefined;
    let stderr = "";
    try {
      const regexResult =
        patterns.length === 0
          ? buildPatterns([NEVER_MATCHES], { mode: "perl", lineRegexp })
          : buildPatterns(regexMode === "perl" ? [patterns[0]] : patterns, {
              mode: regexMode,
              ignoreCase,
              lineRegexp,
              pcre: regexMode === "perl",
            });
      regex = regexResult.regex;
      kResetGroup = regexResult.kResetGroup;
      conditions = regexResult.conditions ?? [];
      preFilter = regexResult.preFilter;
      for (const warning of regexResult.warnings ?? []) {
        stderr += `grep: warning: ${warning}\n`;
      }
    } catch (error) {
      rethrowFatalExecutionError(error);
      const words =
        error instanceof GnuPatternError
          ? `${origins[error.index ?? -1] ?? ""}${error.message}`
          : `invalid regular expression: ${patterns.join("\n")}`;
      return { stdout: "", stderr: `grep: ${words}\n`, exitCode: 2 };
    }

    let stdout = "";
    let anyMatch = false;
    let anyError = false;
    // a context group after an earlier file's lines is separated
    let printedAny = false;

    // With no FILE, -r searches the working directory and names its files
    // without ./, whatever is on stdin.
    const implicitDot = files.length === 0 && recursive;
    const targets = files.length === 0 ? [implicitDot ? "." : "-"] : files;

    // Collect all files to search (expand globs first)
    // FileEntry includes type info when available to skip stat calls
    const filesToSearch: FileEntry[] = [];
    const traversalBudget: GrepTraversalBudget = {
      operations: 0,
      results: 0,
      maxOperations: ctx.limits.maxGlobOperations,
      maxResults: ctx.limits.maxArrayElements,
    };
    const appendFiles = (entries: FileEntry[]): void => {
      if (entries.length > traversalBudget.maxResults - filesToSearch.length) {
        throw new ExecutionLimitError(
          `grep: array element limit exceeded (${traversalBudget.maxResults})`,
          "array_elements",
        );
      }
      filesToSearch.push(...entries);
    };
    /**
     * True once a `-` operand has claimed stdin. stdin is a stream, so only the
     * first reader sees its contents.
     */
    let stdinConsumed = stdinUsedForPatterns;
    /** A directory operand under -r names its files, as more than one would. */
    let recursedIntoDirectory = false;
    /** Operands after a quoted glob's expansion, as a shell would pass them. */
    let operandCount = 0;
    const walk = {
      include: includePatterns,
      exclude: excludePatterns,
      excludeDir: excludeDirPatterns,
      dereference: o.dereference,
    };
    for (const file of targets) {
      if (file === "-") {
        // GNU treats `-` as an operand naming standard input. It bypasses glob
        // expansion, recursion and --include/--exclude entirely: those all
        // filter on a file name, and stdin has none.
        appendFiles([
          {
            path: o.label ?? STDIN_FILENAME,
            isFile: true,
            isStdin: true,
            stdinAtEof: stdinConsumed,
          },
        ]);
        stdinConsumed = true;
        operandCount++;
        continue;
      }
      // Check if this is a glob pattern
      let expanded: FileEntry[] = [{ path: file }];
      if (
        !implicitDot &&
        (file.includes("*") || file.includes("?") || file.includes("[")) &&
        !(await exists(ctx, file))
      ) {
        expanded = await expandGlobPatternWithTypes(
          file,
          ctx,
          traversalBudget,
        );
      }
      operandCount += expanded.length;
      for (const entry of expanded) {
        let isDirectory = false;
        if (entry.isFile === undefined) {
          try {
            useTraversalOperation(traversalBudget);
            const stat = await ctx.fs.stat(
              ctx.fs.resolvePath(ctx.cwd, entry.path),
            );
            isDirectory = stat.isDirectory;
          } catch (error) {
            rethrowFatalExecutionError(error);
            appendFiles([{ path: entry.path, error: fileErrorWords(error) }]);
            continue;
          }
        } else {
          isDirectory = !entry.isFile;
        }
        if (!isDirectory) {
          if (
            includedFile(entry.path, includePatterns, excludePatterns, true)
          ) {
            appendFiles([{ path: entry.path, isFile: true }]);
          }
          continue;
        }
        if (o.directories === "skip") continue;
        if (!recursive) {
          appendFiles([{ path: entry.path, error: "Is a directory" }]);
          continue;
        }
        if (
          !implicitDot &&
          excludeDirPatterns.length > 0 &&
          suffixMatches(entry.path.replace(/(.)\/+$/, "$1"), excludeDirPatterns)
        ) {
          continue;
        }
        recursedIntoDirectory = true;
        appendFiles(
          await walkDirectory(
            entry.path,
            implicitDot ? "" : entry.path,
            ctx,
            walk,
            traversalBudget,
          ),
        );
      }
    }

    // Names are shown for more than one operand, or a directory searched.
    const showFilename =
      o.withFilename ?? (operandCount > 1 || recursedIntoDirectory);

    const nameEnd = o.nullAfterName ? "\0" : "\n";
    const search = (content: string, name: string, isStdin: boolean) => {
      // a NUL makes the input binary: no lines, a word on stderr
      const binary =
        !o.nullData && o.binaryFiles !== "text" && content.includes("\0");
      if (binary && o.binaryFiles === "without-match") {
        const count = showFilename
          ? `${name}${o.nullAfterName ? "\0" : ":"}`
          : "";
        return {
          result: {
            output: countOnly ? `${count}0\n` : "",
            matched: false,
            matchCount: 0,
          },
          binary,
        };
      }
      // -T pads numbers to the width of the file's size, as GNU does, and
      // of the largest offset on a stream, whose size is unknown
      let offsetWidth = 0;
      if (o.initialTab) {
        offsetWidth = isStdin
          ? 19
          : String(utf8ByteLength(content) + (showLineNumbers ? 1 : 0)).length;
      }
      const result = searchContent(content, regex, {
        invertMatch,
        showLineNumbers,
        countOnly,
        filename: showFilename ? name : "",
        separateFirstGroup: printedAny,
        contextSeparator: o.groupSeparator,
        showByteOffset: o.byteOffset,
        initialTab: o.initialTab,
        offsetWidth,
        nameSeparator: o.nullAfterName ? "\0" : undefined,
        lineTerminator: o.nullData ? "\0" : "\n",
        onlyMatching,
        beforeContext,
        afterContext,
        groupSeparators: contextGiven,
        maxCount,
        kResetGroup,
        wholeWord,
        conditions,
        selectOnly: binary || quietMode || filesWithMatches || filesWithoutMatch,
        preFilter,
        maxWork: getMatcherWorkLimit(ctx),
        maxMatches: ctx.limits.maxArrayElements,
        signal: ctx.signal,
      });
      return { result, binary };
    };

    // Read in parallel batches, search in order so each file's output and
    // its context separators follow the ones before it.
    const BATCH_SIZE = 50;
    for (let i = 0; i < filesToSearch.length; i += BATCH_SIZE) {
      const batch = filesToSearch.slice(i, i + BATCH_SIZE);
      const contents = await Promise.all(
        batch.map(async (entry): Promise<string | { error: string }> => {
          if (entry.error !== undefined) return { error: entry.error };
          if (entry.isStdin) {
            // grep runs regex over text — decode bytes to UTF-8 so multibyte
            // codepoints match `.` / character classes correctly. A `-` that
            // arrives after stdin was already drained reads EOF.
            return entry.stdinAtEof || ctx.stdin === undefined
              ? ""
              : decodeBytesToUtf8(ctx.stdin);
          }
          try {
            return await ctx.fs.readFile(
              ctx.fs.resolvePath(ctx.cwd, entry.path),
            );
          } catch (error) {
            rethrowFatalExecutionError(error);
            return { error: fileErrorWords(error) };
          }
        }),
      );

      for (let j = 0; j < batch.length; j++) {
        const entry = batch[j];
        const content = contents[j];
        if (typeof content !== "string") {
          anyError = true;
          if (!noMessages) stderr += `grep: ${entry.path}: ${content.error}\n`;
          continue;
        }
        const name = entry.path;
        const { result, binary } = search(
          content,
          name,
          entry.isStdin ?? false,
        );
        if (result.output !== "") printedAny = true;
        if (result.matched) {
          anyMatch = true;
          if (quietMode) {
            // quiet stops at the first match, keeping earlier errors
            return { stdout: "", stderr, exitCode: 0 };
          }
        }
        if (filesWithMatches) {
          if (result.matched) stdout += `${name}${nameEnd}`;
        } else if (filesWithoutMatch) {
          if (!result.matched) stdout += `${name}${nameEnd}`;
        } else {
          stdout += result.output;
          if (binary && result.matched && !countOnly) {
            stderr += `grep: ${name}: binary file matches\n`;
          }
        }
      }
    }

    // Exit codes: 0 = a line was selected, 1 = no line was selected, 2 = error.
    //
    // -L deliberately does NOT get its own rule. GNU grep's status reports
    // whether a line was *selected*, never whether a filename was *printed*, so
    // `grep -L` exits 0 when every file matched (and it printed nothing) and 1
    // when no file matched (and it listed them all). Verified against GNU grep
    // 3.12 and BSD grep 2.6.0-FreeBSD; note that ripgrep 15.1.0's
    // --files-without-match really does invert this, which is why
    // src/commands/rg/rg-search.ts keeps the opposite rule on purpose.
    const exitCode = anyError ? 2 : anyMatch ? 0 : 1;
    return {
      stdout: quietMode ? "" : stdout,
      stderr,
      exitCode,
    };
  },
};

/** (1ctx) What a failed read says: only a missing file is one. */
function fileErrorWords(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT" || /^ENOENT\b/.test(message)) {
    return "No such file or directory";
  }
  if (code === "EISDIR" || /^EISDIR\b/.test(message)) return "Is a directory";
  if (code === "EACCES" || /^EACCES\b/.test(message)) {
    return "Permission denied";
  }
  return message;
}

async function exists(
  ctx: RuntimeCommandContext,
  path: string,
): Promise<boolean> {
  try {
    await ctx.fs.stat(ctx.fs.resolvePath(ctx.cwd, path));
    return true;
  } catch (error) {
    rethrowFatalExecutionError(error);
    return false;
  }
}

/** Safety limit to prevent stack overflow on deeply nested directories */
const MAX_GREP_DEPTH = 256;

interface WalkFilters {
  include: string[];
  exclude: string[];
  excludeDir: string[];
  dereference: boolean;
}

/**
 * (1ctx) The files under a directory, as GNU grep -r finds them: hidden
 * ones too, a subdirectory skipped when its name matches --exclude-dir, a
 * file when its name fails --include or matches --exclude, and symbolic
 * links followed only by -R. `shown` is how names start: the operand as
 * written without doubling its slash, or nothing for the implicit `.`.
 */
async function walkDirectory(
  path: string,
  shown: string,
  ctx: RuntimeCommandContext,
  filters: WalkFilters,
  budget: GrepTraversalBudget,
  result: FileEntry[] = [],
  depth = 0,
): Promise<FileEntry[]> {
  if (depth >= MAX_GREP_DEPTH) return result;
  const fullPath = ctx.fs.resolvePath(ctx.cwd, path);
  let entries: { name: string; isFile?: boolean; isDirectory?: boolean }[];
  try {
    useTraversalOperation(budget);
    if (ctx.fs.readdirWithFileTypes) {
      const typed = await ctx.fs.readdirWithFileTypes(fullPath);
      entries = typed.map((e) =>
        e.isSymbolicLink
          ? { name: e.name, isFile: filters.dereference ? undefined : false }
          : { name: e.name, isFile: e.isFile, isDirectory: e.isDirectory },
      );
    } else {
      entries = (await ctx.fs.readdir(fullPath)).map((name) => ({ name }));
    }
  } catch (error) {
    rethrowFatalExecutionError(error);
    result.push({ path: shown || path, error: fileErrorWords(error) });
    return result;
  }
  for (const entry of entries) {
    useTraversalOperation(budget);
    const childPath = path.endsWith("/")
      ? `${path}${entry.name}`
      : `${path}/${entry.name}`;
    const childShown =
      shown === ""
        ? entry.name
        : shown.endsWith("/")
          ? `${shown}${entry.name}`
          : `${shown}/${entry.name}`;
    let isFile = entry.isFile;
    let isDirectory = entry.isDirectory ?? false;
    if (isFile === undefined) {
      try {
        const stat = await ctx.fs.stat(ctx.fs.resolvePath(ctx.cwd, childPath));
        isFile = stat.isFile;
        isDirectory = stat.isDirectory;
      } catch (error) {
        rethrowFatalExecutionError(error);
        continue;
      }
    }
    if (isDirectory) {
      if (
        filters.excludeDir.some((p) =>
          matchGlob(entry.name, p, { stripQuotes: true }),
        )
      ) {
        continue;
      }
      await walkDirectory(
        childPath,
        childShown,
        ctx,
        filters,
        budget,
        result,
        depth + 1,
      );
      continue;
    }
    if (!isFile) continue;
    if (!includedFile(entry.name, filters.include, filters.exclude, false)) {
      continue;
    }
    addTraversalResult(budget);
    result.push({ path: childShown, isFile: true });
  }
  return result;
}

async function expandRecursiveGlob(
  baseDir: string,
  afterGlob: string,
  ctx: RuntimeCommandContext,
  result: string[],
  budget: GrepTraversalBudget,
  depth = 0,
): Promise<void> {
  if (depth >= MAX_GREP_DEPTH) return;
  const fullBasePath = ctx.fs.resolvePath(ctx.cwd, baseDir);

  try {
    useTraversalOperation(budget);
    const stat = await ctx.fs.stat(fullBasePath);

    if (!stat.isDirectory) {
      // Check if the file matches afterGlob pattern
      const filename = baseDir.split("/").pop() || "";
      if (afterGlob) {
        const pattern = afterGlob.replace(/^\//, "");
        if (matchGlob(filename, pattern, { stripQuotes: true })) {
          addTraversalResult(budget);
          result.push(baseDir);
        }
      }
      return;
    }

    // Check files in current directory
    useTraversalOperation(budget);
    const entries = await ctx.fs.readdir(fullBasePath);
    for (const entry of entries) {
      const entryPath = baseDir === "." ? entry : `${baseDir}/${entry}`;
      const fullEntryPath = ctx.fs.resolvePath(ctx.cwd, entryPath);
      useTraversalOperation(budget);
      const entryStat = await ctx.fs.stat(fullEntryPath);

      if (entryStat.isDirectory) {
        // Recurse into directory
        await expandRecursiveGlob(
          entryPath,
          afterGlob,
          ctx,
          result,
          budget,
          depth + 1,
        );
      } else if (afterGlob) {
        // Check if file matches afterGlob pattern
        const pattern = afterGlob.replace(/^\//, "");
        if (matchGlob(entry, pattern, { stripQuotes: true })) {
          addTraversalResult(budget);
          result.push(entryPath);
        }
      }
    }
  } catch (error) {
    rethrowFatalExecutionError(error);
    // Ignore errors
  }
}

/**
 * Optimized glob expansion that returns FileEntry with type info
 * Uses readdirWithFileTypes when available to avoid stat calls
 */
async function expandGlobPatternWithTypes(
  pattern: string,
  ctx: RuntimeCommandContext,
  budget: GrepTraversalBudget,
): Promise<FileEntry[]> {
  const result: FileEntry[] = [];

  // Find the directory part and the glob part
  const lastSlash = pattern.lastIndexOf("/");
  let dirPath: string;
  let globPart: string;

  if (lastSlash === -1) {
    dirPath = ctx.cwd;
    globPart = pattern;
  } else {
    dirPath = pattern.slice(0, lastSlash) || "/";
    globPart = pattern.slice(lastSlash + 1);
  }

  // Handle ** (recursive glob) - fall back to old method
  if (pattern.includes("**")) {
    const oldResult: string[] = [];
    const parts = pattern.split("**");
    const baseDir = parts[0].replace(/\/$/, "") || ".";
    const afterGlob = parts[1] || "";
    await expandRecursiveGlob(baseDir, afterGlob, ctx, oldResult, budget);
    return oldResult.map((p) => ({ path: p }));
  }

  // Resolve the directory path
  const fullDirPath = ctx.fs.resolvePath(ctx.cwd, dirPath);

  try {
    // Use readdirWithFileTypes if available for better performance
    if (ctx.fs.readdirWithFileTypes) {
      useTraversalOperation(budget);
      const entries = await ctx.fs.readdirWithFileTypes(fullDirPath);
      for (const entry of entries) {
        useTraversalOperation(budget);
        if (matchGlob(entry.name, globPart, { stripQuotes: true })) {
          const fullPath =
            lastSlash === -1 ? entry.name : `${dirPath}/${entry.name}`;
          addTraversalResult(budget);
          result.push({
            path: fullPath,
            isFile: entry.isFile,
          });
        }
      }
    } else {
      // Fall back to regular readdir
      useTraversalOperation(budget);
      const entries = await ctx.fs.readdir(fullDirPath);
      for (const entry of entries) {
        useTraversalOperation(budget);
        if (matchGlob(entry, globPart, { stripQuotes: true })) {
          const fullPath = lastSlash === -1 ? entry : `${dirPath}/${entry}`;
          addTraversalResult(budget);
          result.push({ path: fullPath });
        }
      }
    }
  } catch (error) {
    rethrowFatalExecutionError(error);
    // Directory doesn't exist - return empty
  }

  return result.sort((a, b) => a.path.localeCompare(b.path));
}

// fgrep is equivalent to grep -F
export const fgrepCommand: RuntimeCommand = {
  name: "fgrep",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    // Insert -F at the beginning of args
    return grepCommand.execute(["-F", ...args], ctx);
  },
};

// egrep is equivalent to grep -E
export const egrepCommand: RuntimeCommand = {
  name: "egrep",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    // Insert -E at the beginning of args
    return grepCommand.execute(["-E", ...args], ctx);
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "grep",
  flags: [
    { flag: "-E", type: "boolean" },
    { flag: "-F", type: "boolean" },
    { flag: "-P", type: "boolean" },
    { flag: "-i", type: "boolean" },
    { flag: "-v", type: "boolean" },
    { flag: "-w", type: "boolean" },
    { flag: "-x", type: "boolean" },
    { flag: "-c", type: "boolean" },
    { flag: "-l", type: "boolean" },
    { flag: "-L", type: "boolean" },
    { flag: "-n", type: "boolean" },
    { flag: "-h", type: "boolean" },
    { flag: "-o", type: "boolean" },
    { flag: "-q", type: "boolean" },
    { flag: "-r", type: "boolean" },
    { flag: "-m", type: "value", valueHint: "number" },
    { flag: "-A", type: "value", valueHint: "number" },
    { flag: "-B", type: "value", valueHint: "number" },
    { flag: "-C", type: "value", valueHint: "number" },
    { flag: "-e", type: "value", valueHint: "pattern" },
    { flag: "-f", type: "value", valueHint: "path" },
  ],
  stdinType: "text",
  needsArgs: true,
};

export const fgrepFlagsForFuzzing: CommandFuzzInfo = {
  name: "fgrep",
  flags: [],
  stdinType: "text",
  needsArgs: true,
};

export const egrepFlagsForFuzzing: CommandFuzzInfo = {
  name: "egrep",
  flags: [],
  stdinType: "text",
  needsArgs: true,
};
