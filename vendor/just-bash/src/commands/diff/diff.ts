/**
 * diff - Compare files line by line
 *
 * (1ctx) As GNU diffutils 3.12: files are compared as bytes with our own
 * bounded engine, GNU's options and exit codes (0 the same, 1 different,
 * 2 trouble), and GNU's words for binary files and operands.
 */

import {
  bytesOutput,
  encodeUtf8ToBytes,
  latin1FromBytes,
  readBytesFrom,
  unsafeBytesFromLatin1,
} from "../../encoding.js";
import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import { ExecutionAbortedError } from "../../interpreter/errors.js";
import { commandWorkLimit } from "../../limits.js";
import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import { showHelp } from "../help.js";
import { compare } from "./engine.js";
import { formatContext } from "./format-context.js";
import { formatNormal } from "./format-normal.js";
import { formatUnified } from "./format-unified.js";
import { headerName, headerTime, shellName } from "./header.js";
import { changesOf, hunksOf } from "./hunks.js";
import { folds, intern, splitLines } from "./lines.js";
import {
  contextLines,
  type DiffOptions,
  DiffUsageError,
  parseDiffArgs,
} from "./options.js";
import {
  anyPattern,
  headings,
  type LineTest,
  markIgnorable,
} from "./patterns.js";

const diffHelp = {
  name: "diff",
  summary: "compare files line by line",
  usage: "diff [OPTION]... FILE1 FILE2",
  options: [
    "    --normal                  output a normal diff (the default)",
    "-q, --brief                   report only when files differ",
    "-s, --report-identical-files  report when two files are the same",
    "-c, -C NUM, --context[=NUM]   output NUM (default 3) lines of copied context",
    "-u, -U NUM, --unified[=NUM]   output NUM (default 3) lines of unified context",
    "-p, --show-c-function         show which C function each change is in",
    "-F, --show-function-line=RE   show the most recent line matching RE",
    "    --label LABEL             use LABEL instead of file name and timestamp",
    "-t, --expand-tabs             expand tabs to spaces in output",
    "-T, --initial-tab             make tabs line up by prepending a tab",
    "    --tabsize=NUM             tab stops every NUM (default 8) print columns",
    "    --suppress-blank-empty    suppress space or tab before empty output lines",
    "-i, --ignore-case             ignore case differences in file contents",
    "-E, --ignore-tab-expansion    ignore changes due to tab expansion",
    "-Z, --ignore-trailing-space   ignore white space at line end",
    "-b, --ignore-space-change     ignore changes in the amount of white space",
    "-w, --ignore-all-space        ignore all white space",
    "-B, --ignore-blank-lines      ignore changes where lines are all blank",
    "-I, --ignore-matching-lines=RE  ignore changes where all lines match RE",
    "-N, --new-file                treat absent files as empty",
    "    --unidirectional-new-file treat absent first files as empty",
    "-a, --text                    treat all files as text",
    "    --strip-trailing-cr       strip trailing carriage return on input",
    "-d, --minimal                 try hard to find a smaller set of changes",
    "    --horizon-lines=NUM       keep NUM lines of the common prefix and suffix",
    "    --speed-large-files       assume large files and many scattered small changes",
    "    --help                    display this help and exit",
    "-v, --version                 output version information and exit",
  ],
  notes: [
    "Exit status is 0 if inputs are the same, 1 if different, 2 if trouble.",
  ],
};

const VERSION =
  "diff (GNU diffutils) 3.12 (just-bash, compatible)\n" +
  "A sandboxed diff that answers as GNU diff 3.12 does; see diff --help.\n";

/** (1ctx) A NUL in this many first bytes makes a file binary, as GNU's first read. */
const BINARY_WINDOW = 4096;
/** (1ctx) GNU reads this much of a pipe at first, so stdin looks further. */
const PIPE_WINDOW = 65536;

/** (1ctx) Steps of the compare that make one unit of the work limit. */
export const STEPS_PER_UNIT = 64;
/** (1ctx) Steps a byte of folding and of regex matching are charged. */
const FOLD_STEPS = 8;
const MATCH_STEPS = 8;

/** (1ctx) The compare went past the command's work limit. */
export class DiffWorkLimitError extends Error {}

/**
 * (1ctx) Charges the compare's steps to the command's work limit, the one
 * grep's matcher takes; a default compare gives up looking at a quarter
 * of it, so only -d can run into it.
 */
export function workBudget(ctx: RuntimeCommandContext): {
  charge: (steps: number) => void;
  giveUp: number;
} {
  const limit = commandWorkLimit(ctx.limits);
  const maxSteps = limit * STEPS_PER_UNIT;
  let steps = 0;
  return {
    charge: (more: number) => {
      if (ctx.signal?.aborted) throw new ExecutionAbortedError();
      steps += more;
      if (steps > maxSteps) {
        throw new DiffWorkLimitError(`work limit exceeded (${limit})`);
      }
    },
    giveUp: maxSteps / 4,
  };
}

