// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A bounded command result that reserves space for the exit and receipts.
// A model must see what was saved even when stdout is cut, so receipts
// that cannot fit refuse the write rather than hiding its outcome.

export function cutText(text: string, length: number): string {
  const cut = text.slice(0, Math.max(0, length));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const mark = (resultCut: number) =>
  `... output cut at ${resultCut} characters, narrow with grep or sed -n`;

// stdout then stderr, cut to leave the whole tail, or null when the tail
// alone leaves no room
function bounded(
  stdout: string,
  stderr: string,
  tail: string,
  resultCut: number,
): { content: string; tail: number } | null {
  const printed = [stdout, stderr]
    .filter(Boolean)
    .join(stdout.endsWith("\n") ? "" : "\n");
  const whole = printed === "" ? tail : `${printed}\n${tail}`;
  if (whole.length <= resultCut) return { content: whole, tail: tail.length };
  const room = resultCut - mark(resultCut).length - tail.length - 2;
  if (room < 0) return null;
  return {
    content: `${cutText(printed, room)}\n${mark(resultCut)}\n${tail}`,
    tail: tail.length,
  };
}

export function output(
  stdout: string,
  stderr: string,
  exitCode: number,
  receipts: readonly string[],
  resultCut: number,
): { content: string; tail: number } {
  const tail = [`exit ${exitCode}`, ...receipts].join("\n");
  const content = bounded(stdout, stderr, tail, resultCut);
  // A command cannot land writes whose receipts cannot be returned intact.
  if (content === null) {
    throw new Error(
      `change receipts exceed ${resultCut} characters, split the command`,
    );
  }
  return content;
}

// what a command that ran printed, then why nothing was saved and its
// exit, so the model can tell what happened and the refusal survives a cut
export function refused(
  stdout: string,
  stderr: string,
  exitCode: number,
  error: unknown,
  resultCut: number,
): { content: string; error: true; tail: number } {
  const words = error instanceof Error ? error.message : String(error);
  const exit = `exit ${exitCode}`;
  const whole = `nothing saved: ${words}`;
  // at most half the room past the mark, so some output always shows,
  // and never less than the refusal itself
  const line = cutText(
    whole,
    Math.max(
      "nothing saved".length,
      Math.floor((resultCut - mark(resultCut).length - exit.length - 3) / 2),
    ),
  );
  const tail = `${line}\n${exit}`;
  // with no room for output and exit, the refusal alone, as failed() says it
  const short = cutText(whole, resultCut);
  const content = bounded(stdout, stderr, tail, resultCut) ?? {
    content: short,
    tail: short.length,
  };
  return { ...content, error: true };
}

export function failed(error: unknown, resultCut: number) {
  const words = error instanceof Error ? error.message : String(error);
  return {
    content: cutText(`nothing saved: ${words}`, resultCut),
    error: true,
  };
}
