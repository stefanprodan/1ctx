// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words on a stream row, from what the server said: the state
// line under the title and the time on the right. Nothing here reads
// a transcript; the send's counters, its cause and the last line come
// on the row.

import type { StreamRow } from "../../shared/api/sessions.ts";
import { ago, elapsed } from "../lib/format.ts";

// the first line of an error, so a provider's paragraph stays a line
const firstLine = (text: string): string =>
  text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";

export function stateLine(row: StreamRow): string {
  const { session, send, last } = row;
  switch (session.status) {
    case "running": {
      const calls = send?.toolCalls ?? 0;
      if (calls === 0) return "working";
      return `working · ${calls} tool ${calls === 1 ? "call" : "calls"}`;
    }
    case "failed": {
      const error = send?.error === null ? "" : firstLine(send?.error ?? "");
      return error === "" ? "failed" : `failed · ${error}`;
    }
    case "stopped":
      return send?.cause === "shutdown" || send?.cause === "restart"
        ? "stopped · the server restarted"
        : "stopped";
    default:
      return last === null ? "" : `${last.author}: ${last.text}`;
  }
}

// the send's elapsed time while it runs, else how long ago the last
// activity was
export function whenText(row: StreamRow, now: number): string {
  const { session, send } = row;
  if (session.status === "running") {
    return elapsed(now - (send?.startedAt ?? session.lastActivityAt));
  }
  return ago(session.lastActivityAt, now);
}

// the running row's clock moves every second; the rest every half
// minute, the coarseness of ago()
export function tickMs(rows: StreamRow[] | null): number {
  return rows?.some((row) => row.session.status === "running") ? 1000 : 30_000;
}
