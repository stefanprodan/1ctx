// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { CommandCaps } from "../../../src/server/bash/mount.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { toolsArea } from "../../../src/server/tools/index.ts";
import type { ToolContext } from "../../../src/server/tools/types.ts";
import { KNOWLEDGE } from "../../../src/shared/capabilities.ts";
import { memoryDb } from "../../helpers/db.ts";

function setup() {
  const db = memoryDb();
  const seen: CommandCaps[] = [];
  const tools = toolsArea({
    db,
    clock: () => 1,
    log: silent,
    render: (text) => text,
    secret: () => null,
    skills: { forAgent: () => [], body: () => null, file: () => null },
    fetcher: (async (_input: unknown) => new Response("")) as typeof fetch,
    bash: {
      async run(_project, _session, _author, _command, caps) {
        seen.push(caps);
        return { content: "exit 0", error: false };
      },
    },
  });
  return { db, tools, seen };
}

const context = (): ToolContext => ({
  web: null,
  actor: {
    projectId: "p",
    sessionId: "s",
    userId: "u",
    agentId: "a",
    agentName: "agent",
    origin: "chat",
    sendStartedAt: 0,
  },
  now: () => 0,
  signal: new AbortController().signal,
  budget: { bashCalls: 0, fetches: 0, searches: 0, visualBytes: 0, visuals: 0 },
  caps: DEFAULT_LIMITS,
});

const bash = { id: "c1", name: "bash", arguments: '{"command":"ls"}' };

describe("the knowledge switch in the tools area", () => {
  test("keeps bash and tells the mount the docs are off", async () => {
    const { db, tools, seen } = setup();
    try {
      for (const disabled of [[], [KNOWLEDGE]]) {
        const offered = tools.offered(1, "", [], "auto", undefined, disabled);
        const off = disabled.length > 0;
        expect(offered.knowledge).toBe(!off);
        expect(offered.tools.map((tool) => tool.name)).toContain("bash");
        await tools.run(offered, bash, context());
        expect(seen.at(-1)?.knowledge).toBe(!off);
      }
    } finally {
      db.close();
    }
  });

  test("capabilities() answers the key whatever the admin's rows say", () => {
    const { db, tools } = setup();
    try {
      expect(tools.capabilities()).toContain(KNOWLEDGE);
      tools.store.setAccess("off", [], 1);
      tools.store.setEnabled("visualize", false, 1);
      expect(tools.capabilities()).toEqual([KNOWLEDGE, "memory"]);
    } finally {
      db.close();
    }
  });
});
