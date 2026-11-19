// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A subagent's offer against its parent's, over fake parts: every cut
// tool goes, the rest stays, and its MCP offer is read only.

import { describe, expect, test } from "bun:test";
import { silent } from "../../../src/server/lib/log.ts";
import type { OfferOptions } from "../../../src/server/mcp/index.ts";
import {
  DELEGATE_DESCRIPTION,
  SANDBOX_DELEGATE_DESCRIPTION,
} from "../../../src/server/tools/builtin/delegate.ts";
import { offered } from "../../../src/server/tools/offer.ts";
import type { Tool } from "../../../src/server/tools/types.ts";

const tool = (name: string): Tool => ({
  name,
  description: name,
  parameters: { type: "object" },
  run: async () => "",
});

function parts() {
  const links: [string | null, OfferOptions | undefined][] = [];
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
      offered: (projectId: string | null, options?: OfferOptions) => {
        links.push([projectId, options]);
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

describe("a subagent's offer", () => {
  test("is its parent's less every cut tool, and its MCP read only", () => {
    const { deps, links } = parts();
    const main = offered(
      deps,
      0,
      "a",
      true,
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
      true,
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
      ["p", { off: new Set(), readOnly: false }],
      ["p", { off: new Set(), readOnly: true }],
    ]);
    // an agent off MCP asks for nothing, its child neither
    links.length = 0;
    for (const phase of ["main", "child"] as const) {
      offered(deps, 0, "a", false, "auto", {
        projectId: "p",
        automation: null,
        phase,
      });
    }
    expect(links).toEqual([]);
  });

  test("under the sandbox shell says it works in this chat's sandbox, the built-in words unchanged", () => {
    const hash = (text: string) =>
      new Bun.CryptoHasher("sha256").update(text).digest("hex");
    expect(hash(DELEGATE_DESCRIPTION)).toBe(
      "e5f53ee6309ae06bd61ff5079b7a77c1570d0447ececb1fa045553662646b297",
    );
    const scope = {
      projectId: "p",
      automation: null,
      phase: "main",
      chat: { sessionId: "s", userId: "u" },
      delegate: true,
    } as const;
    const description = (o: ReturnType<typeof offered>) =>
      o.tools.find((t) => t.name === "delegate")?.description;
    for (const sandbox of [false, true]) {
      const { deps } = parts();
      const on = { ...deps, sandbox: () => sandbox };
      const main = offered(on, 0, "a", false, "auto", scope);
      expect(main.sandbox).toBe(sandbox ? true : undefined);
      expect(description(main)).toBe(
        sandbox ? SANDBOX_DELEGATE_DESCRIPTION : DELEGATE_DESCRIPTION,
      );
      const child = offered(on, 0, "a", false, "auto", {
        projectId: "p",
        automation: null,
        phase: "child",
      });
      expect(child.sandbox).toBe(sandbox ? true : undefined);
    }
    expect(SANDBOX_DELEGATE_DESCRIPTION).toBe(
      "Hand a task to a subagent: a fresh copy of you with its own context, working in this chat's sandbox. It cannot see this chat, so put the goal, where to look and what to return in task; it answers in its reply. Calls in one reply run in parallel, so split independent work that way. Delegate work that would flood your context (exploring a repository, many files, web research); keep small questions and work that needs this conversation.",
    );
    expect(hash(SANDBOX_DELEGATE_DESCRIPTION)).toBe(
      "a11c624d730452207646c2d3250de69545bdf366e73b172a4d631be70f351131",
    );
  });

  test("marks credentials read-only, one with no read method off", () => {
    const { deps } = parts();
    const scope = { projectId: "p", automation: null } as const;
    const methods = (o: ReturnType<typeof offered>) =>
      o.credentials.map((c) => [c.name, c.methods, c.readOnly ?? false]);
    const main = offered(deps, 0, "a", false, "auto", {
      ...scope,
      phase: "main",
    });
    expect(methods(main)).toEqual([
      ["c-rw", ["GET", "POST", "DELETE"], false],
      ["c-w", ["POST", "PUT"], false],
      ["c-r", ["HEAD"], false],
    ]);
    const child = offered(deps, 0, "a", false, "auto", {
      ...scope,
      phase: "child",
    });
    expect(methods(child)).toEqual([
      ["c-rw", ["GET", "POST", "DELETE"], true],
      ["c-r", ["HEAD"], true],
    ]);
    expect(main.credentialsOff).toEqual([]);
    expect(child.credentialsOff.map((c) => c.name)).toEqual(["c-w"]);
    // in its parent's sandbox a subagent has its parent's network
    const shared = offered(
      { ...deps, sandbox: () => true },
      0,
      "a",
      false,
      "auto",
      { ...scope, phase: "child" },
    );
    expect(methods(shared)).toEqual(methods(main));
    expect(shared.credentialsOff).toEqual([]);
  });

  test("a main offer without the switch carries no delegate", () => {
    const { deps } = parts();
    const main = offered(deps, 0, "a", false, "auto", {
      projectId: "p",
      automation: null,
      phase: "main",
    });
    expect(main.tools.map((t) => t.name)).not.toContain("delegate");
  });
});
