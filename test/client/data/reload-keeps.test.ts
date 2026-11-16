// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A later load of a list on screen keeps its rows drawn while it is out:
// a reload, the socket's reload() or a Refresh never clears a list back
// to null, which would draw the first load's bones again.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  automations,
  loadAutomations,
} from "../../../src/client/data/automations.ts";
import {
  credentials,
  loadCredentials,
} from "../../../src/client/data/credentials.ts";
import {
  knowledgeOf,
  loadKnowledge,
} from "../../../src/client/data/knowledge.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  loadProjectAgents,
  projectAgents,
} from "../../../src/client/data/sessions.ts";
import { readSlot } from "../../../src/client/data/slot.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";
import { deferred } from "../../helpers/async.ts";

const reader: Me = {
  id: "u1",
  username: "reader",
  fullName: "Reader",
  role: "member",
  mustChangePassword: false,
};

const realFetch = globalThis.fetch;
// the answer each address gives; a held one waits for its release
let bodies: Map<string, unknown>;
let held: Map<string, () => void>;

beforeEach(() => {
  me.value = null;
  me.value = reader;
  bodies = new Map();
  held = new Map();
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    const gate = held.get(url);
    if (gate !== undefined) {
      const wait = deferred<void>();
      held.set(url, wait.resolve);
      await wait.promise;
    }
    return new Response(JSON.stringify(bodies.get(url) ?? {}), {
      status: bodies.has(url) ? 200 : 404,
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// loads once, then again with the answer held: what is drawn meanwhile,
// then what is drawn once it lands
async function reloaded<T>(
  url: string,
  load: () => Promise<unknown>,
  read: () => T,
): Promise<{ during: T; after: T }> {
  await load();
  held.set(url, () => {});
  const again = load();
  const during = read();
  held.get(url)?.();
  await again;
  return { during, after: read() };
}

describe("a reload keeps the rows drawn", () => {
  test.serial("credentials", async () => {
    const url = "/api/credentials";
    bodies.set(url, {
      credentials: [{ id: "c1", name: "gh", projects: [] }],
      keys: [],
    });
    const { during, after } = await reloaded(url, loadCredentials, () =>
      credentials.value?.map((c) => c.id),
    );
    expect(during).toEqual(["c1"]);
    expect(after).toEqual(["c1"]);
  });

  test.serial("automations", async () => {
    const url = "/api/projects/p1/automations";
    bodies.set(url, {
      automations: [{ id: "a1", name: "nightly", revision: 1 }],
      runDeadlineMs: 1000,
    });
    const { during, after } = await reloaded(
      url,
      () => loadAutomations("p1"),
      () => automations.value?.map((a) => a.id),
    );
    expect(during).toEqual(["a1"]);
    expect(after).toEqual(["a1"]);
  });

  test.serial("knowledge", async () => {
    const url = "/api/projects/p1/knowledge";
    bodies.set(url, {
      files: [],
      deleted: [],
      totals: { files: 0, bytes: 0, tokens: 0 },
      limits: { fileBytes: 1, files: 1, projectBytes: 1, historyDays: 1 },
    });
    const { during, after } = await reloaded(
      url,
      () => loadKnowledge("p1"),
      () => knowledgeOf("p1") !== null,
    );
    expect(during).toBe(true);
    expect(after).toBe(true);
  });

  test.serial("a project's agents", async () => {
    const url = "/api/projects/p1/agents";
    bodies.set(url, { agents: [{ id: "g1", name: "sre" }], startsOn: null });
    const { during, after } = await reloaded(
      url,
      () => loadProjectAgents("p1"),
      () => projectAgents.value?.map((a) => a.id),
    );
    expect(during).toEqual(["g1"]);
    expect(after).toEqual(["g1"]);
  });

  test.serial("a slot's answer, as a user's access keys", async () => {
    const url = "/api/keys/u2";
    bodies.set(url, ["k1"]);
    const keys = readSlot(async (id: string) => {
      const answer = await fetch(`/api/keys/${id}`);
      return (await answer.json()) as string[];
    });
    const { during, after } = await reloaded(
      url,
      () => keys.load("u2"),
      () => keys.valueFor("u2"),
    );
    expect(during).toEqual(["k1"]);
    expect(after).toEqual(["k1"]);
  });
});
