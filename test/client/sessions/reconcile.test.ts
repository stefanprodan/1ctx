// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  cursorPlace,
  type RowEnvelope,
  reconcile,
  replay,
  type Shown,
  searched,
} from "../../../src/client/data/sessions-rows.ts";
import type {
  EnvelopeRow,
  StreamRow,
} from "../../../src/shared/api/sessions.ts";
import type {
  SendSummary,
  SessionSummary,
} from "../../../src/shared/contracts/session.ts";

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
  summary({ id, lastActivityAt: at, createdAt: at, ...changes });

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

function rowOf(session: SessionSummary, changes: Partial<StreamRow> = {}) {
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
    runs: null,
    ...changes,
  } satisfies StreamRow;
}

const sent = { id: "send9", status: "running" } as SendSummary;

// the envelope for a session, with its row as the server read it
function env(
  session: SessionSummary,
  row: Partial<EnvelopeRow> | null = {},
): RowEnvelope {
  return {
    session,
    send: null,
    row:
      row === null
        ? null
        : {
            agent: "writer",
            agentRetired: false,
            send: sent,
            last: { seq: 3, author: "writer", text: "done" },
            automation:
              session.automationId === null
                ? null
                : { id: session.automationId, name: "digest" },
            runBy: null,
            ...row,
          },
  };
}

const ALL: Shown = { origin: null, q: "" };
const CHATS: Shown = { origin: "chat", q: "" };
const TASKS: Shown = { origin: "automation", q: "" };

const ids = (rows: StreamRow[] | "reload") =>
  rows === "reload" ? rows : rows.map((r) => r.session.id);

const held = () => [rowOf(chat("b", 50)), rowOf(chat("c", 40))];

describe("a row not held", () => {
  test("a chat is inserted in order in All and Chats, with its row", () => {
    for (const shown of [ALL, CHATS]) {
      const out = reconcile(held(), null, shown, env(chat("n", 45)));
      expect(ids(out)).toEqual(["b", "n", "c"]);
      const n = (out as StreamRow[])[1]!;
      expect(n.agent).toBe("writer");
      expect(n.send).toBe(sent);
      expect(n.last?.text).toBe("done");
      expect(n.runs).toBeNull();
    }
  });

  test("a running chat goes first", () => {
    const out = reconcile(
      held(),
      null,
      ALL,
      env(chat("n", 1, { status: "running" })),
    );
    expect(ids(out)).toEqual(["n", "b", "c"]);
  });

  test("a filter of the other origin leaves the rows", () => {
    const rows = held();
    expect(reconcile(rows, null, TASKS, env(chat("n", 45)))).toBe(rows);
    expect(reconcile(rows, null, CHATS, env(run("r", 45)))).toBe(rows);
  });

  test("a run is inserted in Tasks, on its own", () => {
    const out = reconcile(held(), null, TASKS, env(run("r", 60)));
    expect(ids(out)).toEqual(["r", "b", "c"]);
    expect((out as StreamRow[])[0]!.runs).toBeNull();
    expect((out as StreamRow[])[0]!.automation?.name).toBe("digest");
  });

  test("a run in All whose line is not held asks for a reload", () => {
    expect(reconcile(held(), null, ALL, env(run("r", 60)))).toBe("reload");
  });

  test("a run whose automation is gone is listed on its own in All", () => {
    const out = reconcile(
      held(),
      null,
      ALL,
      env(run("r", 60, { automationId: null })),
    );
    expect(ids(out)).toEqual(["r", "b", "c"]);
  });

  test("an envelope without its row asks for a reload", () => {
    expect(reconcile(held(), null, ALL, env(chat("n", 45), null))).toBe(
      "reload",
    );
  });

  test("a row past the cursor is left for the page that holds it", () => {
    const rows = held();
    // the first page ended at c, not running, at 40
    const next = "0.40.c";
    expect(reconcile(rows, next, ALL, env(chat("n", 30)))).toBe(rows);
    expect(reconcile(rows, next, ALL, env(chat("n", 40, { id: "d" })))).toBe(
      rows,
    );
    expect(ids(reconcile(rows, next, ALL, env(chat("n", 45))))).toEqual([
      "b",
      "n",
      "c",
    ]);
    // a running row sits above any cursor of rows not running
    expect(
      ids(reconcile(rows, next, ALL, env(chat("n", 1, { status: "running" })))),
    ).toEqual(["n", "b", "c"]);
  });

  test("past the cursor nothing is asked, whatever the envelope", () => {
    const rows = held();
    const next = "0.40.c";
    expect(reconcile(rows, next, ALL, env(run("r", 30)))).toBe(rows);
    expect(reconcile(rows, next, ALL, env(chat("n", 30), null))).toBe(rows);
    // above it the same envelopes need the server
    expect(reconcile(rows, next, ALL, env(run("r", 45)))).toBe("reload");
    expect(reconcile(rows, next, ALL, env(chat("n", 45), null))).toBe("reload");
  });

  test("a cursor the client cannot read asks for a reload", () => {
    expect(reconcile(held(), "junk", ALL, env(chat("n", 45)))).toBe("reload");
  });
});

