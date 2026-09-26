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

// the line under the title: the last line with its author, who is
// drawn apart, or the state of a send that did not finish
export type StateLine = { author: string | null; text: string };

const plain = (text: string): StateLine => ({ author: null, text });

// the row's icon: the clock for an automation's run, the bubble for a
// chat, the box for an archived chat
export function iconOf(row: StreamRow): "clock" | "chat" | "archive" {
  if (row.session.archived !== null) return "archive";
  return row.session.origin === "automation" ? "clock" : "chat";
}

// whether the line's author is the session's agent, since deleted: the
// name is greyed, with no tag, since rows are dense
export function authorGone(row: StreamRow, line: StateLine): boolean {
  return row.agentRetired && line.author !== null && line.author === row.agent;
}

export function stateLine(row: StreamRow): StateLine {
  const { session, send, last } = row;
  // a send that did not finish is the agent's, so its state is credited
  // to the agent the way a last line is to its author
  const agent = (text: string): StateLine => ({ author: row.agent, text });
  switch (session.status) {
    case "running": {
      const calls = send?.toolCalls ?? 0;
      if (calls === 0) return agent("working");
      return agent(`working · ${calls} tool ${calls === 1 ? "call" : "calls"}`);
    }
    case "failed": {
      const error = send?.error === null ? "" : firstLine(send?.error ?? "");
      return agent(error === "" ? "failed" : `failed · ${error}`);
    }
    case "stopped":
      return agent(
        send?.cause === "shutdown" || send?.cause === "restart"
          ? "stopped · the server restarted"
          : send?.cause === "deadline"
            ? "stopped · past its deadline"
            : "stopped",
      );
    default:
      return last === null
        ? plain("")
        : { author: last.author, text: last.text };
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
