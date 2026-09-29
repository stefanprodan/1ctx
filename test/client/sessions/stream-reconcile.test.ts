// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The stream list reconciles from envelopes and reloads one page at a
// time: the races between the socket and a first page out.

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  automations,
  loadAutomations,
  onAutomationsSocket,
} from "../../../src/client/data/automations.ts";
import { TRAIL_MS } from "../../../src/client/data/flight.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  applyAutomationFrame,
  applyEnvelope,
  dropRow,
  grantRows,
  list,
  loadList,
  loadMore,
  revokeRows,
} from "../../../src/client/data/stream.ts";
import type {
  EnvelopeRow,
  StreamRow,
} from "../../../src/shared/api/sessions.ts";
import type { AutomationSummary } from "../../../src/shared/contracts/automation.ts";
import type { SessionSummary } from "../../../src/shared/contracts/session.ts";

function summary(changes: Partial<SessionSummary> = {}): SessionSummary {
  return {
    archived: null,
    attention: null,
    id: "s1",
    projectId: "p1",
    ownerId: "u1",
    agentId: "a1",
    origin: "chat",
    automationId: null,
    runSource: null,
    forkedFromId: null,
    title: "Chat",
    status: "done",
    revision: 1,
    createdAt: 10,
    lastActivityAt: 20,
    usage: null,
    disabledCapabilities: [],
    ...changes,
  };
}

const chat = (id: string, at: number, changes: Partial<SessionSummary> = {}) =>
  summary({ id, createdAt: at, lastActivityAt: at, ...changes });

const run = (id: string, at: number, changes: Partial<SessionSummary> = {}) =>
  summary({
    id,
    origin: "automation",
    automationId: "au",
    title: "digest",
    createdAt: at,
    lastActivityAt: at,
    ...changes,
  });

function rowOf(session: SessionSummary, runs: number | null = null): StreamRow {
  return {
    session,
    agent: "assistant",
    agentRetired: false,
    send: null,
    last: null,
    automation:
      session.automationId === null
        ? null
        : { id: session.automationId, name: "digest" },
    runBy: null,
    runs,
  };
}

function envelope(session: SessionSummary, withRow = true) {
  const { session: _, runs: __, ...row } = rowOf(session);
  return {
    type: "session" as const,
    projectId: session.projectId,
    session,
    messages: [],
    send: null,
    row: withRow ? (row satisfies EnvelopeRow) : null,
  };
}

const ids = () => list.value?.rows.map((r) => r.session.id);

const realFetch = globalThis.fetch;
let user = 0;
let urls: string[] = [];
// the answers still out, oldest first, and the answer the next one gets
let gates: ((r: Response) => void)[] = [];

// every GET waits for release()
function gated(): void {
  globalThis.fetch = ((url: string) => {
    urls.push(url);
    return new Promise<Response>((resolve) => gates.push(resolve));
  }) as unknown as typeof fetch;
}

