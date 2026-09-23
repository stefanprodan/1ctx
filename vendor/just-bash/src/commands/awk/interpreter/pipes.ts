/**
 * (1ctx) AWK output pipes: `print ... | "cmd"`.
 *
 * gawk keeps one pipe per distinct command string and hands the command
 * the text as it is written; its stdout shares ours. We hold the text and
 * run the command once, at close() or at the program's end, and place its
 * stdout as gawk's ordering does: gawk flushes its own stdout when it
 * opens a pipe and when it closes one, and at the end closes every pipe
 * before the last flush, so a pipe's stdout goes before whatever we
 * printed since the last flush.
 */

import { decodeBytesToUtf8, unsafeBytesFromLatin1 } from "../../../encoding.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "../../../interpreter/errors.js";
import { utf8ByteLength } from "../../printf/escapes.js";
import type { AwkRuntimeContext } from "./context.js";

export const MAX_OUTPUT_PIPES = 16;

/** gawk's fatal error for a redirection whose name is the empty string. */
export function nullRedirection(op: string): Error {
  return new Error(`expression for \`${op}' redirection has null string value`);
}

/** Marks everything printed so far as written, as gawk's fflush does. */
export function flushOutput(ctx: AwkRuntimeContext): void {
  ctx.flushedAt = ctx.output.length;
}

/** Adds text to the pipe of a command, opening it when new. */
export function writePipe(
  ctx: AwkRuntimeContext,
  command: string,
  text: string,
): void {
  if (!ctx.exec) throw new Error("cannot run a command from this awk");
  const held = ctx.outputPipes.get(command);
  if (held === undefined) {
    if (ctx.outputPipes.size >= MAX_OUTPUT_PIPES) {
      throw new ExecutionLimitError(
        `output pipe limit exceeded (${MAX_OUTPUT_PIPES})`,
        "array_elements",
      );
    }
    flushOutput(ctx);
  }
  const bytes = utf8ByteLength(text);
  if (
    ctx.maxOutputSize > 0 &&
    ctx.pipeBytes + bytes + ctx.output.length + ctx.errorOutput.length >
      ctx.maxOutputSize
  ) {
    throw new ExecutionLimitError(
      `awk: output size limit exceeded (${ctx.maxOutputSize} bytes)`,
      "string_length",
      ctx.output,
    );
  }
  ctx.pipeBytes += bytes;
  ctx.outputPipes.set(command, (held ?? "") + text);
}

/** Runs the command with the pipe's text; its stdout, stderr and status. */
async function runPipe(
  ctx: AwkRuntimeContext,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (ctx.signal?.aborted) throw new ExecutionAbortedError();
  const text = ctx.outputPipes.get(command) ?? "";
  ctx.outputPipes.delete(command);
  ctx.pipeBytes -= utf8ByteLength(text);
  if (!ctx.exec) throw new Error("cannot run a command from this awk");
  const result = await ctx.exec(command, text);
  return {
    stdout: decodeBytesToUtf8(unsafeBytesFromLatin1(result.stdout)),
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

/**
 * Closes one pipe: our output so far is flushed first, then the
 * command's stdout follows it. Answers the exit status, or null when no
 * pipe of that name is open.
 */
export async function closePipe(
  ctx: AwkRuntimeContext,
  command: string,
): Promise<number | null> {
  if (!ctx.outputPipes.has(command)) return null;
  const result = await runPipe(ctx, command);
  ctx.output += result.stdout;
  ctx.errorOutput += result.stderr;
  flushOutput(ctx);
  return result.exitCode;
}

/** Closes every open pipe in the order opened, as the program ends. */
export async function closePipes(ctx: AwkRuntimeContext): Promise<void> {
  if (ctx.outputPipes.size === 0) return;
  const before = ctx.output.slice(0, ctx.flushedAt);
  const after = ctx.output.slice(ctx.flushedAt);
  let piped = "";
  for (const command of [...ctx.outputPipes.keys()]) {
    const result = await runPipe(ctx, command);
    piped += result.stdout;
    ctx.errorOutput += result.stderr;
  }
  ctx.output = before + piped + after;
  flushOutput(ctx);
}
