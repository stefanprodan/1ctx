// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a person did per day, for their page: the messages they wrote
// in chats, the chats they started and the runs they started by hand.
// A fork's copied messages keep the instant they were first written,
// before the fork was made, so only a message no older than its chat
// is theirs to count there. A run's instructions are a user message
// too, which the chat origin leaves out.

import type { AgentActivity } from "../../shared/api/agents.ts";
import type {
  McpCalls,
  McpServersUsage,
  McpUsage,
} from "../../shared/api/mcp.ts";
import type { SkillLoads } from "../../shared/api/skills.ts";
import type { VisualCounts, WebCounts } from "../../shared/api/tools.ts";
import { splitWireName } from "../../shared/mcp.ts";
import { SKILL_TOOLS } from "../../shared/words.ts";
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

// every MCP tool row starts with mcp__<server>__, a catalog call too,
// since the loop writes it under the tool's own name; `~` sorts after
// every character a wire name may hold
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
          and created_at >= ? and created_at < ?
        group by tool_name`,
    )
    .all(prefix, `${prefix}~`, since, until);
}

const add = (into: McpCalls, row: McpCalls) => {
  into.calls += row.calls;
  into.failed += row.failed;
};

const byCalls = (a: { name: string; calls: number }, b: typeof a) =>
  b.calls - a.calls || a.name.localeCompare(b.name);

// no underscore in a server name, so no other server's rows start
// with this prefix
export function mcpCalls(
  db: Db,
  server: string,
  since: number,
  until: number,
): McpUsage {
  const prefix = `mcp__${server}__`;
  const rows = toolRows(db, prefix, since, until);
  const total = { calls: 0, failed: 0 };
  for (const row of rows) add(total, row);
  const tools = rows
    .map((row) => ({ name: row.name.slice(prefix.length), calls: row.calls }))
    .sort(byCalls);
  return { ...total, tools };
}

export function mcpServerCalls(
  db: Db,
  since: number,
  until: number,
): McpServersUsage {
  const total = { calls: 0, failed: 0 };
  const by = new Map<string, McpCalls>();
  for (const row of toolRows(db, "mcp__", since, until)) {
    const server = splitWireName(row.name)?.server;
    if (server === undefined) continue;
    const seen = by.get(server) ?? { calls: 0, failed: 0 };
    add(seen, row);
    by.set(server, seen);
    add(total, row);
  }
  const servers = [...by]
    .map(([name, calls]) => ({ name, ...calls }))
    .sort(byCalls);
  return { ...total, servers };
}

// opened visuals are found through the bash rows that carry them
export function visualCounts(
  db: Db,
  since: number,
  until: number,
): VisualCounts {
  const calls = db
    .query<{ drawn: number; failed: number }, [number, number]>(
      `select coalesce(sum(status = 'done'), 0) as drawn,
              coalesce(sum(status = 'failed'), 0) as failed
         from messages
        where kind = 'tool' and tool_name = 'visualize'
          and created_at >= ? and created_at < ?`,
    )
    .get(since, until)!;
  const files = db
    .query<{ opened: number }, [number, number]>(
      `select count(*) as opened
         from messages t
         join opened_files f on f.message_id = t.id
        where t.kind = 'tool' and t.tool_name = 'bash'
          and t.created_at >= ? and t.created_at < ?
          and f.kind = 'visual'`,
    )
    .get(since, until)!;
  return { ...calls, opened: files.opened };
}

// curl in bash is not a tool row of its own, so it is not counted
export function webCounts(db: Db, since: number, until: number): WebCounts {
  return db
    .query<WebCounts, [number, number]>(
      `select coalesce(sum(tool_name = 'webfetch' and status = 'done'), 0)
                as fetches,
              coalesce(sum(tool_name = 'websearch' and status = 'done'), 0)
                as searches,
              coalesce(sum(status = 'failed'), 0) as failed
         from messages
        where kind = 'tool' and tool_name in ('webfetch', 'websearch')
          and created_at >= ? and created_at < ?`,
    )
    .get(since, until)!;
}

// a tool row holds the result only, so the skill a call named is read
// from the call in the reply of the same round, paired by position as
// the writer pairs them, since a provider may repeat a call id. A test
// checks this query's plan
export const SKILL_LOADS = `
  select t.tool_name as tool, json_extract(c.value, '$.arguments') as args,
              t.status = 'failed' as failed
         from messages t
         join messages r
           on r.send_id = t.send_id and r.round = t.round
          and r.kind = 'reply' and json_valid(r.tool_calls)
         join json_each(r.tool_calls) c
           on c.key = (select count(*) from messages o
                        where o.send_id = t.send_id and o.round = t.round
                          and o.kind = 'tool' and o.seq < t.seq)
          and json_extract(c.value, '$.id') = t.tool_call_id
        where t.kind = 'tool' and t.tool_name in (?, ?)
          and t.created_at >= ? and t.created_at < ?`;

export function skillLoads(db: Db, since: number, until: number): SkillLoads {
  const rows = db
    .query<
      { tool: string; args: string | null; failed: number },
      [string, string, number, number]
    >(SKILL_LOADS)
    .all(...SKILL_TOOLS, since, until);
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

// one seek per agent into each of the 0032 migration's indexes
export function agentActivity(db: Db): AgentActivity[] {
  return db
    .query<{ agentId: string; lastAt: number | null; running: number }, []>(
      `select a.id as agentId,
              (select max(s.started_at) from sends s
                where s.agent_id = a.id) as lastAt,
              exists (select 1 from sends s
                where s.agent_id = a.id and s.status = 'running') as running
         from agents a
        where a.deleted_at is null`,
    )
    .all()
    .flatMap((row) =>
      row.lastAt === null
        ? []
        : [
            {
              agentId: row.agentId,
              lastAt: row.lastAt,
              running: row.running === 1,
            },
          ],
    );
}
