// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A chat as a Markdown file: what a person reads in the main column,
// without the fold. Rows are grouped by send the way the transcript
// groups them, so a turn that was stopped, failed or cut says so under
// its partial answer instead of passing for a finished one, and a turn
// that ended with no answer still leaves its line. Summaries are
// context for the model, not conversation, so they stay out.

import type { MessageKind, MessageStatus } from "../../shared/words.ts";

export type ExportRow = {
  sendId: string;
  kind: MessageKind;
  slot: "work" | "answer" | null;
  status: MessageStatus;
  error: string | null;
  finishReason: string | null;
  // the username for a user row, the agent's name for an agent row
  author: string | null;
  content: string;
  createdAt: number;
  finishedAt: number | null;
};

export function chatMarkdown(
  title: string,
  rows: ExportRow[],
  timeZone: string,
): string {
  const stamp = timestamp(timeZone);
  const parts = [`# ${escapeInline(title)}`];
  for (const turn of sends(rows)) {
    const user = turn.find((row) => row.kind === "user");
    if (user !== undefined) {
      parts.push(heading(user.author ?? "someone", user.createdAt, stamp));
      parts.push(body(user.content));
    }
    const agent = agentTurn(turn);
    if (agent === null) continue;
    parts.push(heading(agent.author, agent.at, stamp));
    if (agent.content !== "") parts.push(agent.content);
    if (agent.cut !== null) parts.push(`_${escapeInline(agent.cut)}_`);
  }
  return `${parts.join("\n\n")}\n`;
}

function sends(rows: ExportRow[]): ExportRow[][] {
  const out = new Map<string, ExportRow[]>();
  for (const row of rows) {
    const turn = out.get(row.sendId) ?? [];
    turn.push(row);
    out.set(row.sendId, turn);
  }
  return [...out.values()];
}

// the agent's side of one send, as the transcript's reply shows it: the
// answer, the reason it was cut, and the time the turn ended. Null for
// a send still running, and for a compact send, which has no turn
function agentTurn(turn: ExportRow[]): {
  author: string;
  content: string;
  cut: string | null;
  at: number;
} | null {
  const agentRows = turn.filter(
    (row) => row.kind === "reply" || row.kind === "tool",
  );
  if (agentRows.length === 0) return null;
  if (turn.some((row) => row.status === "streaming")) return null;
  const answer =
    agentRows.find((row) => row.kind === "reply" && row.slot === "answer") ??
    null;
  const ended = answer ?? endedBy(agentRows);
  const last = agentRows[agentRows.length - 1]!;
  return {
    author:
      agentRows.find((row) => row.kind === "reply" && row.author !== null)
        ?.author ?? "agent",
    content: answer === null ? "" : body(answer.content),
    cut: ended === null ? null : cutReason(ended),
    at: answer?.finishedAt ?? last.finishedAt ?? last.createdAt,
  };
}

// the row whose end explains a turn with no answer: the last stopped or
// failed row, else the last reply
function endedBy(rows: ExportRow[]): ExportRow | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.status === "stopped" || row.status === "failed") return row;
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.kind === "reply") return rows[i]!;
  }
  return null;
}

// the words the transcript puts under a cut turn
function cutReason(row: ExportRow): string | null {
  if (row.status === "stopped") return "stopped";
  if (row.status === "failed") return row.error ?? "failed";
  if (row.finishReason === "length") return "cut at max tokens";
  return null;
}

function heading(
  author: string,
  at: number,
  stamp: (ms: number) => string,
): string {
  return `## @${author} ${stamp(at)}`;
}

// only the blank lines around the text go: an indented first line is a
// code block and trailing spaces are a line break
function body(content: string): string {
  return content
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .replace(/(?:\r?\n[ \t]*)+$/, "");
}

// a title or an error is plain text wherever the app shows it, so the
// file shows it as written rather than as markup
function escapeInline(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[\\`*_[\]<>#|~&]/g, "\\$&");
}

// a date a file sorts and a reader in the caller's zone recognises as
// the time the transcript showed, whatever the locale
function timestamp(timeZone: string): (ms: number) => string {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return (ms) => {
    const part = Object.fromEntries(
      format.formatToParts(ms).map((p) => [p.type, p.value]),
    );
    return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}`;
  };
}

// the header's filename is quoted ASCII, so anything else would need
// the RFC 5987 form; a slug of the title is enough to find the file
export function markdownFilename(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\p{M}'’]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${slug === "" ? "chat" : slug}.md`;
}
