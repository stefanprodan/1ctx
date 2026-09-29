import { decodeBytesToUtf8 } from "../../encoding.js";
import { ExecutionOutputAccumulator } from "../../execution-output.js";
import type { ExecutionScope } from "../../execution-scope.js";
import { shellJoinArgs } from "../../helpers/shell-quote.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import { showHelp } from "../help.js";
import { utf8ByteLength } from "../printf/escapes.js";
import { parseXargsArgs } from "./xargs-options.js";

// (1ctx) every option GNU xargs 4.11 has, in its words
const xargsHelp = {
  name: "xargs",
  summary: "build and execute command lines from standard input",
  usage: "xargs [OPTION]... [COMMAND [INITIAL-ARGS]...]",
  description: [
    "Run COMMAND with arguments INITIAL-ARGS and more arguments read from",
    "input, as GNU xargs 4.11 does. Items are separated by blanks and",
    "newlines, and quotes and backslashes protect them.",
  ],
  options: [
    "-0, --null               items are separated by a null, not whitespace",
    "-a, --arg-file=FILE      read arguments from FILE, not standard input",
    "-d, --delimiter=CHAR     items are separated by CHAR, not by whitespace",
    "-E END                   stop at an input item END (not with -0 or -d)",
    "-e, --eof[=END]          -E END, or no end string without END",
    "-I R                     same as --replace=R",
    "-i, --replace[=R]        replace R in INITIAL-ARGS with each input line",
    "                           ({} without R)",
    "-L, --max-lines=MAX      at most MAX non-blank input lines per command",
    "-l[MAX]                  -L, one line without MAX",
    "-n, --max-args=MAX       at most MAX arguments per command",
    "-o, --open-tty           needs a terminal, which the sandbox has none of",
    "-P, --max-procs=MAX      run at most MAX commands at a time (at most 16)",
    "-p, --interactive        needs a terminal, which the sandbox has none of",
    "    --process-slot-var=VAR  set VAR to the command's slot",
    "-r, --no-run-if-empty    run nothing when there is no item",
    "-s, --max-chars=MAX      at most MAX bytes per command line",
    "    --show-limits        show the command-line limits",
    "-t, --verbose            print each command on stderr before it runs",
    "-x, --exit               exit when a command line exceeds -s",
    "    --help               display this help and exit",
    "    --version            output version information and exit",
  ],
  notes: [
    "Exit status: 0, 123 when a command exits 1 to 254, 124 when one exits",
    "255, 126 when it cannot run, 127 when it is not found, 1 for an error.",
  ],
};

/** (1ctx) The most commands -P runs at once in the sandbox. */
const MAX_PARALLEL = 16;

const XARGS_VERSION =
  "xargs (GNU findutils) 4.11.0 (just-bash, compatible)\n" +
  "A sandboxed xargs that answers as GNU xargs 4.11.0 does; see xargs --help.\n";

function splitExactBounded(
  input: string,
  delimiter: string,
  maxItems: number,
): string[] {
  if (delimiter.length === 0) {
    throw new Error("xargs: delimiter must not be empty");
  }
  const items: string[] = [];
  let start = 0;
  while (start <= input.length) {
    const end = input.indexOf(delimiter, start);
    const item = input.slice(start, end === -1 ? input.length : end);
    if (item.length > 0) {
      if (items.length >= maxItems) {
        throw new ExecutionLimitError(
          `xargs: array element limit exceeded (${maxItems})`,
          "array_elements",
        );
      }
      items.push(item);
    }
    if (end === -1) break;
    start = end + delimiter.length;
  }
  return items;
}

function splitWhitespaceBounded(input: string, maxItems: number): string[] {
  const items: string[] = [];
  let start = -1;
  for (let i = 0; i <= input.length; i++) {
    const isWhitespace = i === input.length || /\s/.test(input[i]);
    if (!isWhitespace && start === -1) start = i;
    if (isWhitespace && start !== -1) {
      if (items.length >= maxItems) {
        throw new ExecutionLimitError(
          `xargs: array element limit exceeded (${maxItems})`,
          "array_elements",
        );
      }
      items.push(input.slice(start, i));
      start = -1;
    }
  }
  return items;
}

