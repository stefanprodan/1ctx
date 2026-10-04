// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The time the fake MCP servers take for a call, a pure function of the
// bare tool name and its arguments. The fake model imports it to know
// what a round of calls costs, and the fake MCP sleeps it, so the
// summarizer can take the MCP time out of the server's gap.

import { canonical, hash32 } from "./random.ts";
import { MCP_LATENCY as L } from "./shapes.ts";

export function latencyMs(tool: string, args: unknown): number {
  const u = hash32(`${tool}\n${canonical(args ?? {})}`) / 4294967296;
  const [fastLo, fastHi] = L.fastMs;
  if (u < L.fastShare) {
    return Math.round(fastLo + (u / L.fastShare) * (fastHi - fastLo));
  }
  const mid = L.fastShare + L.midShare;
  if (u < mid) {
    return Math.round(
      L.midBaseMs * L.midFactor ** ((u - L.fastShare) / L.midShare),
    );
  }
  const [tailLo, tailHi] = L.tailMs;
  return Math.round(tailLo + ((u - mid) / (1 - mid)) * (tailHi - tailLo));
}
