/**
 * (1ctx awk) AWK output files: `print > f` and `print >> f`.
 *
 * The first write to a file lands at once, as before: `>` truncates and
 * `>>` appends, and a file that cannot be opened fails at that print, as
 * gawk's open does. Later writes are held, as gawk buffers an open file,
 * and appended when anything could see the file: a command, a getline, the
 * next input operand, the open of another file (a link may name it),
 * close(), fflush(), the end, or FLUSH_AT held UTF-16 units. An append re-reads and re-writes the whole file, so one per
 * print was quadratic in its size.
 */

import { ExecutionAbortedError } from "../../../interpreter/errors.js";
import { awaitWithDefenseContext } from "../../../security/defense-context.js";
import { SecurityViolationError } from "../../../security/defense-in-depth-box.js";
import type { AwkRuntimeContext } from "./context.js";

const FLUSH_AT = 64 * 1024;

export interface OutputFile {
  chunks: string[];
  held: number;
}

function write(
  ctx: AwkRuntimeContext,
  phase: string,
  op: () => Promise<void>,
): Promise<void> {
  return awaitWithDefenseContext(ctx.requireDefenseContext, "awk", phase, op);
}

/** Writes text to an output file, opening it when new. */
export async function writeFile(
  ctx: AwkRuntimeContext,
  path: string,
  redirect: ">" | ">>",
  text: string,
): Promise<void> {
  const fs = ctx.fs;
  if (!fs) return;
  const file = ctx.openedFiles.get(path);
  if (!file) {
    await flushFiles(ctx);
    // the first write to a ">" file clears it, every later one appends
    await write(ctx, "redirection open write", () =>
      redirect === ">" ? fs.writeFile(path, text) : fs.appendFile(path, text),
    );
    ctx.openedFiles.set(path, { chunks: [], held: 0 });
    return;
  }
  file.chunks.push(text);
  file.held += text.length;
  ctx.heldFiles.add(path);
  if (file.held >= FLUSH_AT) await flushFile(ctx, path);
}

/** Appends the held text of one output file, which stays open. */
export async function flushFile(
  ctx: AwkRuntimeContext,
  path: string,
): Promise<void> {
  const file = ctx.openedFiles.get(path);
  const fs = ctx.fs;
  if (!file || !fs || file.chunks.length === 0) return;
  // each write's lone surrogates became U+FFFD on its own, as before
  const text = file.chunks.map((chunk) => chunk.toWellFormed()).join("");
  // dropped before the write: a failure is thrown as that print's was,
  // and the flushes after it must not fail on it again
  file.chunks = [];
  file.held = 0;
  ctx.heldFiles.delete(path);
  await write(ctx, "redirection append write", () =>
    fs.appendFile(path, text),
  );
}

/**
 * Appends the held text of every output file. A file that fails does not
 * stop the others, as each print's write stood alone; the first failure is
 * thrown after, an abort or a violation at once.
 */
export async function flushFiles(ctx: AwkRuntimeContext): Promise<void> {
  let failure: { error: unknown } | undefined;
  for (const path of [...ctx.heldFiles]) {
    try {
      await flushFile(ctx, path);
    } catch (error) {
      if (
        error instanceof SecurityViolationError ||
        error instanceof ExecutionAbortedError
      ) {
        throw error;
      }
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}
