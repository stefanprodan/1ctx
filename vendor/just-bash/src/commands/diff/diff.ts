/**
 * diff - Compare files line by line
 *
 * (1ctx) As GNU diffutils 3.12: files are compared as bytes with our own
 * bounded engine, GNU's options and exit codes (0 the same, 1 different,
 * 2 trouble), GNU's words for binary files and operands, every output
 * format, and directories compared as GNU compares them.
 */

import {
  bytesOutput,
  decodeBytesToUtf8,
  readBytesFrom,
  unsafeBytesFromLatin1,
} from "../../encoding.js";
import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import { showHelp } from "../help.js";
import { DiffWorkLimitError, workBudget } from "./budget.js";
import { excludePatterns } from "./names.js";
import { DiffUsageError, parseDiffArgs } from "./options.js";
import { anyPattern, type LineTest } from "./patterns.js";
import { DiffRun, Fatal } from "./run.js";

export { STEPS_PER_UNIT } from "./budget.js";

const diffHelp = {
  name: "diff",
  summary: "compare files line by line",
  usage: "diff [OPTION]... FILES",
  options: [
    "    --normal                  output a normal diff (the default)",
    "-q, --brief                   report only when files differ",
    "-s, --report-identical-files  report when two files are the same",
    "-c, -C NUM, --context[=NUM]   output NUM (default 3) lines of copied context",
    "-u, -U NUM, --unified[=NUM]   output NUM (default 3) lines of unified context",
    "-e, --ed                      output an ed script",
    "-n, --rcs                     output an RCS format diff",
    "-y, --side-by-side            output in two columns",
    "-W, --width=NUM               output at most NUM (default 130) print columns",
    "    --left-column             output only the left column of common lines",
    "    --suppress-common-lines   do not output common lines",
    "-p, --show-c-function         show which C function each change is in",
    "-F, --show-function-line=RE   show the most recent line matching RE",
    "    --label LABEL             use LABEL instead of file name and timestamp",
    "-t, --expand-tabs             expand tabs to spaces in output",
    "-T, --initial-tab             make tabs line up by prepending a tab",
    "    --tabsize=NUM             tab stops every NUM (default 8) print columns",
    "    --suppress-blank-empty    suppress space or tab before empty output lines",
    "-r, --recursive               recursively compare any subdirectories found",
    "    --no-dereference          don't follow symbolic links",
    "-N, --new-file                treat absent files as empty",
    "    --unidirectional-new-file treat absent first files as empty",
    "    --ignore-file-name-case   ignore case when comparing file names",
    "    --no-ignore-file-name-case  consider case when comparing file names",
    "-x, --exclude=PAT             exclude files that match PAT",
    "-X, --exclude-from=FILE       exclude files that match any pattern in FILE",
    "-S, --starting-file=FILE      start with FILE when comparing directories",
    "    --from-file=FILE1         compare FILE1 to all operands; FILE1 can be a directory",
    "    --to-file=FILE2           compare all operands to FILE2; FILE2 can be a directory",
    "-i, --ignore-case             ignore case differences in file contents",
    "-E, --ignore-tab-expansion    ignore changes due to tab expansion",
    "-Z, --ignore-trailing-space   ignore white space at line end",
    "-b, --ignore-space-change     ignore changes in the amount of white space",
    "-w, --ignore-all-space        ignore all white space",
    "-B, --ignore-blank-lines      ignore changes where lines are all blank",
    "-I, --ignore-matching-lines=RE  ignore changes where all lines match RE",
    "-a, --text                    treat all files as text",
    "    --strip-trailing-cr       strip trailing carriage return on input",
    "-D, --ifdef=NAME              output merged file with '#ifdef NAME' diffs",
    "    --GTYPE-group-format=GFMT format GTYPE input groups with GFMT",
    "    --line-format=LFMT        format all input lines with LFMT",
    "    --LTYPE-line-format=LFMT  format LTYPE input lines with LFMT",
    "  LTYPE is 'old', 'new', or 'unchanged'.  GTYPE is LTYPE or 'changed'.",
    "  GFMT may contain %< (lines from FILE1), %> (lines from FILE2),",
    "    %= (lines common to both), %[-][WIDTH][.[PREC]]{doxX}LETTER with",
    "    LETTER F, L, N, E or M for the new group's first and last line,",
    "    count, F-1 and L+1 (lower case for the old group), and",
    "    %(A=B?T:E) for T if A equals B else E",
    "  LFMT may contain %L (the line), %l (without its newline) and",
    "    %[-][WIDTH][.[PREC]]{doxX}n (its number)",
    "  Both may contain %%, %c'C' and %c'\\OOO'",
    "-d, --minimal                 try hard to find a smaller set of changes",
    "    --horizon-lines=NUM       keep NUM lines of the common prefix and suffix",
    "    --speed-large-files       assume large files and many scattered small changes",
    "    --color[=WHEN]            accepted; the output is never colored",
    "    --palette=PALETTE         accepted; the output is never colored",
    "    --help                    display this help and exit",
    "-v, --version                 output version information and exit",
  ],
  notes: [
    "FILES are 'FILE1 FILE2' or 'DIR1 DIR2' or 'DIR FILE' or 'FILE DIR'.",
    "If --from-file or --to-file is given, there are no restrictions on FILE(s).",
    "If a FILE is '-', read standard input.",
    "Exit status is 0 if inputs are the same, 1 if different, 2 if trouble.",
  ],
};