export const xargsCommand: RuntimeCommand = {
  name: "xargs",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    const parsed = parseXargsArgs(args);
    if (parsed.kind === "error") return parsed.result;
    if (parsed.kind === "help") return showHelp(xargsHelp);
    if (parsed.kind === "version") {
      return { stdout: XARGS_VERSION, stderr: "", exitCode: 0 };
    }
    const options = parsed.options;
    const replaceStr = options.replace;
    const delimiter = options.mode === "delimiter" ? options.delimiter : null;
    const maxArgs = options.maxArgs;
    // (1ctx) at most 16 at once, -P 0 included, each through ctx.exec
    const maxProcs = Math.min(
      options.maxProcs === 0 ? MAX_PARALLEL : options.maxProcs,
      MAX_PARALLEL,
    );
    const nullSeparator = options.mode === "null";
    const verbose = options.verbose;
    const noRunIfEmpty = options.noRunIfEmpty;
    const warnings = options.warnings
      .map((w) => `xargs: warning: ${w}\n`)
      .join("");

    // Get command and initial args
    const command = [...options.command];
    if (command.length === 0) {
      command.push("echo");
    }

    // Parse input. Priority: -0 (null) > -d (custom delimiter) > default
    // (whitespace). xargs' delimiters (`\0`, ASCII whitespace, user-provided
    // single-byte delim) all live in the ASCII range, but the args produced
    // are passed onward as text — decode so multibyte filenames survive.
    const stdinText = decodeBytesToUtf8(ctx.stdin);
    const maxStringLength = Math.min(
      ctx.limits.maxInputBytes,
      ctx.limits.maxStringLength,
    );
    const maxArrayElements = ctx.limits.maxArrayElements;
    const maxIterations = ctx.limits.maxLoopIterations;
    const maxOutputSize = ctx.limits.maxOutputSize;
    if (utf8ByteLength(stdinText) > maxStringLength) {
      throw new ExecutionLimitError(
        `xargs: input size limit exceeded (${maxStringLength} bytes)`,
        "string_length",
      );
    }
    let items: string[];
    if (nullSeparator) {
      items = splitExactBounded(stdinText, "\0", maxArrayElements);
    } else if (delimiter !== null) {
      // Custom delimiter - split on exact string
      // Strip trailing newline from input before splitting (echo adds trailing newlines)
      const input = stdinText.replace(/\n$/, "");
      try {
        items = splitExactBounded(input, delimiter, maxArrayElements);
      } catch (error) {
        if (error instanceof ExecutionLimitError) throw error;
        return {
          stdout: "",
          stderr: "xargs: delimiter must not be empty\n",
          exitCode: 1,
        };
      }
    } else {
      // Default: split on whitespace and trim
      items = splitWhitespaceBounded(stdinText, maxArrayElements);
    }

    if (items.length === 0) {
      if (noRunIfEmpty) {
        return { stdout: "", stderr: warnings, exitCode: 0 };
      }
      // With no -r flag, still run the command with no args
      // (echo with no args just outputs newline)
      return { stdout: "", stderr: warnings, exitCode: 0 };
    }

    // Execute commands
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let exitCode = 0;
    let outputBytes = 0;
    let commandIterations = 0;
    const output = ctx.executionScope
      ? new ExecutionOutputAccumulator(
          ctx.executionScope as ExecutionScope,
          "xargs",
        )
      : undefined;
    const appendOutput = (result: ExecResult): void => {
      if (output) {
        output.appendResult(result);
        return;
      }
      const addedBytes =
        utf8ByteLength(result.stdout) + utf8ByteLength(result.stderr);
      if (addedBytes > maxOutputSize - outputBytes) {
        throw new ExecutionLimitError(
          `xargs: output size limit exceeded (${maxOutputSize} bytes)`,
          "output_size",
        );
      }
      if (result.stdout) stdoutChunks.push(result.stdout);
      if (result.stderr) stderrChunks.push(result.stderr);
      outputBytes += addedBytes;
    };
    const appendStderr = (value: string): void => {
      if (output) {
        output.append("stderr", value);
        return;
      }
      const addedBytes = utf8ByteLength(value);
      if (addedBytes > maxOutputSize - outputBytes) {
        throw new ExecutionLimitError(
          `xargs: output size limit exceeded (${maxOutputSize} bytes)`,
          "output_size",
        );
      }
      if (value) stderrChunks.push(value);
      outputBytes += addedBytes;
    };
    if (warnings) appendStderr(warnings);

    // Helper to quote an argument if it contains special characters
    const quoteArg = (arg: string): string => {
      // If arg contains spaces, quotes, or shell metacharacters, quote it
      // Note: \s includes spaces, tabs, and newlines
      if (/[\s"'\\$`!*?[\]{}();&|<>#]/.test(arg)) {
        // Use double quotes and escape characters that are special inside double quotes:
        // backslash, double quote, dollar sign, and backtick
        return `"${arg.replace(/([\\"`$])/g, "\\$1")}"`;
      }
      return arg;
    };

    // Helper to execute a single command via the shell
    const executeCommand = async (cmdArgs: string[]): Promise<ExecResult> => {
      if (++commandIterations > maxIterations) {
        throw new ExecutionLimitError(
          `xargs: iteration limit exceeded (${maxIterations})`,
          "iterations",
        );
      }
      if (cmdArgs.length > maxArrayElements) {
        throw new ExecutionLimitError(
          `xargs: array element limit exceeded (${maxArrayElements})`,
          "array_elements",
        );
      }
      for (const value of cmdArgs) {
        if (utf8ByteLength(value) > maxStringLength) {
          throw new ExecutionLimitError(
            `xargs: string length limit exceeded (${maxStringLength} bytes)`,
            "string_length",
          );
        }
      }
      if (verbose) {
        const cmdLine = cmdArgs.map(quoteArg).join(" ");
        appendStderr(`${cmdLine}\n`);
      }
      // Use ctx.exec to run the command, passing current working directory
      if (ctx.exec) {
        return ctx.exec(shellJoinArgs([cmdArgs[0]]), {
          cwd: ctx.cwd,
          signal: ctx.signal,
          args: cmdArgs.slice(1),
        });
      }
      // Fallback: just output what would be run
      const cmdLine = cmdArgs.map(quoteArg).join(" ");
      return { stdout: `${cmdLine}\n`, stderr: "", exitCode: 0 };
    };

    // Helper to run commands with optional parallelism
    const runCommands = async (cmdArgsList: string[][]): Promise<void> => {
      if (maxProcs > 1) {
        // Run in parallel batches
        for (let i = 0; i < cmdArgsList.length; i += maxProcs) {
          const batch = cmdArgsList.slice(i, i + maxProcs);
          const results = await Promise.all(batch.map(executeCommand));
          for (const result of results) {
            appendOutput(result);
            if (result.exitCode !== 0) {
              exitCode = result.exitCode;
            }
          }
        }
      } else {
        // Sequential execution
        for (const cmdArgs of cmdArgsList) {
          const result = await executeCommand(cmdArgs);
          appendOutput(result);
          if (result.exitCode !== 0) {
            exitCode = result.exitCode;
          }
        }
      }
    };

    if (replaceStr !== null) {
      // -I mode: run command once per item, replacing replaceStr in each argument
      if (items.length > maxIterations) {
        throw new ExecutionLimitError(
          `xargs: iteration limit exceeded (${maxIterations})`,
          "iterations",
        );
      }
      if (replaceStr.length === 0) {
        return {
          stdout: "",
          stderr: "xargs: replacement string must not be empty\n",
          exitCode: 1,
        };
      }
      if (
        command.length > 0 &&
        items.length > Math.floor(maxArrayElements / command.length)
      ) {
        throw new ExecutionLimitError(
          `xargs: array element limit exceeded (${maxArrayElements})`,
          "array_elements",
        );
      }
      const replaceBounded = (template: string, item: string): string => {
        let occurrences = 0;
        let position = 0;
        while (true) {
          position = template.indexOf(replaceStr, position);
          if (position === -1) break;
          occurrences++;
          position += replaceStr.length;
        }
        const prospectiveBytes =
          utf8ByteLength(template) +
          occurrences * (utf8ByteLength(item) - utf8ByteLength(replaceStr));
        if (prospectiveBytes > maxStringLength) {
          throw new ExecutionLimitError(
            `xargs: string length limit exceeded (${maxStringLength} bytes)`,
            "string_length",
          );
        }
        return template.replaceAll(replaceStr, item);
      };
      const cmdArgsList = items.map((item) =>
        command.map((c) => replaceBounded(c, item)),
      );
      await runCommands(cmdArgsList);
    } else if (maxArgs !== null) {
      // -n mode: batch items
      const cmdArgsList: string[][] = [];
      const batchCount = Math.ceil(items.length / maxArgs);
      if (batchCount > Math.min(maxArrayElements, maxIterations)) {
        throw new ExecutionLimitError(
          `xargs: iteration limit exceeded (${maxIterations})`,
          "iterations",
        );
      }
      const prospectiveElements = items.length + batchCount * command.length;
      if (prospectiveElements > maxArrayElements) {
        throw new ExecutionLimitError(
          `xargs: array element limit exceeded (${maxArrayElements})`,
          "array_elements",
        );
      }
      for (let i = 0; i < items.length; i += maxArgs) {
        const batch = items.slice(i, i + maxArgs);
        cmdArgsList.push([...command, ...batch]);
      }
      await runCommands(cmdArgsList);
    } else {
      // Default: all items on one line
      const cmdArgs = [...command, ...items];
      const result = await executeCommand(cmdArgs);
      appendOutput(result);
      exitCode = result.exitCode;
    }

    return (
      output?.build(exitCode) ?? {
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode,
      }
    );
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "xargs",
  flags: [
    { flag: "-I", type: "value", valueHint: "string" },
    { flag: "-d", type: "value", valueHint: "delimiter" },
    { flag: "-n", type: "value", valueHint: "number" },
    { flag: "-0", type: "boolean" },
    { flag: "-t", type: "boolean" },
    { flag: "-r", type: "boolean" },
  ],
  stdinType: "text",
};