describe("a search", () => {
  const pods: Shown = { origin: null, q: "pods" };

  test("a title holding the query is inserted, ASCII in any case", () => {
    const out = reconcile(
      held(),
      null,
      pods,
      env(chat("n", 45, { title: "Restart PODS now" })),
    );
    expect(ids(out)).toEqual(["b", "n", "c"]);
  });

  test("a title without it changes nothing and asks nothing", () => {
    const rows = held();
    expect(
      reconcile(rows, null, pods, env(chat("n", 45, { title: "disk" }))),
    ).toBe(rows);
    expect(
      reconcile(rows, null, pods, env(chat("n", 45, { title: "disk" }), null)),
    ).toBe(rows);
    expect(
      reconcile(rows, null, pods, env(run("r", 45, { title: "disk" }))),
    ).toBe(rows);
  });

  test("folds as SQLite's LIKE does, and trims as the route does", () => {
    // LIKE folds ASCII letters only
    expect(searched("AΣ", "σ")).toBe(false);
    expect(searched("AΣ", "aΣ")).toBe(true);
    // the route escapes % and _, so they match themselves
    expect(searched("100% done", "%")).toBe(true);
    expect(searched("a_b", "_")).toBe(true);
    expect(searched("ab", "_")).toBe(false);
    expect(searched("pods", "  pods ")).toBe(true);
  });
});

describe("a row held", () => {
  test("a newer revision takes the envelope's row and keeps runs", () => {
    const rows = [rowOf(chat("b", 50), { runs: null }), rowOf(chat("c", 40))];
    const out = reconcile(
      rows,
      null,
      ALL,
      env(chat("c", 60, { revision: 2 }), { agentRetired: true }),
    );
    expect(ids(out)).toEqual(["c", "b"]);
    const c = (out as StreamRow[])[0]!;
    expect(c.agentRetired).toBe(true);
    expect(c.send).toBe(sent);
  });

  test("an older or equal revision leaves the rows as they are", () => {
    const rows = [rowOf(chat("b", 50, { revision: 3 }))];
    expect(
      reconcile(rows, null, ALL, env(chat("b", 60, { revision: 3 }))),
    ).toBe(rows);
    expect(
      reconcile(rows, null, ALL, env(chat("b", 60, { revision: 2 }))),
    ).toBe(rows);
  });

  test("without its row the envelope's send and last move it in place", () => {
    const last = { seq: 1, author: "ana", text: "before" };
    const rows = [rowOf(chat("b", 50), { last })];
    const out = reconcile(rows, null, ALL, {
      ...env(chat("b", 60, { revision: 2, title: "Renamed" }), null),
      send: sent,
    });
    const b = (out as StreamRow[])[0]!;
    expect(b.session.title).toBe("Renamed");
    expect(b.send).toBe(sent);
    expect(b.last).toBe(last);
    expect(b.agent).toBe("assistant");
  });

  test("a held row past the cursor still moves", () => {
    const rows = held();
    const out = reconcile(
      rows,
      "0.40.c",
      ALL,
      env(chat("c", 70, { revision: 2 })),
    );
    expect(ids(out)).toEqual(["c", "b"]);
  });
});