interface Operand {
  name: string;
  bytes: string;
  mtime: Date;
  /** a NUL in this many first bytes makes it binary */
  window: number;
  /** absent, and read as empty under -N */
  absent?: boolean;
}

class Trouble extends Error {}

function errorWords(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT" || /^ENOENT\b/.test(message)) {
    return "No such file or directory";
  }
  if (code === "EACCES" || /^EACCES\b/.test(message)) {
    return "Permission denied";
  }
  return message;
}

async function isDirectory(
  ctx: RuntimeCommandContext,
  name: string,
): Promise<boolean> {
  if (name === "-") return false;
  try {
    return (await ctx.fs.stat(ctx.fs.resolvePath(ctx.cwd, name))).isDirectory;
  } catch (error) {
    rethrowFatalExecutionError(error);
    return false;
  }
}

async function readOperand(
  ctx: RuntimeCommandContext,
  name: string,
  mayBeAbsent: boolean,
): Promise<Operand> {
  if (name === "-") {
    const bytes = latin1FromBytes(ctx.stdin);
    return { name, bytes, mtime: new Date(), window: PIPE_WINDOW };
  }
  const path = ctx.fs.resolvePath(ctx.cwd, name);
  try {
    const stat = await ctx.fs.stat(path);
    const bytes = latin1FromBytes(await readBytesFrom(ctx.fs, path));
    return { name, bytes, mtime: stat.mtime, window: BINARY_WINDOW };
  } catch (error) {
    rethrowFatalExecutionError(error);
    if (mayBeAbsent && errorWords(error) === "No such file or directory") {
      return { name, bytes: "", mtime: new Date(0), window: 0, absent: true };
    }
    throw new Trouble(`${name}: ${errorWords(error)}`);
  }
}

/** Two operands, a directory standing for its namesake of the other file. */
async function operandPair(
  ctx: RuntimeCommandContext,
  names: string[],
): Promise<[string, string]> {
  let [first, second] = names;
  const firstDir = await isDirectory(ctx, first);
  const secondDir = await isDirectory(ctx, second);
  if (firstDir && secondDir) {
    throw new Trouble("comparing two directories is not supported");
  }
  const base = (name: string) => name.replace(/\/+$/, "").split("/").pop();
  const join = (dir: string, name: string) =>
    `${dir.replace(/\/+$/, "")}/${base(name)}`;
  if (firstDir) {
    if (second === "-") throw new Trouble(`cannot compare '-' to a directory`);
    first = join(first, second);
  } else if (secondDir) {
    if (first === "-") throw new Trouble(`cannot compare '-' to a directory`);
    second = join(second, first);
  }
  return [first, second];
}

/** Patterns as a line test; one GNU or RE2 refuses is trouble. */
function compile(patterns: string[]): LineTest {
  try {
    return anyPattern(patterns);
  } catch (error) {
    rethrowFatalExecutionError(error);
    throw new Trouble(error instanceof Error ? error.message : String(error));
  }
}

function isBinary(file: Operand): boolean {
  const nul = file.bytes.indexOf("\0");
  return nul !== -1 && nul < file.window;
}

/** Text of our own, names included, as the output's bytes. */
const text = (s: string) => latin1FromBytes(encodeUtf8ToBytes(s));

function result(stdout: string, exitCode: number): ExecResult {
  return {
    ...bytesOutput(unsafeBytesFromLatin1(stdout)),
    stderr: "",
    exitCode,
  };
}

interface Tests {
  /** -I */
  matching: LineTest | null;
  /** -p and -F */
  heading: LineTest | null;
}

