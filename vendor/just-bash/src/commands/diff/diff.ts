/**
 * diff - Compare files line by line
 */

import { decodeBytesToUtf8 } from "../../encoding.js";
import { ExecutionAbortedError } from "../../interpreter/errors.js";
import { commandWorkLimit } from "../../limits.js";
import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { hasHelpFlag, showHelp } from "../help.js";
import { compare } from "./engine.js";
import { formatUnified } from "./format-unified.js";
import { changesOf, hunksOf } from "./hunks.js";
import { intern, splitLines } from "./lines.js";

const diffHelp = {
  name: "diff",
  summary: "compare files line by line",
  usage: "diff [OPTION]... FILE1 FILE2",
  options: [
    "-u, --unified     output unified diff format (default)",
    "-q, --brief       report only whether files differ",
    "-s, --report-identical-files  report when files are the same",
    "-i, --ignore-case  ignore case differences",
    "    --help        display this help and exit",
  ],
};

const argDefs = {
  unified: { short: "u", long: "unified", type: "boolean" as const },
  brief: { short: "q", long: "brief", type: "boolean" as const },
  reportSame: {
    short: "s",
    long: "report-identical-files",
    type: "boolean" as const,
  },
  ignoreCase: { short: "i", long: "ignore-case", type: "boolean" as const },
  minimal: { short: "d", long: "minimal", type: "boolean" as const },
};

/** (1ctx) Steps of the compare that make one unit of the work limit. */
export const STEPS_PER_UNIT = 64;

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
  spent: () => number;
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
    spent: () => Math.ceil(steps / STEPS_PER_UNIT),
  };
}

export const diffCommand: RuntimeCommand = {
  name: "diff",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(diffHelp);

    const parsed = parseArgs("diff", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const brief = parsed.result.flags.brief;
    const reportSame = parsed.result.flags.reportSame;
    const ignoreCase = parsed.result.flags.ignoreCase;
    const minimal = parsed.result.flags.minimal;
    const files = parsed.result.positional;

    // Note: unified flag is accepted but is the default behavior
    void parsed.result.flags.unified;

    if (files.length < 2) {
      return { stdout: "", stderr: "diff: missing operand\n", exitCode: 2 };
    }

    let c1: string, c2: string;
    const [f1, f2] = files;

    // diff compares lines as strings. Normalize stdin (byte buffer) to
    // UTF-8 so it compares correctly against file content (utf8 by default).
    try {
      c1 =
        f1 === "-"
          ? decodeBytesToUtf8(ctx.stdin)
          : await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, f1));
    } catch {
      return {
        stdout: "",
        stderr: `diff: ${f1}: No such file or directory\n`,
        exitCode: 2,
      };
    }

    try {
      c2 =
        f2 === "-"
          ? decodeBytesToUtf8(ctx.stdin)
          : await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, f2));
    } catch {
      return {
        stdout: "",
        stderr: `diff: ${f2}: No such file or directory\n`,
        exitCode: 2,
      };
    }

    // (1ctx) our own bounded compare, over lines interned to numbers
    const a = splitLines(c1);
    const b = splitLines(c2);
    const ids = intern(a, b, { ignoreCase });
    const budget = workBudget(ctx);
    let hunks: ReturnType<typeof hunksOf>;
    try {
      const comparison = compare(ids.a, ids.b, ids.count, {
        ...budget,
        minimal,
      });
      hunks = hunksOf(changesOf(comparison), 3, a.lines.length, b.lines.length);
    } catch (error) {
      if (error instanceof DiffWorkLimitError) {
        return { stdout: "", stderr: `diff: ${error.message}\n`, exitCode: 2 };
      }
      throw error;
    }

    if (hunks.length === 0) {
      if (reportSame)
        // diff emits text; the pipeline handles encoding.
        return {
          stdout: `Files ${f1} and ${f2} are identical\n`,
          stderr: "",
          exitCode: 0,
        };
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    if (brief) {
      // diff emits text; the pipeline handles encoding.
      return {
        stdout: `Files ${f1} and ${f2} differ\n`,
        stderr: "",
        exitCode: 1,
      };
    }

    const out = [`--- ${f1}\n`, `+++ ${f2}\n`];
    formatUnified(a, b, hunks, {
      initialTab: false,
      suppressBlankEmpty: false,
      expandTabs: 0,
    }, out);
    // diff emits text; the pipeline handles encoding.
    return {
      stdout: out.join(""),
      stderr: "",
      exitCode: 1,
    };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "diff",
  flags: [
    { flag: "-u", type: "boolean" },
    { flag: "-q", type: "boolean" },
    { flag: "-s", type: "boolean" },
    { flag: "-i", type: "boolean" },
  ],
  needsArgs: true,
  minArgs: 2,
};
