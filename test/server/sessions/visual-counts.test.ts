// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/index.ts";
import { visualCounts } from "../../../src/server/sessions/activity.ts";

// tool rows and the files opened from them; the queries read no other
// table, so the keys are off
function db() {
  const d = new Database(":memory:");
  migrate(d as never);
  d.exec("pragma foreign_keys = off");
  let seq = 0;
  const tool = (name: string, at: number, status = "done") => {
    seq++;
    d.query(
      `insert into messages (id, session_id, seq, kind, send_id, round,
         status, tool_name, tool_call_id, created_at)
       values (?, 'c1', ?, 'tool', 's1', 1, ?, ?, ?, ?)`,
    ).run(`m${seq}`, seq, status, name, `call_${seq}`, at);
    return `m${seq}`;
  };
  const opened = (message: string, kinds: string[]) => {
    kinds.forEach((kind, position) => {
      d.query(
        `insert into opened_files (message_id, position, path, kind, bytes,
           lines, text)
         values (?, ?, 'a', ?, 1, 1, 'x')`,
      ).run(message, position, kind);
    });
  };
  return { d, tool, opened };
}

test("visuals count the visualize calls and the files opened as visuals", () => {
  const { d, tool, opened } = db();
  tool("visualize", 100);
  tool("visualize", 110);
  tool("visualize", 120, "failed");
  tool("visualize", 130, "stopped");
  opened(tool("bash", 140), ["visual", "code", "visual"]);
  opened(tool("bash", 150), ["markdown"]);
  // outside the window: since is left out, until is kept
  tool("visualize", 50);
  opened(tool("bash", 50), ["visual"]);
  tool("visualize", 300);
  expect(visualCounts(d as never, 50, 200)).toEqual({
    drawn: 2,
    failed: 1,
    opened: 2,
  });
  expect(visualCounts(d as never, 400, 500)).toEqual({
    drawn: 0,
    failed: 0,
    opened: 0,
  });
});
