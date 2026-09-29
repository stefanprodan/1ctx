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
import { planCommands } from "./xargs-plan.js";
import { quoteForTrace } from "./xargs-quote.js";

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

/** (1ctx) GNU's default command-line buffer, 128 KiB. */
const DEFAULT_MAX_CHARS = 131072;

/** (1ctx) The exec limit the sandbox answers as, Linux's 2 MiB. */
const ARG_MAX = 2097152;

const XARGS_VERSION =
  "xargs (GNU findutils) 4.11.0 (just-bash, compatible)\n" +
  "A sandboxed xargs that answers as GNU xargs 4.11.0 does; see xargs --help.\n";

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** (1ctx) An argument is a C string: it ends at a NUL, as GNU passes it. */
function cString(arg: string): string {
  const nul = arg.indexOf("\0");
  return nul === -1 ? arg : arg.slice(0, nul);
}

/** (1ctx) The bytes the environment takes, as GNU counts it for -s. */
function environmentSize(ctx: RuntimeCommandContext): number {
  let size = 0;
  for (const [key, value] of Object.entries(ctx.exportedEnv ?? {})) {
    size += utf8ByteLength(key) + utf8ByteLength(value) + 2;
  }
  return size;
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
    // (1ctx) at most 16 at once, -P 0 included, each through ctx.exec
    const maxProcs = Math.min(
      options.maxProcs === 0 ? MAX_PARALLEL : options.maxProcs,
      MAX_PARALLEL,
    );
    const command =
      options.command.length > 0 ? [...options.command] : ["echo"];

    const maxStringLength = Math.min(
      ctx.limits.maxInputBytes,
      ctx.limits.maxStringLength,
    );
    const maxArrayElements = ctx.limits.maxArrayElements;
    const maxIterations = ctx.limits.maxLoopIterations;
    const maxOutputSize = ctx.limits.maxOutputSize;

    // (1ctx) -s is bounded by the sandbox's exec limit, less the
    // environment, as GNU bounds it by the host's
    const envSize = environmentSize(ctx);
    const posixLimit = ARG_MAX - 2048 - envSize;
    const warnings = [...options.warnings];
    let maxChars = options.maxChars ?? Math.min(DEFAULT_MAX_CHARS, posixLimit);
    if (maxChars > posixLimit) {
      warnings.push(`value ${maxChars} for -s option should be <= ${posixLimit}`);
      maxChars = posixLimit;
    }

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
          stderr: `xargs: Cannot open input file ‘${options.argFile}’: No such file or directory\n`,
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
      wholeLines: options.replace !== null,
      maxItems: maxArrayElements,
    });
    warnings.push(...input.warnings);
    const plan = planCommands(input.lines, {
      command,
      replace: options.replace,
      maxLines: options.maxLines,
      maxArgs: options.maxArgs,
      maxChars,
      exit: options.exit,
      noRunIfEmpty: options.noRunIfEmpty,
      inputFailed: input.error !== null,
      maxStringLength,
    });
    const commands = plan.commands;
    if (commands.length > maxIterations) {
      throw new ExecutionLimitError(
        `xargs: iteration limit exceeded (${maxIterations})`,
        "iterations",
      );
    }
    let elements = 0;
    for (const line of commands) elements += line.length;
    if (elements > maxArrayElements) {
      throw new ExecutionLimitError(
        `xargs: array element limit exceeded (${maxArrayElements})`,
        "array_elements",
      );
    }

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let exitCode = 0;
    let outputBytes = 0;
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
    for (const w of warnings) {
      appendStderr(`xargs: ${w.startsWith("WARNING") ? w : `warning: ${w}`}\n`);
    }
    if (options.showLimits) {
      appendStderr(
        `Your environment variables take up ${envSize} bytes\n` +
          `POSIX upper limit on argument length (this system): ${posixLimit}\n` +
          "POSIX smallest allowable upper limit on argument length (all systems): 4096\n" +
          `Maximum length of command we could actually use: ${posixLimit - envSize}\n` +
          `Size of command buffer we are actually using: ${maxChars}\n` +
          `Maximum parallelism (--max-procs must be no greater): ${MAX_PARALLEL}\n`,
      );
    }

    // (1ctx) under -a the first command gets xargs' stdin, as it would
    // drain the inherited descriptor
    let stdinLeft = options.argFile !== null;

    const executeCommand = async (
      rawArgs: string[],
      slot: number,
    ): Promise<ExecResult> => {
      const cmdArgs = rawArgs.map(cString);
      for (const value of cmdArgs) {
        if (utf8ByteLength(value) > maxStringLength) {
          throw new ExecutionLimitError(
            `xargs: string length limit exceeded (${maxStringLength} bytes)`,
            "string_length",
          );
        }
      }
      if (options.verbose) {
        appendStderr(`${cmdArgs.map(quoteForTrace).join(" ")}\n`);
      }
      // an assignment before the name exports the slot to the command
      const slotPrefix =
        options.slotVar !== null && SHELL_NAME.test(options.slotVar)
          ? `${options.slotVar}=${slot} `
          : "";
      const script = `${slotPrefix}${shellJoinArgs([cmdArgs[0]])}`;
      const execOptions = {
        cwd: ctx.cwd,
        signal: ctx.signal,
        args: cmdArgs.slice(1),
      };
      if (stdinLeft && ctx.execWithInheritedStdin) {
        stdinLeft = false;
        return ctx.execWithInheritedStdin(script, execOptions);
      }
      if (ctx.exec) return ctx.exec(script, execOptions);
      // Fallback: just output what would be run
      return {
        stdout: `${cmdArgs.map(quoteForTrace).join(" ")}\n`,
        stderr: "",
        exitCode: 0,
      };
    };

    // (1ctx) up to -P commands at once, a slot taking the next command as
    // soon as its own ends; output is kept in input order
    const results: (ExecResult | undefined)[] = [];
    let emitted = 0;
    let next = 0;
    let failure: unknown;
    const emitReady = () => {
      while (emitted < commands.length && results[emitted] !== undefined) {
        const result = results[emitted] as ExecResult;
        results[emitted] = undefined;
        emitted++;
        appendOutput(result);
        if (result.exitCode !== 0) exitCode = result.exitCode;
      }
    };
    const slot = async (id: number) => {
      while (failure === undefined && next < commands.length) {
        const index = next++;
        try {
          results[index] = await executeCommand(commands[index], id);
          emitReady();
        } catch (error) {
          failure ??= error;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(maxProcs, commands.length) }, (_, id) =>
        slot(id),
      ),
    );
    if (failure !== undefined) throw failure;

    // (1ctx) an unbuilt command line or an unclosed quote ends xargs after
    // what could run
    const error = plan.error ?? input.error;
    if (error !== null) {
      appendStderr(`xargs: ${error}\n`);
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
