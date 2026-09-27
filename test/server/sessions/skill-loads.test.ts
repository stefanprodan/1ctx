// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/index.ts";
import {
  SKILL_LOADS,
  skillLoads,
} from "../../../src/server/sessions/activity.ts";

// a reply's calls and their tool rows; the query reads no other table,
// so the keys are off
function db() {
  const d = new Database(":memory:");
  migrate(d as never);
  d.exec("pragma foreign_keys = off");
  let seq = 0;
  const row = (
    kind: string,
    send: string,
    round: number,
    at: number,
    extra: { status?: string; calls?: string; tool?: string; call?: string },
  ) => {
    seq++;
    d.query(
      `insert into messages (id, session_id, seq, kind, send_id, round, slot,
         status, tool_calls, tool_name, tool_call_id, created_at)
       values (?, 'c1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `m${seq}`,
      seq,
      kind,
      send,
      round,
      kind === "reply" ? "work" : null,
      extra.status ?? "done",
      extra.calls ?? null,
      extra.tool ?? null,
      extra.call ?? null,
      at,
    );
  };
  // one round: a reply naming each call, then a tool row per call
  const round = (
    send: string,
    n: number,
    at: number,
    calls: { tool: string; args: string; status?: string; id?: string }[],
  ) => {
    const ids = calls.map((c, i) => c.id ?? `call_${i}`);
    row("reply", send, n, at, {
      calls: JSON.stringify(
        calls.map((c, i) => ({ id: ids[i], name: c.tool, arguments: c.args })),
      ),
    });
    calls.forEach((c, i) => {
      row("tool", send, n, at, {
        tool: c.tool,
        call: ids[i],
        status: c.status,
      });
    });
  };
  return { d, round };
}

const load = (name: string) => ({
  tool: "skill",
  args: JSON.stringify({ name }),
});
const read = (name: string, path: string) => ({
  tool: "skill_file",
  args: JSON.stringify({ name, path }),
});

test("skill calls count by the name their call carried", () => {
  const { d, round } = db();
  round("s1", 1, 100, [load("flux"), { ...load("timoni"), status: "failed" }]);
  // the same call ids in the next round and another send stay apart
  round("s1", 2, 110, [read("flux", "a.md"), read("flux", "b.md")]);
  round("s2", 1, 120, [read("flux", "a.md"), load("flux")]);
  // a built-in, arguments that are not JSON, and a call with no name
  round("s3", 1, 120, [
    { tool: "bash", args: "{}" },
    { tool: "skill", args: "{not json" },
    { tool: "skill", args: "{}" },
  ]);
  // the window starts after since and ends at until
  round("s4", 1, 50, [load("flux")]);
  round("s5", 1, 200, [load("flux")]);
  expect(skillLoads(d as never, 50, 150)).toEqual({
    loads: 3,
    reads: 3,
    failed: 1,
    skills: [
      {
        name: "flux",
        loads: 2,
        reads: 3,
        failed: 0,
        files: [
          { path: "a.md", reads: 2 },
          { path: "b.md", reads: 1 },
        ],
      },
      { name: "timoni", loads: 1, reads: 0, failed: 1, files: [] },
    ],
  });
  expect(skillLoads(d as never, 300, 400)).toEqual({
    loads: 0,
    reads: 0,
    failed: 0,
    skills: [],
  });
});

test("a repeated call id pairs by position, as the writer pairs them", () => {
  const { d, round } = db();
  round("s1", 1, 100, [
    { ...load("a"), id: "x" },
    { ...load("b"), id: "x", status: "failed" },
  ]);
  // a built-in ahead of a skill call keeps the skill call's position
  round("s2", 1, 100, [
    { tool: "bash", args: "{}" },
    { ...read("a", ""), id: "y" },
  ]);
  expect(skillLoads(d as never, 50, 150)).toEqual({
    loads: 2,
    reads: 1,
    failed: 1,
    skills: [
      // a read with no path counts but names no file
      { name: "a", loads: 1, reads: 1, failed: 0, files: [] },
      { name: "b", loads: 1, reads: 0, failed: 1, files: [] },
    ],
  });
});

test("skill calls read the tool rows' index and the send's", () => {
  const { d } = db();
  const plan = d
    .query<{ detail: string }, [string, string, number, number]>(
      `explain query plan ${SKILL_LOADS}`,
    )
    .all("skill", "skill_file", 0, 1)
    .map((row) => row.detail)
    .join(" ");
  expect(plan).toContain("messages_tool_activity");
  expect(plan).not.toMatch(/SCAN (t|r|o)\b/);
});