const VERSION =
  "diff (GNU diffutils) 3.12 (just-bash, compatible)\n" +
  "A sandboxed diff that answers as GNU diff 3.12 does; see diff --help.\n";

/** Patterns as a line test; one GNU or RE2 refuses is trouble. */
function compile(patterns: string[]): LineTest {
  try {
    return anyPattern(patterns);
  } catch (error) {
    rethrowFatalExecutionError(error);
    throw new Fatal(error instanceof Error ? error.message : String(error));
  }
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

/** -X files' patterns, read before any compare as GNU reads them. */
async function excludeFiles(
  ctx: RuntimeCommandContext,
  files: string[],
): Promise<string[]> {
  const patterns: string[] = [];
  for (const file of files) {
    try {
      const bytes =
        file === "-"
          ? ctx.stdin
          : await readBytesFrom(ctx.fs, ctx.fs.resolvePath(ctx.cwd, file));
      patterns.push(...excludePatterns(decodeBytesToUtf8(bytes)));
    } catch (error) {
      rethrowFatalExecutionError(error);
      throw new Fatal(`${file}: No such file or directory`);
    }
  }
  return patterns;
}

function result(run: DiffRun, exitCode: number): ExecResult {
  return {
    ...bytesOutput(unsafeBytesFromLatin1(run.out.join(""))),
    stderr: run.err.join(""),
    exitCode,
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
    const { fromFile, toFile } = options;
    let run: DiffRun | null = null;
    try {
      if (fromFile !== null && toFile !== null) {
        throw new Fatal("--from-file and --to-file both specified");
      }
      if (fromFile === null && toFile === null && operands.length !== 2) {
        const after = operands.length === 0 ? "diff" : operands[0];
        return usage(
          new DiffUsageError(
            operands.length < 2
              ? `missing operand after '${after}'`
              : `extra operand '${operands[2]}'`,
          ),
        );
      }
      const tests = {
        matching: options.ignoreMatching.length
          ? compile(options.ignoreMatching)
          : null,
        heading: options.functionPatterns.length
          ? compile(options.functionPatterns)
          : null,
      };
      const excludes = [
        ...options.excludes,
        ...(await excludeFiles(ctx, options.excludeFiles)),
      ];
      run = new DiffRun(ctx, options, tests, workBudget(ctx), excludes);
      const pairs: [string, string][] =
        fromFile !== null
          ? operands.map((op) => [fromFile, op])
          : toFile !== null
            ? operands.map((op) => [op, toFile])
            : [[operands[0], operands[1]]];
      let status = 0;
      for (const [first, second] of pairs) {
        status = Math.max(status, await run.compareFiles(null, first, second));
      }
      return result(run, status);
    } catch (error) {
      if (error instanceof Fatal || error instanceof DiffWorkLimitError) {
        const words = `diff: ${error.message}\n`;
        if (run === null) return { stdout: "", stderr: words, exitCode: 2 };
        run.err.push(words);
        return result(run, 2);
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
    { flag: "-r", type: "boolean" },
    { flag: "-N", type: "boolean" },
    { flag: "-y", type: "boolean" },
    { flag: "-e", type: "boolean" },
    { flag: "-n", type: "boolean" },
  ],
  needsArgs: true,
  minArgs: 2,
};
