/**
 * AWK RuntimeCommand - New AST-based Implementation
 *
 * This is the new implementation using proper lexer/parser/interpreter architecture.
 */

import { decodeBytesToUtf8 } from "../../encoding.js";
import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import { mapToRecord } from "../../helpers/env.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "../../interpreter/errors.js";
import {
  assertDefenseContext,
  awaitWithDefenseContext,
} from "../../security/defense-context.js";
import { SecurityViolationError } from "../../security/defense-in-depth-box.js";
import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import { hasHelpFlag, showHelp } from "../help.js";
import type { AwkProgram } from "./ast.js";
import {
  type AwkFileSystem,
  AwkInterpreter,
  createRuntimeContext,
} from "./interpreter/index.js";
import { MainInput } from "./interpreter/input.js";
import { setVariable } from "./interpreter/variables.js";
import { parseOptions } from "./options.js";
import { AwkParser } from "./parser2.js";

const awkHelp = {
  name: "awk",
  summary: "pattern scanning and text processing language",
  usage: "awk [OPTIONS] 'PROGRAM' [FILE...]",
  options: [
    "-F FS      use FS as field separator",
    "-v VAR=VAL assign VAL to variable VAR",
    "-f FILE    read the program from FILE",
    "    --help display this help and exit",
  ],
};

