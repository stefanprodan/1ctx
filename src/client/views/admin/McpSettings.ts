// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A server's settings as the new-server form and an open row edit
// them: the switches, the timeout and the three pattern boxes, and the
// body both send.

import { type Signal, useSignal } from "@preact/signals";
import type { McpServerSummary } from "../../../shared/contracts/mcp.ts";
import { patternLines } from "../../../shared/mcp.ts";
import { patternText, timeoutMs, timeoutText } from "./Mcp.model.ts";

type Seed = Pick<
  McpServerSummary,
  | "read"
  | "write"
  | "instructionsOn"
  | "timeoutMs"
  | "readPatterns"
  | "writePatterns"
  | "excludedPatterns"
>;

export type McpSettings = {
  read: Signal<boolean>;
  write: Signal<boolean>;
  instructionsOn: Signal<boolean>;
  timeout: Signal<string>;
  readText: Signal<string>;
  writeText: Signal<string>;
  excludedText: Signal<string>;
};

export const NEW_SERVER: Seed = {
  read: true,
  write: false,
  instructionsOn: true,
  timeoutMs: null,
  readPatterns: [],
  writePatterns: [],
  excludedPatterns: [],
};

export function useMcpSettings(seed: Seed): McpSettings {
  return {
    read: useSignal(seed.read),
    write: useSignal(seed.write),
    instructionsOn: useSignal(seed.instructionsOn),
    timeout: useSignal(timeoutText(seed.timeoutMs)),
    readText: useSignal(patternText(seed.readPatterns)),
    writeText: useSignal(patternText(seed.writePatterns)),
    excludedText: useSignal(patternText(seed.excludedPatterns)),
  };
}

export function draftPatterns(s: McpSettings) {
  return {
    read: patternLines(s.readText.value),
    write: patternLines(s.writeText.value),
    excluded: patternLines(s.excludedText.value),
  };
}

export function settingsBody(s: McpSettings): Seed {
  const patterns = draftPatterns(s);
  return {
    read: s.read.value,
    write: s.write.value,
    instructionsOn: s.instructionsOn.value,
    timeoutMs: timeoutMs(s.timeout.value),
    readPatterns: patterns.read,
    writePatterns: patterns.write,
    excludedPatterns: patterns.excluded,
  };
}