function compareFiles(
  ctx: RuntimeCommandContext,
  o: DiffOptions,
  tests: Tests,
  a: Operand,
  b: Operand,
): ExecResult {
  const names = `${shellName(a.name)} and ${shellName(b.name)}`;
  const same = () =>
    result(o.reportSame ? text(`Files ${names} are identical\n`) : "", 0);
  if (a.bytes === b.bytes) return same();
  if (!o.text && (isBinary(a) || isBinary(b))) {
    return result(
      text(
        o.brief ? `Files ${names} differ\n` : `Binary files ${names} differ\n`,
      ),
      1,
    );
  }
  const budget = workBudget(ctx);
  const bytes = a.bytes.length + b.bytes.length;
  // splitting and interning take a step a byte, folding more
  budget.charge(folds(o) ? FOLD_STEPS * bytes : bytes);
  const la = splitLines(a.bytes, o.stripTrailingCr);
  const lb = splitLines(b.bytes, o.stripTrailingCr);
  const ids = intern(la, lb, o);
  const raw = folds(o) ? intern(la, lb, {}) : null;
  const charged = (test: LineTest | null): LineTest | null =>
    test && ((line) => {
      budget.charge(MATCH_STEPS * (line.length + 1));
      return test(line);
    });
  const style = o.style ?? (o.showCFunction ? "context" : "normal");
  const context = style === "normal" ? 0 : contextLines(o);
  const comparison = compare(ids.a, ids.b, ids.count, {
    ...budget,
    minimal: o.minimal,
    speedLargeFiles: o.speedLargeFiles,
    // the context shown is never left out of the search, as GNU keeps it
    horizon: Math.max(o.horizon, context),
    raw: raw ? [raw.a, raw.b] : undefined,
  });
  const changes = changesOf(comparison);
  if (o.ignoreBlankLines || tests.matching) {
    markIgnorable(
      changes,
      la,
      lb,
      o.ignoreBlankLines,
      o.ignoreAllSpace || o.ignoreSpaceChange || o.ignoreTrailingSpace,
      charged(tests.matching),
    );
  }
  const hunks = hunksOf(changes, context, la.lines.length, lb.lines.length);
  if (hunks.length === 0) return same();
  if (o.brief) return result(text(`Files ${names} differ\n`), 1);

  const lineStyle = {
    initialTab: o.initialTab,
    suppressBlankEmpty: o.suppressBlankEmpty,
    expandTabs: o.expandTabs ? o.tabSize : 0,
  };
  const out: string[] = [];
  if (style === "normal") {
    formatNormal(la, lb, hunks, lineStyle, out);
    return result(out.join(""), 1);
  }
  const heading = tests.heading
    ? headings(la, charged(tests.heading) as LineTest)
    : undefined;
  const header = (mark: string, file: Operand, label: string | undefined) =>
    text(
      label !== undefined
        ? `${mark} ${label}\n`
        : `${mark} ${headerName(file.name)}\t${headerTime(file.mtime, ctx.env.get("TZ"))}\n`,
    );
  if (style === "unified") {
    out.push(header("---", a, o.labels[0]), header("+++", b, o.labels[1]));
    formatUnified(la, lb, hunks, lineStyle, out, heading);
  } else {
    out.push(header("***", a, o.labels[0]), header("---", b, o.labels[1]));
    formatContext(la, lb, hunks, lineStyle, out, heading);
  }
  return result(out.join(""), 1);
}

function usage(error: DiffUsageError): ExecResult {
  return {
    stdout: "",
    stderr: `diff: ${error.message}\n${
      error.tryHelp ? "diff: Try 'diff --help' for more information.\n" : ""
    }`,
    exitCode: 2,
  };
}

export const diffCommand: RuntimeCommand = {
  name: "diff",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    let parsed: ReturnType<typeof parseDiffArgs>;
    try {
      parsed = parseDiffArgs(args);
    } catch (error) {
      if (error instanceof DiffUsageError) return usage(error);
      throw error;
    }
    const { options, operands } = parsed;
    if (options.help) return showHelp(diffHelp);
    if (options.version) return { stdout: VERSION, stderr: "", exitCode: 0 };
    if (operands.length < 2) {
      const after = operands.length === 0 ? "diff" : operands[0];
      return usage(new DiffUsageError(`missing operand after '${after}'`));
    }
    if (operands.length > 2) {
      return usage(new DiffUsageError(`extra operand '${operands[2]}'`));
    }
    try {
      const tests = {
        matching: options.ignoreMatching.length
          ? compile(options.ignoreMatching)
          : null,
        heading: options.functionPatterns.length
          ? compile(options.functionPatterns)
          : null,
      };
      const [first, second] = await operandPair(ctx, operands);
      const a = await readOperand(ctx, first, options.newFile !== null);
      const b =
        second === first && first === "-"
          ? a
          : await readOperand(ctx, second, options.newFile === "both");
      if (a.absent && b.absent) {
        throw new Trouble(`${first}: No such file or directory`);
      }
      // GNU stamps both headers with the absent first file's time
      if (a.absent) b.mtime = a.mtime;
      return compareFiles(ctx, options, tests, a, b);
    } catch (error) {
      if (error instanceof Trouble || error instanceof DiffWorkLimitError) {
        return { stdout: "", stderr: `diff: ${error.message}\n`, exitCode: 2 };
      }
      throw error;
    }
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "diff",
  flags: [
    { flag: "-u", type: "boolean" },
    { flag: "-c", type: "boolean" },
    { flag: "-q", type: "boolean" },
    { flag: "-s", type: "boolean" },
    { flag: "-i", type: "boolean" },
    { flag: "-w", type: "boolean" },
    { flag: "-b", type: "boolean" },
    { flag: "-B", type: "boolean" },
    { flag: "-a", type: "boolean" },
  ],
  needsArgs: true,
  minArgs: 2,
};
