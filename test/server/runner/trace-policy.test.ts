// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The not-your-tool mark as the history builds it, from the tools the
// building send is really offered: a server the chat switched off is
// one the agent lacks.

import { expect, test } from "bun:test";
import { silent } from "../../../src/server/lib/log.ts";
import { mcpArea } from "../../../src/server/mcp/index.ts";
import { historyMessages } from "../../../src/server/runner/context.ts";
import { TRACE_HEADING } from "../../../src/server/runner/trace.ts";
import { type Offered, toolsArea } from "../../../src/server/tools/index.ts";
import { mcpKey } from "../../../src/shared/capabilities.ts";
import { call, row, tool } from "../../fixtures/runner/trace.ts";
import { fakeFetch } from "../../helpers/app.ts";
import { memoryDb } from "../../helpers/db.ts";
import { link, seedServer } from "../mcp/switches.helpers.ts";

function offers() {
  const db = memoryDb();
  const fetched = fakeFetch();
  const mcp = mcpArea({
    db,
    fetcher: fetched.fetcher,
    secret: () => null,
    keys: () => [],
    callTimeoutMs: () => 20_000,
    clock: () => 1,
    log: silent,
    version: "test",
    render: (text) => text,
    capabilities: { forget: () => {} },
    usage: {
      calls: () => ({ calls: 0, failed: 0, tools: [] }),
      servers: () => ({ calls: 0, failed: 0, servers: [] }),
    },
  });
  const flux = seedServer(mcp.store, "flux");
  const docs = seedServer(mcp.store, "docs");
  const tools = toolsArea({
    db,
    fetcher: fetched.fetcher,
    secret: () => null,
    clock: () => 1,
    log: silent,
    version: "test",
    render: (text) => text,
    skills: { forAgent: () => [], body: () => null, file: () => null },
    mcp,
  });
  const links = [link(flux), link(docs)];
  return {
    db,
    all: tools.offered(1, "", links, "all"),
    off: tools.offered(1, "", links, "all", undefined, [mcpKey(flux.id)]),
  };
}

// another agent's summoned turn that called both servers' tools
const ROWS = [
  row({ id: "u", kind: "user", userId: "u1", agentId: null, content: "go" }),
  row({
    id: "w",
    kind: "reply",
    slot: "work",
    toolCalls: [
      call("c1", "mcp__flux__get_item0", { query: "a" }),
      call("c2", "mcp__docs__get_item0", { query: "b" }),
    ],
  }),
  tool("c1", 1, "mcp__flux__get_item0", "done"),
  tool("c2", 1, "mcp__docs__get_item0", "done"),
  row({ id: "a", kind: "reply", round: 2, slot: "answer", content: "done" }),
];

const traceOf = (offered: Offered) =>
  historyMessages(
    ROWS,
    {
      username: "casey",
      userId: "u1",
      providerId: "p",
      model: "m",
      offered,
      agentId: "coder",
      summoned: null,
    },
    {
      usernameOf: () => null,
      reasoningDetailsOf: () => null,
      turnsOf: () =>
        new Map([
          [
            "send2",
            { agentId: "checker", agentName: "checker", summoned: true },
          ],
        ]),
    },
  ).at(-1)?.content;

test("a server the chat switched off is not the reader's tool", () => {
  const { db, all, off } = offers();
  try {
    expect(traceOf(all)).toBe(
      `${TRACE_HEADING}\nmcp__flux__get_item0 query=a ok\nmcp__docs__get_item0 query=b ok`,
    );
    expect(traceOf(off)).toBe(
      `${TRACE_HEADING}\nmcp__flux__get_item0 query=a ok (not your tool)\nmcp__docs__get_item0 query=b ok`,
    );
  } finally {
    db.close();
  }
});