describe("a run in All with its line held", () => {
  const line = () => rowOf(run("r1", 5), { runs: 3 });

  test("a newer run takes the line with its row and counts one more", () => {
    const out = reconcile(
      [rowOf(chat("c", 40)), line()],
      null,
      ALL,
      env(run("r2", 90, { status: "running", agentId: "a2" }), {
        agent: "sre",
        runBy: { id: "u2", username: "ana" },
      }),
    );
    expect(ids(out)).toEqual(["r2", "c"]);
    const r2 = (out as StreamRow[])[0]!;
    expect(r2.runs).toBe(4);
    expect(r2.agent).toBe("sre");
    expect(r2.runBy?.username).toBe("ana");
  });

  test("the line's own run moves in place with its row", () => {
    const out = reconcile(
      [line()],
      null,
      ALL,
      env(run("r1", 9, { revision: 2 }), { last: null }),
    );
    const r1 = (out as StreamRow[])[0]!;
    expect(r1.runs).toBe(3);
    expect(r1.session.revision).toBe(2);
    expect(r1.last).toBeNull();
  });

  test("an older run changes nothing and asks nothing", () => {
    const rows = [line()];
    expect(reconcile(rows, null, ALL, env(run("r0", 1)))).toBe(rows);
  });

  test("under a search a run that misses it leaves the line", () => {
    const rows = [line()];
    expect(
      reconcile(
        rows,
        null,
        { origin: null, q: "digest" },
        env(run("r2", 90, { title: "renamed" })),
      ),
    ).toBe(rows);
  });
});

describe("the place a cursor names", () => {
  test("reads the server's feed cursor", () => {
    expect(cursorPlace("1.1700.abc")).toEqual({
      status: "running",
      lastActivityAt: 1700,
      id: "abc",
    });
    expect(cursorPlace("0.0.x")?.status).toBe("done");
  });

  test("anything else is no place", () => {
    for (const bad of [
      "",
      "2.1.a",
      "0.a.b",
      "0.1",
      "0.1.a.b",
      "0.-1.a",
      "0.1.",
    ])
      expect(cursorPlace(bad)).toBeNull();
  });
});

describe("a replay over an answer", () => {
  test("inserts, moves and drops as the envelopes did, in order", () => {
    const answer = [rowOf(chat("b", 50)), rowOf(chat("c", 40))];
    const out = replay(answer, null, ALL, [
      { ev: env(chat("n", 45)) },
      { ev: env(chat("c", 60, { revision: 2 })) },
      { drop: (row) => row.session.id === "b" },
      { ev: env(chat("n", 70, { revision: 2 })) },
    ]);
    expect(out.reload).toBe(false);
    expect(ids(out.rows)).toEqual(["n", "c"]);
    expect(out.rows[0]!.session.revision).toBe(2);
  });

  test("an envelope older than the answer's copy changes nothing", () => {
    const answer = [rowOf(chat("b", 50, { revision: 4, title: "Newest" }))];
    const out = replay(answer, null, ALL, [
      { ev: env(chat("b", 60, { revision: 3, title: "Older" })) },
    ]);
    expect(out.rows).toBe(answer);
  });

  test("says when only a reload can answer", () => {
    const out = replay([], null, ALL, [
      { ev: env(run("r", 60)) },
      { ev: env(chat("n", 45)) },
    ]);
    expect(out.reload).toBe(true);
    expect(ids(out.rows)).toEqual(["n"]);
  });
});
