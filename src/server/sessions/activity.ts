// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a person did per day, for their page: the messages they wrote
// in chats, the chats they started and the runs they started by hand.
// A fork's copied messages keep the instant they were first written,
// before the fork was made, so only a message no older than its chat
// is theirs to count there. A run's instructions are a user message
// too, which the chat origin leaves out.

import { splitWireName } from "../../shared/mcp.ts";
import type { Db } from "../db/index.ts";
import { countByDay } from "../usage/index.ts";

export function personDays(
  db: Db,
  userId: string,
  starts: readonly number[],
  until: number,
): number[] {
  if (starts.length === 0) return [];
  const since = starts[0]!;
  const rows = db
    .query<{ at: number }, [string, number, number, string, number, number]>(
      `select m.created_at as at
         from messages m
         join sessions s on s.id = m.session_id
        where m.user_id = ? and m.kind = 'user'
          and m.created_at >= ? and m.created_at < ?
          and s.origin = 'chat' and m.created_at >= s.created_at
       union all
       select created_at as at
         from sessions
        where owner_id = ?
          and created_at >= ? and created_at < ?
          and (origin = 'chat'
               or (origin = 'automation' and run_source = 'manual'))`,
    )
    .all(userId, since, until, userId, since, until);
  return countByDay(
    starts,
    until,
    rows.map((row) => row.at),
  );
}

// the MCP tool rows in a window by wire name: every one starts with
// mcp__<server>__ in both modes, since the loop writes a catalog call
// under the tool's own name, and `~` sorts after every character a
// wire name may hold
function toolRows(db: Db, prefix: string, since: number, until: number) {
  return db
    .query<
      { name: string; calls: number; failed: number },
      [string, string, number, number]
    >(
      `select tool_name as name, count(*) as calls,
              sum(status = 'failed') as failed
         from messages
        where kind = 'tool' and tool_name >= ? and tool_name < ?
          and created_at > ? and created_at <= ?
        group by tool_name`,
    )
    .all(prefix, `${prefix}~`, since, until);
}

type Calls = { calls: number; failed: number };

const byCalls = (a: { name: string; calls: number }, b: typeof a) =>
  b.calls - a.calls || a.name.localeCompare(b.name);

// one server's calls, per tool; its name holds no underscore, so no
// other server's names start with its prefix
export function mcpCalls(
  db: Db,
  server: string,
  since: number,
  until: number,
): Calls & { tools: { name: string; calls: number }[] } {
  const prefix = `mcp__${server}__`;
  const rows = toolRows(db, prefix, since, until);
  const total = { calls: 0, failed: 0 };
  for (const row of rows) {
    total.calls += row.calls;
    total.failed += row.failed;
  }
  const tools = rows
    .map((row) => ({ name: row.name.slice(prefix.length), calls: row.calls }))
    .sort(byCalls);
  return { ...total, tools };
}

// every server's calls, by the name its tool rows carry, a deleted
// server's included
export function mcpServerCalls(
  db: Db,
  since: number,
  until: number,
): Calls & { servers: ({ name: string } & Calls)[] } {
  const total = { calls: 0, failed: 0 };
  const by = new Map<string, Calls>();
  for (const row of toolRows(db, "mcp__", since, until)) {
    const server = splitWireName(row.name)?.server;
    if (server === undefined) continue;
    const seen = by.get(server) ?? { calls: 0, failed: 0 };
    seen.calls += row.calls;
    seen.failed += row.failed;
    by.set(server, seen);
    total.calls += row.calls;
    total.failed += row.failed;
  }
  const servers = [...by]
    .map(([name, calls]) => ({ name, ...calls }))
    .sort(byCalls);
  return { ...total, servers };
}

export type SkillLoads = {
  loads: number;
  reads: number;
  failed: number;
  skills: {
    name: string;
    loads: number;
    reads: number;
    failed: number;
    files: { path: string; reads: number }[];
  }[];
};

// the skill and skill_file rows in a window, by the skill their call
// named: a tool row holds the result only, so the name is read from the
// call in the reply of the same round, a deleted skill's included
export function skillLoads(db: Db, since: number, until: number): SkillLoads {
  const rows = db
    .query<
      { tool: string; args: string | null; failed: number },
      [number, number]
    >(
      `select t.tool_name as tool, json_extract(c.value, '$.arguments') as args,
              t.status = 'failed' as failed
         from messages t
         join messages r
           on r.send_id = t.send_id and r.round = t.round
          and r.kind = 'reply' and json_valid(r.tool_calls)
         join json_each(r.tool_calls) c
           on json_extract(c.value, '$.id') = t.tool_call_id
        where t.kind = 'tool' and t.tool_name in ('skill', 'skill_file')
          and t.created_at > ? and t.created_at <= ?`,
    )
    .all(since, until);
  const total = { loads: 0, reads: 0, failed: 0 };
  const by = new Map<
    string,
    { loads: number; reads: number; failed: number; files: Map<string, number> }
  >();
  for (const row of rows) {
    const args = callArgs(row.args);
    if (args === null) continue;
    const seen = by.get(args.name) ?? {
      loads: 0,
      reads: 0,
      failed: 0,
      files: new Map(),
    };
    const which = row.tool === "skill" ? "loads" : "reads";
    seen[which]++;
    total[which]++;
    if (row.failed) {
      seen.failed++;
      total.failed++;
    }
    if (which === "reads" && args.path !== "") {
      seen.files.set(args.path, (seen.files.get(args.path) ?? 0) + 1);
    }
    by.set(args.name, seen);
  }
  const skills = [...by]
    .map(([name, s]) => ({
      name,
      loads: s.loads,
      reads: s.reads,
      failed: s.failed,
      files: [...s.files]
        .map(([path, reads]) => ({ path, reads }))
        .sort((a, b) => b.reads - a.reads || a.path.localeCompare(b.path)),
    }))
    .sort(
      (a, b) =>
        b.loads - a.loads || b.reads - a.reads || a.name.localeCompare(b.name),
    );
  return { ...total, skills };
}

// a model may send arguments that are not JSON; such a call named no skill
function callArgs(text: string | null): { name: string; path: string } | null {
  if (text === null) return null;
  let args: unknown;
  try {
    args = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof args !== "object" || args === null) return null;
  const { name, path } = args as Record<string, unknown>;
  if (typeof name !== "string" || name === "") return null;
  return { name, path: typeof path === "string" ? path : "" };
}
