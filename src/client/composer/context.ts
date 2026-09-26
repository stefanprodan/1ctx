// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The context readout next to Send: how much of the model's window
// the session's last counted round used, prompt plus completion, since
// the prompt is the whole request. The window is the one that round
// saw. Nothing to show before a round has finished or when the catalog
// did not size the model.

import type { RoundUsage } from "../../shared/contracts/session.ts";
import { commas, k } from "../lib/format.ts";

export type Readout = {
  // "12K / 128K"
  text: string;
  // 0 to 100
  percent: number;
  title: string;
};

export function readout(usage: RoundUsage | null | undefined): Readout | null {
  if (!usage) return null;
  const window = usage.contextLength;
  if (window === null || window <= 0) return null;
  const used = usage.promptTokens + usage.completionTokens;
  const percent = Math.min(100, (used / window) * 100);
  return {
    text: `${k(used)} / ${k(window)}`,
    percent,
    title: `Last counted request: ${commas(used)} of ${commas(window)} tokens, prompt and reply`,
  };
}
