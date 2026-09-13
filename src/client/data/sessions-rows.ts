// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The pure half of the sessions entity: the stream's order, the merge
// of rows an envelope carries, and the live map a detail seeds.

import type {
  Message,
  SessionDetail,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import { type Live, liveOf, liveOfSnapshot } from "../transcript/stream.ts";

// the stream's order: running first, then by last activity, newest first
export function ordered(rows: SessionSummary[]): SessionSummary[] {
  return [...rows].sort((a, b) => {
    const ra = a.status === "running" ? 1 : 0;
    const rb = b.status === "running" ? 1 : 0;
    if (ra !== rb) return rb - ra;
    if (a.lastActivityAt !== b.lastActivityAt) {
      return b.lastActivityAt - a.lastActivityAt;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// the rows whose text streams: a reply, and the summary round's row
export const streams = (m: Message) =>
  m.kind === "reply" || m.kind === "summary";

// the live map from a detail: the streaming rows, the runner's
// snapshot for the one it is about. The "tools" phase has no row, so
// every streaming row starts from itself
export function liveFrom(detail: SessionDetail): Map<string, Live> {
  const map = new Map<string, Live>();
  const snap = detail.live?.phase === "reply" ? detail.live : null;
  for (const m of detail.messages) {
    if (!streams(m) || m.status !== "streaming") continue;
    map.set(
      m.id,
      snap !== null && snap.messageId === m.id
        ? liveOfSnapshot(snap, m)
        : liveOf(m),
    );
  }
  return map;
}

// the envelope's rows over the held ones, in seq order
export function upsert(rows: Message[], next: Message[]): Message[] {
  const out = rows.slice();
  for (const m of next) {
    const i = out.findIndex((x) => x.id === m.id);
    if (i === -1) out.push(m);
    else out[i] = m;
  }
  return out.sort((a, b) => a.seq - b.seq);
}
