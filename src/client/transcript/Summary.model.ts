// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The summary fold's label: the runner wrote a summary row after an
// answer that filled the window, or on a compact. While it streams the
// label has a clock; done, it says how many tokens were folded, the
// summary round's prompt; failed or stopped, it says so, and the
// summary is skipped by the next request.

import type { Message } from "../../shared/contracts/session.ts";
import { k } from "../lib/format.ts";
import { clock } from "./stream.ts";

export type SummaryLabel = {
  live: boolean;
  text: string;
  err: boolean;
};

export function summaryRunning(
  message: Message,
  live: ReadonlyMap<string, unknown>,
): boolean {
  return message.status === "streaming" || live.has(message.id);
}

export function summaryLabel(
  message: Message,
  running: boolean,
  now = 0,
): SummaryLabel {
  if (running) {
    const ms = Math.max(0, now - message.createdAt);
    return { live: true, text: `Summarizing ${clock(ms)}`, err: false };
  }
  if (message.status === "done") {
    const tokens =
      message.promptTokens === null ? "" : ` ${k(message.promptTokens)} tokens`;
    return { live: false, text: `Summarized${tokens}`, err: false };
  }
  if (message.status === "stopped") {
    return { live: false, text: "Summary stopped", err: false };
  }
  return {
    live: false,
    text: `Summary failed: ${message.error ?? "failed"}`,
    err: true,
  };
}
