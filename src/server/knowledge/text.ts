// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export {
  kindOf,
  textFromBytes,
  textFromString,
} from "../../shared/knowledge.ts";

export function lineCount(text: string): number {
  if (text === "") return 0;
  let lines = 0;
  for (const char of text) if (char === "\n") lines++;
  return lines + (text.endsWith("\n") ? 0 : 1);
}
