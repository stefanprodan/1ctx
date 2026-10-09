// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The content of a tool row a send's cut ended before the call reported
// its end, written by the runner at the cut and by restart repair. The
// model reads it on its next send, so it says why, that nothing was
// recorded, and what may still have happened, never a rollback nobody
// confirmed.

import type { SendCause } from "../../shared/words.ts";

export type CutCause = Exclude<SendCause, "finish">;

export type CutKind = "read" | "mcp-read" | "bash" | "delegate" | "write";

const WHY: Record<CutCause, string> = {
  stop: "The user stopped the send.",
  deadline: "The send reached its deadline.",
  failure: "The send failed.",
  shutdown: "The server shut down.",
  restart: "The server restarted unexpectedly.",
};

const NOTHING = "No result was recorded.";

const OUTCOME: Record<CutKind, string> = {
  read: "It only reads; calling it again is safe.",
  "mcp-read":
    "It is classified as read-only, so calling it again should be safe.",
  bash: "File changes may have been saved and requests may have reached their hosts; inspect before repeating.",
  delegate:
    "Partial work or returned files may remain, and external requests may have taken effect; inspect before delegating again.",
  write: "It may have taken effect; check before calling it again.",
};

const DISCARDED =
  "Its file changes were discarded. Requests it sent may have reached their hosts; check before repeating any that change something.";

// the built-ins that change nothing; a name the model made up is not one
const READS: ReadonlySet<string> = new Set([
  "webfetch",
  "websearch",
  "datetime",
  "skill",
  "skill_file",
  "mcp_describe",
]);

// side is the offered MCP tool's, null when unknown: repair has no
// offer, so an MCP name there fails closed as a write
export function cutKind(name: string, side: "read" | "write" | null): CutKind {
  if (READS.has(name)) return "read";
  if (name === "bash") return "bash";
  if (name === "delegate") return "delegate";
  if (side === "read") return "mcp-read";
  return "write";
}

// discarded only when bash reported that it wrote neither tree
export function cutText(
  cause: CutCause,
  kind: CutKind,
  discarded: boolean,
): string {
  const outcome = kind === "bash" && discarded ? DISCARDED : OUTCOME[kind];
  return `${WHY[cause]} ${NOTHING} ${outcome}`;
}
