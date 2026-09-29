import {
  decodeBytesToUtf8,
  latin1FromBytes,
  readBytesFrom,
} from "../../encoding.js";
import { ExecutionOutputAccumulator } from "../../execution-output.js";
import type { ExecutionScope } from "../../execution-scope.js";
import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import { shellJoinArgs } from "../../helpers/shell-quote.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import { accountFileInput } from "../../utils/file-reader.js";
import { showHelp } from "../help.js";
import { utf8ByteLength } from "../printf/escapes.js";
import { readXargsInput } from "./xargs-input.js";
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

/** (1ctx) An argument is a C string: it ends at a NUL, as GNU passes it. */
function cString(arg: string): string {
  const nul = arg.indexOf("\0");
  return nul === -1 ? arg : arg.slice(0, nul);
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
    const maxArgs = options.maxArgs;
    const maxLines = options.maxLines;
    // (1ctx) at most 16 at once, -P 0 included, each through ctx.exec
    const maxProcs = Math.min(
      options.maxProcs === 0 ? MAX_PARALLEL : options.maxProcs,
      MAX_PARALLEL,
    );
    const verbose = options.verbose;
    const noRunIfEmpty = options.noRunIfEmpty;

    // Get command and initial args
    const command = [...options.command];
    if (command.length === 0) {
      command.push("echo");
    }

    const maxStringLength = Math.min(
      ctx.limits.maxInputBytes,
      ctx.limits.maxStringLength,
    );
    const maxArrayElements = ctx.limits.maxArrayElements;
    const maxIterations = ctx.limits.maxLoopIterations;
    const maxOutputSize = ctx.limits.maxOutputSize;

    // (1ctx) -a reads the items from a file and leaves stdin to the command
    let inputText: string;
    if (options.argFile !== null) {
      try {
        const bytes = await readBytesFrom(
          ctx.fs,
          ctx.fs.resolvePath(ctx.cwd, options.argFile),
        );
        const size = latin1FromBytes(bytes).length;
        if (size > maxStringLength) {
          throw new ExecutionLimitError(
            `xargs: input size limit exceeded (${maxStringLength} bytes)`,
            "string_length",
          );
        }
        accountFileInput(ctx, size, "xargs");
        inputText = decodeBytesToUtf8(bytes);
      } catch (error) {
        rethrowFatalExecutionError(error);
        return {
          stdout: "",
          stderr: `xargs: Cannot open input file \u2018${options.argFile}\u2019: No such file or directory\n`,
          exitCode: 1,
        };
      }
    } else {
      // The delimiters are ASCII, but the items go on as text, so decode
      // for multibyte names to survive.
      inputText = decodeBytesToUtf8(ctx.stdin);
      if (utf8ByteLength(inputText) > maxStringLength) {
        throw new ExecutionLimitError(
          `xargs: input size limit exceeded (${maxStringLength} bytes)`,
          "string_length",
        );
      }
    }
    const input = readXargsInput(inputText, {
      mode: options.mode,
      delimiter: options.delimiter,
      eof: options.eof,
      wholeLines: replaceStr !== null,
      maxItems: maxArrayElements,
    });
    const warnings = [...options.warnings, ...input.warnings]
      .map((w) => `xargs: ${w.startsWith("WARNING") ? w : `warning: ${w}`}\n`)
      .join("");
    const items = input.lines.flat();

    if (items.length === 0 && input.error === null) {
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

    // (1ctx) under -a the first command gets xargs' stdin, as it would
    // drain the inherited descriptor
    let stdinLeft = options.argFile !== null;

    // Helper to execute a single command via the shell
    const executeCommand = async (
      rawArgs: string[],
    ): Promise<ExecResult> => {
      if (++commandIterations > maxIterations) {
        throw new ExecutionLimitError(
          `xargs: iteration limit exceeded (${maxIterations})`,
          "iterations",
        );
      }
      if (rawArgs.length > maxArrayElements) {
        throw new ExecutionLimitError(
          `xargs: array element limit exceeded (${maxArrayElements})`,
          "array_elements",
        );
      }
      const cmdArgs = rawArgs.map(cString);
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
      const script = shellJoinArgs([cmdArgs[0]]);
      const execOptions = {
        cwd: ctx.cwd,
        signal: ctx.signal,
        args: cmdArgs.slice(1),
      };
      if (stdinLeft && ctx.execWithInheritedStdin) {
        stdinLeft = false;
        return ctx.execWithInheritedStdin(script, execOptions);
      }
      if (ctx.exec) {
        return ctx.exec(script, execOptions);
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

    const checkBatches = (batchCount: number): void => {
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
    };

    if (replaceStr !== null) {
      // -I mode: run command once per line, replacing replaceStr in each argument
      if (items.length > maxIterations) {
        throw new ExecutionLimitError(
          `xargs: iteration limit exceeded (${maxIterations})`,
          "iterations",
        );
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
        // (1ctx) an empty string replaces nothing, as in GNU
        if (replaceStr === "") return template;
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
      // the command name is replaced too, as GNU replaces every initial word
      const cmdArgsList = items.map((item) =>
        command.map((c) => replaceBounded(c, item)),
      );
      await runCommands(cmdArgsList);
    } else if (maxLines !== null) {
      // (1ctx) -L mode: batch whole input lines
      const batchCount = Math.ceil(input.lines.length / maxLines);
      checkBatches(batchCount);
      const cmdArgsList: string[][] = [];
      for (let i = 0; i < input.lines.length; i += maxLines) {
        const batch = input.lines.slice(i, i + maxLines).flat();
        cmdArgsList.push([...command, ...batch]);
      }
      await runCommands(cmdArgsList);
    } else if (maxArgs !== null) {
      // -n mode: batch items
      checkBatches(Math.ceil(items.length / maxArgs));
      const cmdArgsList: string[][] = [];
      for (let i = 0; i < items.length; i += maxArgs) {
        const batch = items.slice(i, i + maxArgs);
        cmdArgsList.push([...command, ...batch]);
      }
      await runCommands(cmdArgsList);
    } else if (items.length > 0) {
      // Default: all items on one line
      const cmdArgs = [...command, ...items];
      const result = await executeCommand(cmdArgs);
      appendOutput(result);
      exitCode = result.exitCode;
    }

    // (1ctx) a quote the input never closed ends xargs after the items
    // read before it ran
    if (input.error !== null) {
      appendStderr(`xargs: ${input.error}\n`);
      exitCode = 1;
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
