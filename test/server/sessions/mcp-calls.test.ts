// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  mcpCalls,
  mcpServerCalls,
} from "../../../src/server/sessions/activity.ts";
import type { MessageStatus } from "../../../src/shared/words.ts";
import { memoryDb } from "../../helpers/db.ts";
import { messageRows } from "../../helpers/messages.ts";

// tool rows alone: the query reads no other table, so the keys are off
function db() {
  const d = memoryDb();
  d.exec("pragma foreign_keys = off");
  const row = messageRows(d);
  const add = (tool: string, at: number, status: MessageStatus = "done") =>
    row("tool", at, { tool, status });
  return { d, add };
}

test("a server's calls are its tools' rows inside the window", () => {
  const { d, add } = db();
  add("mcp__github__get_me", 50);
  add("mcp__github__get_me", 120, "failed");
  add("mcp__github__search_code", 130);
  // another server whose name starts with this one's, and a built-in
  add("mcp__github-x__get_me", 130);
  add("bash", 130);
  // outside [since, until)
  add("mcp__github__get_me", 49);
  add("mcp__github__get_me", 150);
  expect(mcpCalls(d, "github", 50, 150)).toEqual({
    calls: 3,
    failed: 1,
    tools: [
      { name: "get_me", calls: 2 },
      { name: "search_code", calls: 1 },
    ],
  });
  expect(mcpCalls(d, "none", 50, 150)).toEqual({
    calls: 0,
    failed: 0,
    tools: [],
  });
});

test("a server's calls read the tool rows' index", () => {
  const { d } = db();
  const plan = d
    .query<{ detail: string }, [string, string, number, number]>(
      `explain query plan select tool_name, count(*), sum(status = 'failed')
         from messages
        where kind = 'tool' and tool_name >= ? and tool_name < ?
          and created_at >= ? and created_at < ?
        group by tool_name`,
    )
    .all("mcp__a__", "mcp__a__~", 0, 1)
    .map((row) => row.detail)
    .join(" ");
  expect(plan).toContain("USING COVERING INDEX messages_tool_activity");
});

test("every server's calls, by the name its rows carry", () => {
  const { d, add } = db();
  add("mcp__github__get_me", 100);
  add("mcp__github__get_me", 110, "failed");
  add("mcp__flux__get_x", 120);
  add("mcp__gone__t", 120);
  // a catalog tool and a built-in are not a server's
  add("mcp_describe", 120);
  add("bash", 120);
  add("mcp__flux__get_x", 10);
  expect(mcpServerCalls(d, 50, 150)).toEqual({
    calls: 4,
    failed: 1,
    servers: [
      { name: "github", calls: 2, failed: 1 },
      { name: "flux", calls: 1, failed: 0 },
      { name: "gone", calls: 1, failed: 0 },
    ],
  });
});
