// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "../../src/server/db/index.ts";
import type { MessageStatus } from "../../src/shared/words.ts";

export function messageRows(db: Db) {
  let seq = 0;
  return (
    kind: "reply" | "tool",
    at: number,
    extra: {
      send?: string;
      round?: number;
      status?: MessageStatus;
      calls?: string;
      tool?: string;
      call?: string;
    } = {},
  ) => {
    seq++;
    const id = `m${seq}`;
    db.query(
      `insert into messages (id, session_id, seq, kind, send_id, round, slot,
         status, tool_calls, tool_name, tool_call_id, created_at)
       values (?, 'c1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      seq,
      kind,
      extra.send ?? "s1",
      extra.round ?? 1,
      kind === "reply" ? "work" : null,
      extra.status ?? "done",
      extra.calls ?? null,
      extra.tool ?? null,
      kind === "tool" ? (extra.call ?? `call${seq}`) : null,
      at,
    );
    return id;
  };
}
