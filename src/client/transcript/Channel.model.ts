// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a channel adds to the transcript, without a DOM: the post an
// answer quotes, who may stop or cancel a turn, the words of a pending
// turn, where the context line and the gap fall among the nodes, and
// whether rows landed above the ones on screen.

import type {
  Message,
  PendingTurn,
  RunPost,
  TraceCall,
} from "../../shared/contracts/session.ts";
import { plural } from "../lib/format.ts";
import { runHref } from "../lib/hrefs.ts";
import type { Node } from "./rows.ts";
import { shortArg, toolLabel } from "./Tool.model.ts";

// the summoner and an admin act on a turn
export const mayAct = (
  viewer: { id: string; admin: boolean } | null,
  summonerId: string,
): boolean => viewer !== null && (viewer.admin || viewer.id === summonerId);

// the first line of a post with words, as the quote shows it
export function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

export type Quote = {
  post: Pick<Message, "id" | "seq" | "userId">;
  line: string;
};

// the post an agent turn answers, when its rows say which
export function quoteOf(
  firstMessageId: string | null,
  posts: ReadonlyMap<string, Message>,
): Quote | null {
  if (firstMessageId === null) return null;
  const post = posts.get(firstMessageId);
  if (post === undefined || post.kind !== "user") return null;
  return { post, line: firstLine(post.content) };
}

export const pendingWords = (
  agent: string,
  reason: PendingTurn["reason"],
): string => {
  if (reason === null) return `Waiting for @${agent}`;
  if (reason === "expired") return `@${agent} did not start: waited too long`;
  if (reason === "agent-deleted") {
    return `@${agent} did not start: the agent was deleted`;
  }
  return `@${agent} did not start`;
};

// a node's first row, which orders it in the channel
export const nodeSeq = (node: Node): number =>
  node.kind === "user" ? node.message.seq : (node.rows[0]?.seq ?? 0);

export const nodeKey = (node: Node): string =>
  node.kind === "user" ? `user:${node.message.id}` : `reply:${node.sendId}`;

// the node a line goes before: the first at or past the seq, never the
// first node, since the rows above a page's top are not held yet
export function lineAt(nodes: readonly Node[], seq: number | null) {
  if (seq === null) return null;
  const index = nodes.findIndex((node) => nodeSeq(node) >= seq);
  return index > 0 ? index : null;
}

// rows that landed above the first one on screen, as an older page does
export function prepended(
  before: string | null,
  keys: readonly string[],
): boolean {
  return before !== null && keys[0] !== before && keys.includes(before);
}

// the reader's own post, the one new row that moves a channel to its end
export const ownPost = (
  node: Node | undefined,
  channel: { viewer: { id: string } | null },
): boolean =>
  node?.kind === "user" &&
  channel.viewer !== null &&
  node.message.userId === channel.viewer.id;

// a run's posted answer: its fold's line, one line per call it made
// (no result travels with it), and the run it links to
export const runTraceWords = (calls: readonly TraceCall[]): string =>
  `Ran ${plural(calls.length, "tool")}`;

export function traceLine(call: TraceCall): {
  server: string | null;
  tool: string;
  argument: string;
  state: string;
  failed: boolean;
} {
  const label = toolLabel(call.name);
  const failed = call.status === "failed";
  return {
    ...label,
    argument: shortArg(call.name, call.arguments),
    state: failed || call.status === "stopped" ? call.status! : "",
    failed,
  };
}

// "Run of <automation>", linked while the run is kept; no words once its
// automation is gone
export function runOfLine(
  run: RunPost,
): { words: string; href: string | null } | null {
  if (run.automationName === null) return null;
  return {
    words: `Run of ${run.automationName}`,
    href: run.sessionId === null ? null : runHref(run.sessionId),
  };
}
