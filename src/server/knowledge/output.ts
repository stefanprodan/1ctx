// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export function cutText(text: string, length: number): string {
  const cut = text.slice(0, Math.max(0, length));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function output(
  stdout: string,
  stderr: string,
  exitCode: number,
  receipts: readonly string[],
  resultCut: number,
): string {
  const tail = [`exit ${exitCode}`, ...receipts].join("\n");
  const printed = [stdout, stderr]
    .filter(Boolean)
    .join(stdout.endsWith("\n") ? "" : "\n");
  const whole = printed === "" ? tail : `${printed}\n${tail}`;
  if (whole.length <= resultCut) return whole;
  const mark = `... output cut at ${resultCut} characters, narrow with grep or sed -n`;
  const room = resultCut - mark.length - tail.length - 2;
  // A command cannot land writes whose receipts cannot be returned intact.
  if (room < 0) {
    throw new Error(
      `change receipts exceed ${resultCut} characters, split the command`,
    );
  }
  return `${cutText(printed, room)}\n${mark}\n${tail}`;
}

export function failed(error: unknown, resultCut: number) {
  const words = error instanceof Error ? error.message : String(error);
  return {
    content: cutText(`nothing saved: ${words}`, resultCut),
    error: true,
  };
}
