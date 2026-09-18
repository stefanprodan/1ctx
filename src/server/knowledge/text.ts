// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export { kindOf } from "../../shared/knowledge.ts";

export function textFromString(value: string): string {
  if (
    !value.isWellFormed() ||
    value.includes("\u0000") ||
    value.includes("\ufffd")
  ) {
    throw new Error("not a text file");
  }
  return value.startsWith("\ufeff") ? value.slice(1) : value;
}

export function textFromBytes(bytes: Uint8Array): string {
  if (bytes.indexOf(0) !== -1) throw new Error("not a text file");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("not a text file");
  }
  return textFromString(text);
}

export function lineCount(text: string): number {
  if (text === "") return 0;
  let lines = 0;
  for (const char of text) if (char === "\n") lines++;
  return lines + (text.endsWith("\n") ? 0 : 1);
}
