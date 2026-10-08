// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A subagent's offer against its parent's, over fake parts: every cut
// tool goes, the rest stays, and its MCP links are read alone.

import { describe, expect, test } from "bun:test";
import { silent } from "../../../src/server/lib/log.ts";
import { offered } from "../../../src/server/tools/offer.ts";
import type { Tool } from "../../../src/server/tools/types.ts";
import type { AgentServer } from "../../../src/shared/contracts/mcp.ts";

const tool = (name: string): Tool => ({
  name,
  description: name,
  parameters: { type: "object" },
  run: async () => "",
});

function parts() {
  const links: AgentServer[][] = [];
  const deps = {
    store: {
      row: () => ({
        enabled: true,
        mode: "all",
        hosts: [],
        provider: null,
        updatedAt: 0,
      }),
    },
    skills: { forAgent: () => [], body: () => null, file: () => null },
    mcp: {
      offered: (given: AgentServer[]) => {
        links.push(given);
        return {
          servers: [],
          prompt: {
            text: "",
            included: [],
            leftForSchemas: [],
            leftForInstructions: [],
            digest: {},
          },
        };
      },
    },
    memory: {
      work: () => {
        throw new Error("no own note here");
      },
      edit: () => ({ error: false, content: "" }),
      refuse: (_p: string, _s: string, reason: string) => reason,
    },
    credentials: {
      forProject: () =>
        [
          ["c-rw", ["GET", "POST", "DELETE"]],
          ["c-w", ["POST", "PUT"]],
          ["c-r", ["HEAD"]],
        ].map(([name, methods]) => ({
          id: name,
          name,
          keyName: name,
          prefix: `https://${name}.test/`,
          header: "Authorization",
          template: "{key}",
          methods,
        })),
    },
    emailOn: () => true,
    toolsFor: () =>
      ["datetime", "bash", "webfetch", "visualize", "email_user"].map(tool),
    log: silent,
  } as unknown as Parameters<typeof offered>[0];
  return { deps, links };
}

const SERVERS: AgentServer[] = [{ serverId: "s1", read: true, write: true }];

describe("a subagent's offer", () => {
  test("is its parent's less every cut tool, and its links read alone", () => {
    const { deps, links } = parts();
    const main = offered(
      deps,
      0,
      "a",
      SERVERS,
      "auto",
      {
        projectId: "p",
        automation: null,
        phase: "main",
        chat: { sessionId: "s", userId: "u" },
        delegate: true,
      },
      [],
    );
    expect(main.tools.map((t) => t.name).sort()).toEqual([
      "bash",
      "datetime",
      "delegate",
      "email_user",
      "memory_edit",
      "visualize",
      "webfetch",
    ]);
    const child = offered(
      deps,
      0,
      "a",
      SERVERS,
      "auto",
      { projectId: "p", automation: null, phase: "child" },
      [],
    );
    expect(child.tools.map((t) => t.name).sort()).toEqual([
      "bash",
      "datetime",
      "webfetch",
    ]);
    expect(child.subagent).toBe(true);
    expect(child.memory).toBeNull();
    expect(links).toEqual([
      SERVERS,
      [{ serverId: "s1", read: true, write: false }],
    ]);
  });

  test("marks credentials read-only, one with no read method off", () => {
    const { deps } = parts();
    const scope = { projectId: "p", automation: null } as const;
    const methods = (o: ReturnType<typeof offered>) =>
      o.credentials.map((c) => [c.name, c.methods, c.readOnly ?? false]);
    const main = offered(deps, 0, "a", [], "auto", {
      ...scope,
      phase: "main",
    });
    expect(methods(main)).toEqual([
      ["c-rw", ["GET", "POST", "DELETE"], false],
      ["c-w", ["POST", "PUT"], false],
      ["c-r", ["HEAD"], false],
    ]);
    const child = offered(deps, 0, "a", [], "auto", {
      ...scope,
      phase: "child",
    });
    expect(methods(child)).toEqual([
      ["c-rw", ["GET", "POST", "DELETE"], true],
      ["c-r", ["HEAD"], true],
    ]);
    expect(main.credentialsOff).toEqual([]);
    expect(child.credentialsOff.map((c) => c.name)).toEqual(["c-w"]);
  });

  test("a main offer without the switch carries no delegate", () => {
    const { deps } = parts();
    const main = offered(deps, 0, "a", [], "auto", {
      projectId: "p",
      automation: null,
      phase: "main",
    });
    expect(main.tools.map((t) => t.name)).not.toContain("delegate");
  });
});