// the oldest answer out lands with that page
async function release(
  rows: StreamRow[],
  next: string | null = null,
): Promise<void> {
  const gate = gates.shift();
  if (gate === undefined) throw new Error("nothing out");
  gate(Response.json({ rows, next }));
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function loaded(
  filter: Parameters<typeof loadList>[0],
  rows: StreamRow[],
  next: string | null = null,
) {
  const done = loadList(filter);
  await settle();
  await release(rows, next);
  await done;
}

const HOME = { project: null, q: "" };
const base = () => [rowOf(chat("b", 50)), rowOf(chat("c", 40))];

beforeEach(() => {
  user++;
  me.value = {
    id: `rec${user}`,
    username: "casey",
    fullName: "Casey",
    role: "member",
    mustChangePassword: false,
  };
  urls = [];
  gates = [];
  gated();
});

afterEach(async () => {
  me.value = undefined;
  // answers still out land into the new user, who drops them
  for (const gate of gates) gate(Response.json({ rows: [], next: null }));
  await settle();
  globalThis.fetch = realFetch;
});

describe("an envelope for a row not held", () => {
  test.serial("inserts a chat in order and asks nothing", async () => {
    await loaded(HOME, base());
    applyEnvelope(envelope(chat("n", 45)));
    expect(ids()).toEqual(["b", "n", "c"]);
    expect(list.value?.rows[1]?.agent).toBe("assistant");
    await settle();
    expect(urls).toHaveLength(1);
  });

  test.serial("inserts a run in Tasks and in Chats leaves it", async () => {
    await loaded({ ...HOME, origin: "automation" }, [rowOf(run("r1", 30))]);
    applyEnvelope(envelope(run("r2", 60)));
    expect(ids()).toEqual(["r2", "r1"]);
    await loaded({ ...HOME, origin: "chat" }, base());
    applyEnvelope(envelope(run("r3", 70)));
    expect(ids()).toEqual(["b", "c"]);
    await settle();
    expect(urls).toHaveLength(2);
  });

  test.serial(
    "a run in All takes its line when held, else reloads",
    async () => {
      await loaded(HOME, [rowOf(chat("c", 40)), rowOf(run("r1", 30), 3)]);
      applyEnvelope(envelope(run("r2", 60, { status: "running" })));
      expect(ids()).toEqual(["r2", "c"]);
      expect(list.value?.rows[0]?.runs).toBe(4);
      await settle();
      expect(urls).toHaveLength(1);

      applyEnvelope(envelope(run("x1", 70, { automationId: "other" })));
      await settle();
      expect(urls).toHaveLength(2);
      await release([rowOf(run("x1", 70, { automationId: "other" }), 1)]);
    },
  );

  test.serial("under a search, inserts only a title holding it", async () => {
    await loaded({ ...HOME, q: "pods" }, [
      rowOf(chat("b", 50, { title: "pods" })),
    ]);
    applyEnvelope(envelope(chat("n", 60, { title: "Restart PODS" })));
    applyEnvelope(envelope(chat("m", 70, { title: "disk usage" })));
    applyEnvelope(envelope(chat("k", 80, { title: "disk usage" }), false));
    expect(ids()).toEqual(["n", "b"]);
    await settle();
    expect(urls).toHaveLength(1);
  });
});

describe("a first page out", () => {
  test.serial("keeps a row inserted after it was asked", async () => {
    await loaded(HOME, base());
    const again = loadList(HOME);
    await settle();
    applyEnvelope(envelope(chat("n", 60)));
    await release(base());
    await again;
    expect(ids()).toEqual(["n", "b", "c"]);
  });

  test.serial("keeps an insert when nothing was held yet", async () => {
    const first = loadList(HOME);
    await settle();
    applyEnvelope(envelope(chat("n", 60)));
    await release(base());
    await first;
    expect(ids()).toEqual(["n", "b", "c"]);
    expect(urls).toHaveLength(1);
  });

  test.serial("keeps a newer revision over its older copy", async () => {
    await loaded(HOME, base());
    const again = loadList(HOME);
    await settle();
    applyEnvelope(envelope(chat("c", 60, { revision: 3, title: "Newer" })));
    await release([
      rowOf(chat("b", 50)),
      rowOf(chat("c", 40, { revision: 2, title: "Older" })),
    ]);
    await again;
    expect(ids()).toEqual(["c", "b"]);
    expect(list.value?.rows[0]?.session.title).toBe("Newer");
  });

  test.serial("takes its copy when it is as new or newer", async () => {
    await loaded(HOME, base());
    const again = loadList(HOME);
    await settle();
    applyEnvelope(envelope(chat("c", 60, { revision: 2, title: "Said" })));
    await release([
      rowOf(chat("c", 70, { revision: 4, title: "Newest" })),
      rowOf(chat("b", 50)),
    ]);
    await again;
    expect(list.value?.rows[0]?.session.title).toBe("Newest");
  });

  test.serial(
    "never brings back a row deleted after it was asked",
    async () => {
      await loaded(HOME, base());
      const again = loadList(HOME);
      await settle();
      dropRow("b", "p1");
      expect(ids()).toEqual(["c"]);
      await release(base());
      await again;
      expect(ids()).toEqual(["c"]);
      expect(urls).toHaveLength(2);
    },
  );

  test.serial("never brings back a lost project's rows", async () => {
    const rows = [...base(), rowOf(chat("z", 45, { projectId: "p2" }))];
    await loaded(HOME, rows);
    const again = loadList(HOME);
    await settle();
    revokeRows("p2");
    // the rows go at once, before any answer
    expect(ids()).toEqual(["b", "c"]);
    await release(rows);
    await settle();
    // the revocation's own cold load answers
    await release(base());
    await again;
    expect(ids()).toEqual(["b", "c"]);
  });

  test.serial("a filter change drops a warm load out", async () => {
    await loaded(HOME, base());
    // a run with no line asks the warm load
    applyEnvelope(envelope(run("r", 60)));
    await settle();
    expect(urls).toEqual(["/api/sessions", "/api/sessions"]);
    const chats = loadList({ ...HOME, origin: "chat" });
    await settle();
    expect(urls.at(-1)).toBe("/api/sessions?origin=chat");
    // the warm answer lands last in time but is dropped
    const warm = gates.shift()!;
    await release([rowOf(chat("k", 90))]);
    await chats;
    warm(Response.json({ rows: [rowOf(run("r", 60), 1)], next: null }));
    await settle();
    expect(ids()).toEqual(["k"]);
  });

  test.serial("an envelope only the server can place trails it", async () => {
    await loaded(HOME, base());
    jest.useFakeTimers();
    try {
      const again = loadList(HOME);
      await settle();
      applyEnvelope(envelope(run("r", 60)));
      applyEnvelope(envelope(chat("n", 55), false));
      await settle();
      expect(urls).toHaveLength(2);
      await release(base());
      await again;
      expect(urls).toHaveLength(2);
      jest.advanceTimersByTime(TRAIL_MS);
      await settle();
      expect(urls).toHaveLength(3);
      await release([rowOf(run("r", 60), 1), rowOf(chat("n", 55)), ...base()]);
      expect(ids()).toEqual(["r", "n", "b", "c"]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("a burst of asks", () => {
  test.serial("costs one load out and one trailing", async () => {
    await loaded(HOME, base());
    jest.useFakeTimers();
    try {
      let most = 0;
      for (let i = 0; i < 200; i++) {
        applyEnvelope(
          envelope(run(`r${i}`, 100 + i, { automationId: `a${i}` })),
        );
        most = Math.max(most, gates.length);
        await settle();
      }
      expect(urls).toHaveLength(2);
      await release(base());
      for (let i = 0; i < 50; i++) {
        applyEnvelope(
          envelope(run(`q${i}`, 400 + i, { automationId: `b${i}` })),
        );
        most = Math.max(most, gates.length);
      }
      jest.advanceTimersByTime(TRAIL_MS);
      await settle();
      expect(urls).toHaveLength(3);
      await release(base());
      jest.advanceTimersByTime(TRAIL_MS * 4);
      await settle();
      expect(urls).toHaveLength(3);
      expect(most).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("paging after inserts", () => {
  test.serial(
    "inserted rows sit above the cursor and move no page",
    async () => {
      await loaded(HOME, base(), "0.40.c");
      applyEnvelope(envelope(chat("n", 60)));
      // past the cursor: the next page brings it
      applyEnvelope(envelope(chat("old", 5)));
      expect(ids()).toEqual(["n", "b", "c"]);
      expect(list.value?.next).toBe("0.40.c");
      const more = loadMore();
      await settle();
      expect(urls.at(-1)).toBe("/api/sessions?before=0.40.c");
      await release([rowOf(chat("d", 30)), rowOf(chat("old", 5))], null);
      await more;
      expect(ids()).toEqual(["n", "b", "c", "d", "old"]);
      expect(list.value?.next).toBeNull();
    },
  );

  test.serial("a held filter keeps its inserted rows", async () => {
    await loaded(HOME, base(), "0.40.c");
    applyEnvelope(envelope(chat("n", 60)));
    await loaded({ project: "p1", q: "" }, []);
    const back = loadList(HOME);
    // drawn at once from what was held, the insert included
    expect(ids()).toEqual(["n", "b", "c"]);
    expect(list.value?.next).toBe("0.40.c");
    await settle();
    await release([rowOf(chat("n", 60)), ...base()], "0.40.c");
    await back;
  });
});

describe("labels no envelope carries", () => {
  test.serial(
    "an automation frame saying its agent retired marks the rows",
    async () => {
      await loaded(HOME, [
        rowOf(chat("b", 50, { agentId: "a9" })),
        rowOf(chat("c", 40)),
      ]);
      applyAutomationFrame({
        type: "automation",
        projectId: "p1",
        automation: {
          id: "au",
          agentId: "a9",
          agentRetired: true,
          name: "digest",
        } as AutomationSummary,
      });
      expect(list.value?.rows.map((r) => r.agentRetired)).toEqual([
        true,
        false,
      ]);
      // and over a page read before it
      const again = loadList(HOME);
      await settle();
      await release([rowOf(chat("b", 50, { agentId: "a9" }))]);
      await again;
      expect(list.value?.rows[0]?.agentRetired).toBe(true);
    },
  );

  test.serial(
    "an agent's delete retires the runs of its paused automations too",
    async () => {
      const task = (id: string, revision: number, suspendedAt: number | null) =>
        ({
          id,
          projectId: "p1",
          agentId: "a9",
          agentRetired: false,
          name: "digest",
          suspendedAt,
          revision,
        }) as AutomationSummary;
      await loaded(HOME, [
        rowOf(run("r1", 50, { agentId: "a9", automationId: "au" })),
        rowOf(run("r2", 40, { agentId: "a9", automationId: "av" })),
        rowOf(chat("c", 30)),
      ]);
      // the automations page of the project is open too, and keeps only
      // a frame of a newer revision
      const gatedFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        Response.json({
          automations: [task("au", 1, null), task("av", 2, 5)],
          runDeadlineMs: 60_000,
        })) as unknown as typeof fetch;
      await loadAutomations("p1");
      globalThis.fetch = gatedFetch;
      // the delete sends a frame for the one already paused and for the
      // one it suspends; either alone retires the agent on every row,
      // which is all a project holding only paused ones would get
      const frame = (automation: AutomationSummary) =>
        onAutomationsSocket({
          type: "automation",
          projectId: "p1",
          automation: { ...automation, agentRetired: true },
        });
      frame(task("av", 3, 5));
      expect(list.value?.rows.map((r) => r.agentRetired)).toEqual([
        true,
        true,
        false,
      ]);
      frame(task("au", 2, 70));
      expect(automations.value?.map((a) => a.agentRetired)).toEqual([
        true,
        true,
      ]);
    },
  );

  test.serial("a grant loads cold at once, over a trailing ask", async () => {
    await loaded(HOME, base());
    applyEnvelope(envelope(run("r", 60)));
    await settle();
    grantRows("p3");
    await settle();
    expect(urls).toEqual(["/api/sessions", "/api/sessions", "/api/sessions"]);
  });
});

describe("reloads that cannot help are not asked", () => {
  test.serial(
    "a row between the first page and a kept tail does not loop",
    async () => {
      jest.useFakeTimers();
      try {
        await loaded(HOME, base(), "0.40.c");
        const more = loadMore();
        await settle();
        await release([rowOf(chat("d", 30)), rowOf(chat("e", 20))], "0.20.e");
        await more;
        // a run with no line held above the first page's cursor: a reload
        applyEnvelope(envelope(run("r", 45)));
        await settle();
        expect(urls).toHaveLength(3);
        // the server's first page does not hold it by then; the warm
        // load keeps the tail and its cursor
        await release(base(), "0.40.c");
        expect(ids()).toEqual(["b", "c", "d", "e"]);
        expect(list.value?.next).toBe("0.20.e");
        jest.advanceTimersByTime(TRAIL_MS);
        await settle();
        // the run moved past the first page: no first page places it
        for (let i = 2; i < 6; i++) {
          applyEnvelope(envelope(run("r", 35, { revision: i })));
          applyEnvelope(envelope(chat("n", 35, { revision: i }), false));
          jest.advanceTimersByTime(TRAIL_MS);
          await settle();
        }
        expect(urls).toHaveLength(3);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  test.serial(
    "an answer that needs the server asks once it lands",
    async () => {
      jest.useFakeTimers();
      try {
        const first = loadList(HOME);
        await settle();
        // nothing is held, so only the replay over the answer can ask
        applyEnvelope(envelope(run("r", 60)));
        await settle();
        expect(urls).toHaveLength(1);
        await release(base());
        await first;
        jest.advanceTimersByTime(TRAIL_MS);
        await settle();
        expect(urls).toHaveLength(2);
      } finally {
        jest.useRealTimers();
      }
    },
  );
});

describe("a list that goes stops its loads", () => {
  // a warm load out for Feed of p1, and one more asked behind it
  async function trailing() {
    await loaded({ project: "p1", q: "" }, base());
    applyEnvelope(envelope(run("r", 60)));
    applyEnvelope(envelope(run("r2", 70, { automationId: "a2" })));
    await settle();
    expect(urls).toHaveLength(2);
  }

  test.serial("on a revocation of its project", async () => {
    jest.useFakeTimers();
    try {
      await trailing();
      revokeRows("p1");
      expect(list.value).toBeNull();
      await release(base());
      jest.advanceTimersByTime(TRAIL_MS * 4);
      await settle();
      expect(urls).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test.serial("on a change of user", async () => {
    jest.useFakeTimers();
    try {
      await trailing();
      me.value = {
        id: `rec${user}-next`,
        username: "ana",
        fullName: "Ana",
        role: "member",
        mustChangePassword: false,
      };
      await release(base());
      jest.advanceTimersByTime(TRAIL_MS * 4);
      await settle();
      expect(urls).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("a row that says its agent retired", () => {
  test.serial("retires the agent on every row held", async () => {
    await loaded(HOME, [
      rowOf(chat("b", 50, { agentId: "a9" })),
      rowOf(chat("c", 40)),
    ]);
    const ev = envelope(chat("n", 60, { agentId: "a9" }));
    applyEnvelope({ ...ev, row: { ...ev.row!, agentRetired: true } });
    expect(ids()).toEqual(["n", "b", "c"]);
    expect(list.value?.rows.map((r) => r.agentRetired)).toEqual([
      true,
      true,
      false,
    ]);
  });
});
