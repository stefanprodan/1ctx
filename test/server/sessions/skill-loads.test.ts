// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  SKILL_LOADS,
  skillLoads,
} from "../../../src/server/sessions/activity.ts";
import type { MessageStatus } from "../../../src/shared/words.ts";
import { memoryDb } from "../../helpers/db.ts";
import { messageRows } from "../../helpers/messages.ts";

// a reply's calls and their tool rows; the query reads no other table,
// so the keys are off
function db() {
  const d = memoryDb();
  d.exec("pragma foreign_keys = off");
  const row = messageRows(d);
  const round = (
    send: string,
    n: number,
    at: number,
    calls: {
      tool: string;
      args: string;
      status?: MessageStatus;
      id?: string;
    }[],
  ) => {
    const ids = calls.map((c, i) => c.id ?? `call_${i}`);
    row("reply", at, {
      send,
      round: n,
      calls: JSON.stringify(
        calls.map((c, i) => ({ id: ids[i], name: c.tool, arguments: c.args })),
      ),
    });
    calls.forEach((c, i) => {
      row("tool", at, {
        send,
        round: n,
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
  round("s1", 1, 50, [load("flux"), { ...load("timoni"), status: "failed" }]);
  // the same call ids in the next round and another send stay apart
  round("s1", 2, 110, [read("flux", "a.md"), read("flux", "b.md")]);
  round("s2", 1, 120, [read("flux", "a.md"), load("flux")]);
  // a built-in, arguments that are not JSON, and a call with no name
  round("s3", 1, 120, [
    { tool: "bash", args: "{}" },
    { tool: "skill", args: "{not json" },
    { tool: "skill", args: "{}" },
  ]);
  // outside [since, until)
  round("s4", 1, 49, [load("flux")]);
  round("s5", 1, 150, [load("flux")]);
  expect(skillLoads(d, 50, 150)).toEqual({
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
  expect(skillLoads(d, 300, 400)).toEqual({
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
  expect(skillLoads(d, 50, 150)).toEqual({
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
