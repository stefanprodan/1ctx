// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { McpDigest } from "../../shared/mcp.ts";
import type { Db } from "../db/index.ts";
import { sha256 } from "../lib/ids.ts";

function canonical(digest: McpDigest): string {
  const out: McpDigest = {};
  for (const server of Object.keys(digest).sort()) {
    const value = digest[server]!;
    const tools: Record<string, string> = {};
    for (const name of Object.keys(value.tools).sort()) {
      tools[name] = value.tools[name]!;
    }
    out[server] = { tools, instructions: value.instructions };
  }
  return JSON.stringify(out);
}

export function storeMcpDigest(
  db: Db,
  digest: McpDigest | null,
): string | null {
  if (digest === null) return null;
  const body = canonical(digest);
  const key = sha256(body);
  db.query("insert or ignore into mcp_digests (key, body) values (?, ?)").run(
    key,
    body,
  );
  return key;
}

export type DigestArgs = [
  sessionId: string,
  excludeSendId: string,
  agentId: string,
];

// the last send of the same agent, so turns of agents taking turns in a
// chat do not each read as a change. The unary plus keeps the planner
// off sends_agent, which also orders by start and would walk the
// agent's sends in every chat
export function lastMcpDigest(
  db: Db,
  ...[sessionId, excludeSendId, agentId]: DigestArgs
): McpDigest | null {
  const row = db
    .query<{ body: string }, [string, string, string]>(
      `select mcp_digests.body from sends
       join mcp_digests on mcp_digests.key = sends.mcp
       where sends.session_id = ? and sends.id != ? and sends.mcp is not null
         and +sends.agent_id = ?
       order by sends.started_at desc, sends.rowid desc limit 1`,
    )
    .get(sessionId, excludeSendId, agentId);
  if (row === null) return null;
  try {
    return JSON.parse(row.body) as McpDigest;
  } catch {
    return null;
  }
}

export function sweepMcpDigests(db: Db): number {
  return db
    .query(
      `delete from mcp_digests
       where key not in (select mcp from sends where mcp is not null)`,
    )
    .run().changes;
}