export const awkCommand2: RuntimeCommand = {
  name: "awk",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    assertDefenseContext(ctx.requireDefenseContext, "awk", "execution entry");
    const withDefenseContext = <T>(
      phase: string,
      op: () => Promise<T>,
    ): Promise<T> =>
      awaitWithDefenseContext(ctx.requireDefenseContext, "awk", phase, op);

    if (hasHelpFlag(args)) {
      return showHelp(awkHelp);
    }

    // (1ctx) -v and -F keep their order and are replayed through
    // setVariable once the context exists; -f and -- are read as gawk does
    const parsed = parseOptions(args);
    if (!parsed.ok) {
      return { stdout: "", stderr: parsed.stderr, exitCode: parsed.exitCode };
    }
    const options = parsed.options;

    let program = options.program ?? "";
    if (options.programFiles.length > 0) {
      const sources: string[] = [];
      for (const file of options.programFiles) {
        try {
          const path = ctx.fs.resolvePath(ctx.cwd, file);
          sources.push(
            await withDefenseContext("program file read", () =>
              ctx.fs.readFile(path),
            ),
          );
        } catch (e) {
          if (e instanceof SecurityViolationError) throw e;
          rethrowFatalExecutionError(e);
          return {
            stdout: "",
            stderr: `awk: fatal: cannot open source file '${file}' for reading: No such file or directory\n`,
            exitCode: 2,
          };
        }
      }
      program = sources.join("\n");
    }

    // Parse program
    const parser = new AwkParser({
      maxSourceLength: ctx.limits.maxStringLength,
      maxTokens: ctx.limits.maxAwkParserTokens,
      maxDepth: ctx.limits.maxAwkParserDepth,
      maxOperations: ctx.limits.maxAwkParserOperations,
    });
    let ast: AwkProgram;
    try {
      ast = parser.parse(program);
    } catch (e) {
      rethrowFatalExecutionError(e);
      const msg = e instanceof Error ? e.message : String(e);
      return { stdout: "", stderr: `awk: ${msg}\n`, exitCode: 1 };
    }

    // Create filesystem adapter with appendFile support
    const awkFs: AwkFileSystem = {
      readFile: ctx.fs.readFile.bind(ctx.fs),
      writeFile: ctx.fs.writeFile.bind(ctx.fs),
      appendFile: async (path: string, content: string) => {
        // Append by reading existing content and writing back
        try {
          const existing = await withDefenseContext("appendFile read", () =>
            ctx.fs.readFile(path),
          );
          await withDefenseContext("appendFile write", () =>
            ctx.fs.writeFile(path, existing + content),
          );
        } catch (e) {
          if (e instanceof SecurityViolationError) {
            throw e;
          }
          // File doesn't exist, just write
          await withDefenseContext("appendFile create", () =>
            ctx.fs.writeFile(path, content),
          );
        }
      },
      resolvePath: ctx.fs.resolvePath.bind(ctx.fs),
    };

    const maxInputBytes = Math.min(
      ctx.limits.maxInputBytes,
      ctx.limits.maxStringLength,
    );

    // Create runtime context
    const execFn = ctx.exec;
    const runtimeCtx = createRuntimeContext({
      maxIterations: ctx.limits.maxAwkIterations,
      maxOutputSize: Math.min(
        ctx.limits.maxStringLength,
        ctx.limits.maxOutputSize,
      ),
      maxArrayElements: ctx.limits.maxArrayElements,
      maxInputBytes,
      fs: awkFs,
      cwd: ctx.cwd,
      // Wrap ctx.exec to match the expected signature for command pipe getline
      exec: execFn
        ? (cmd: string) =>
            withDefenseContext("command pipe exec", () =>
              execFn(cmd, { cwd: ctx.cwd, signal: ctx.signal }),
            )
        : undefined,
      coverage: ctx.coverage,
      requireDefenseContext: ctx.requireDefenseContext,
      signal: ctx.signal,
    });

    // ARGV[0] is "awk", ARGV[1..n] the operands, read as the walk reaches them
    runtimeCtx.ARGC = options.operands.length + 1;
    runtimeCtx.ARGV["0"] = "awk";
    for (let i = 0; i < options.operands.length; i++) {
      runtimeCtx.ARGV[String(i + 1)] = options.operands[i];
    }
    Object.assign(runtimeCtx.ENVIRON, mapToRecord(ctx.env));

    let stdinRead = false;
    runtimeCtx.mainInput = new MainInput(runtimeCtx, {
      readFile: async (file) => {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        try {
          const stat = await withDefenseContext("input file stat", () =>
            ctx.fs.stat(filePath),
          );
          if (stat.size > maxInputBytes - runtimeCtx.inputBytes) {
            throw new ExecutionLimitError(
              `aggregate input size limit exceeded (${maxInputBytes} bytes)`,
              "string_length",
            );
          }
          return await withDefenseContext("input file read", () =>
            ctx.fs.readFile(filePath),
          );
        } catch (e) {
          if (
            e instanceof SecurityViolationError ||
            e instanceof ExecutionLimitError
          ) {
            throw e;
          }
          rethrowFatalExecutionError(e);
          throw new Error(
            `fatal: cannot open file '${file}' for reading: No such file or directory`,
          );
        }
      },
      readStdin: () => {
        if (stdinRead) return "";
        stdinRead = true;
        // awk parses fields with regex / FS — decode bytes to UTF-8 so
        // non-ASCII data isn't split mid-codepoint.
        return decodeBytesToUtf8(ctx.stdin);
      },
    });

    // Create interpreter
    const interp = new AwkInterpreter(runtimeCtx);
    interp.execute(ast);

    // Check if there are main rules (non-BEGIN/END patterns)
    const hasMainRules = ast.rules.some(
      (rule) => rule.pattern?.type !== "begin" && rule.pattern?.type !== "end",
    );
    // Check if there are END blocks (need to read files to populate NR)
    const hasEndBlocks = ast.rules.some((rule) => rule.pattern?.type === "end");

    try {
      for (const { name, value } of options.assignments) {
        setVariable(runtimeCtx, name, value);
      }

      // Execute BEGIN blocks
      await withDefenseContext("BEGIN execution", () => interp.executeBegin());
      if (runtimeCtx.shouldExit) {
        // exit in BEGIN still runs END blocks (AWK semantics)
        await withDefenseContext("END execution after BEGIN exit", () =>
          interp.executeEnd(),
        );
        return {
          stdout: interp.getOutput(),
          stderr: "",
          exitCode: interp.getExitCode(),
        };
      }

      // Only skip file reading if there are no main rules AND no END blocks
      // END blocks need NR to be populated from reading files
      if (!hasMainRules && !hasEndBlocks) {
        // Just run END blocks (none), no input processing needed
        return {
          stdout: interp.getOutput(),
          stderr: "",
          exitCode: interp.getExitCode(),
        };
      }

      const input = runtimeCtx.mainInput;
      for (;;) {
        const record = await withDefenseContext("input read", () =>
          input.nextRecord(),
        );
        if (record === null) break;
        await withDefenseContext("line execution", () =>
          interp.executeLine(record),
        );
        if (runtimeCtx.shouldExit) break;
        if (runtimeCtx.shouldNextFile) {
          input.skipFile();
          runtimeCtx.shouldNextFile = false;
        }
      }

      // Execute END blocks (always run, even after exit - AWK semantics)
      await withDefenseContext("END execution", () => interp.executeEnd());

      // awk emits text; the pipeline handles encoding.
      return {
        stdout: interp.getOutput(),
        stderr: "",
        exitCode: interp.getExitCode(),
      };
    } catch (e) {
      if (
        e instanceof SecurityViolationError ||
        e instanceof ExecutionAbortedError
      ) {
        throw e;
      }
      // Handle errors during execution
      const msg = e instanceof Error ? e.message : String(e);
      const exitCode =
        e instanceof ExecutionLimitError ? ExecutionLimitError.EXIT_CODE : 2;
      return {
        stdout: interp.getOutput(),
        stderr: `awk: ${msg}\n`,
        exitCode,
      };
    }
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "awk",
  flags: [
    { flag: "-F", type: "value", valueHint: "delimiter" },
    { flag: "-v", type: "value", valueHint: "string" },
  ],
  stdinType: "text",
  needsArgs: true,
};
