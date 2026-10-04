// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Flagged pick's pure rules: newest alert first, the
// envelope placing, moving and dropping a line from its automation's
// alert, a frame dropping one on a dismiss, and only what the server
// alone can place asking for the first page.

import { describe, expect, test } from "bun:test";
import {
  alertFrame,
  alertOrder,
  alertPlace,
  byAlert,
  mergeAlertPage,
  reconcileAlert,
  refreshAlertHead,
  replayAlerts,
} from "../../../src/client/data/alert-rows.ts";
import type { RowEnvelope } from "../../../src/client/data/sessions-rows.ts";
import type { FeedRow } from "../../../src/shared/api/sessions.ts";
import type { SessionSummary } from "../../../src/shared/contracts/session.ts";

function summary(changes: Partial<SessionSummary> = {}): SessionSummary {
  return {
    archived: null,
    attention: 1,
    attentionReason: null,
    attentionSource: "runner",
    attentionBy: null,
    id: "s1",
    projectId: "p1",
    ownerId: "u1",
    agentId: "a1",
    origin: "automation",
    automationId: "au",
    runSource: null,
    forkedFromId: null,
    title: "digest",
    status: "done",
    revision: 1,
    createdAt: 0,
    lastActivityAt: 0,
    usage: null,
    disabledCapabilities: [],
    ...changes,
  };
}

// automation au's line: its run id at a time, its alert open since a
// time or closed
const line = (
  au: string,
  id: string,
  at: number,
  since: number | null,
  changes: Partial<SessionSummary> = {},
): FeedRow => ({
  agentRetired: false,
  session: summary({
    id,
    automationId: au,
    title: au,
    createdAt: at,
    lastActivityAt: at,
    ...changes,
  }),
  agent: "sre",
  send: null,
  sendAgent: null,
  last: null,
  automation: {
    id: au,
    name: au,
    alert:
      since === null
        ? null
        : { since, runs: 1, reason: "pods down", by: "sre" },
  },
  runBy: null,
  runs: 3,
});

const envelope = (next: FeedRow, row = true): RowEnvelope => {
  const { session, runs: _, ...rest } = next;
  return { session, send: null, row: row ? rest : null };
};

const ids = (rows: FeedRow[]) => rows.map((r) => r.session.id);

describe("the pick's order", () => {
  test("newest alert first, then the automation's id", () => {
    const rows = [
      line("bb", "b1", 90, 10),
      line("aa", "a1", 10, 30),
      line("cc", "c1", 20, 10),
    ];
    expect(ids(byAlert(rows))).toEqual(["a1", "b1", "c1"]);
    expect(alertOrder(rows[0]!, rows[0]!)).toBe(0);
  });

  test("the cursor names an alert's place", () => {
    expect(alertPlace("30.au")).toEqual({ since: 30, id: "au" });
    expect(alertPlace("1.30.au")).toBeNull();
    expect(alertPlace("x.au")).toBeNull();
    expect(alertPlace("30.")).toBeNull();
  });

  test("a later page keeps one line per automation, the newer run's", () => {
    const held = [line("aa", "a2", 50, 30), line("bb", "b1", 20, 20)];
    const answer = [line("aa", "a1", 40, 30), line("cc", "c1", 10, 10)];
    expect(ids(mergeAlertPage(held, answer))).toEqual(["a2", "b1", "c1"]);
  });

  test("a warm first page is the head and keeps the tail past it", () => {
    const held = [
      line("aa", "a1", 50, 50, { revision: 3 }),
      line("bb", "b1", 40, 40),
      line("cc", "c1", 30, 30),
      line("dd", "d1", 20, 20),
    ];
    // bb's run is gone and another run stands for it; aa's held copy is
    // newer than the answer's
    const answer = {
      rows: [line("aa", "a1", 50, 50), line("bb", "b0", 35, 40)],
      next: "40.bb",
    };
    const out = refreshAlertHead(held, answer, "20.dd");
    expect(ids(out.rows)).toEqual(["a1", "b0", "c1", "d1"]);
    expect(out.rows[0]?.session.revision).toBe(3);
    expect(out.next).toBe("20.dd");
    // the whole list in the answer: no tail, its cursor
    const whole = refreshAlertHead(
      held,
      { rows: answer.rows, next: null },
      "20.dd",
    );
    expect(ids(whole.rows)).toEqual(["a1", "b0"]);
    expect(whole.next).toBeNull();
  });
});

describe("an envelope over the pick", () => {
  const held = () => [line("bb", "b1", 40, 40), line("aa", "a1", 30, 20)];

  test("an alert that opens is placed by its since", () => {
    const out = reconcileAlert(
      held(),
      null,
      "",
      envelope(line("cc", "c1", 50, 30)),
    );
    expect(out).toEqual({ rows: expect.anything(), reload: false });
    expect(ids(out.rows)).toEqual(["b1", "c1", "a1"]);
    expect(out.rows[1]!.runs).toBeNull();
  });

  test("an alert that closes drops the line", () => {
    const out = reconcileAlert(
      held(),
      null,
      "",
      envelope(line("aa", "a2", 60, null)),
    );
    expect(ids(out.rows)).toEqual(["b1"]);
    expect(out.reload).toBeFalse();
  });

  test("a newer run takes the line and counts one more, an older one moves only the alert", () => {
    const newer = reconcileAlert(
      held(),
      null,
      "",
      envelope(line("aa", "a2", 60, 20)),
    );
    expect(ids(newer.rows)).toEqual(["b1", "a2"]);
    expect(newer.rows[1]!.runs).toBe(4);
    const older = line("aa", "a0", 5, 20);
    older.automation!.alert = { since: 20, runs: 2, reason: "late", by: null };
    const out = reconcileAlert(held(), null, "", envelope(older));
    expect(ids(out.rows)).toEqual(["b1", "a1"]);
    expect(out.rows[1]!.automation!.alert?.reason).toBe("late");
  });

  test("a held run at a revision not newer changes nothing", () => {
    const rows = held();
    expect(
      reconcileAlert(rows, null, "", envelope(line("aa", "a1", 30, 20))).rows,
    ).toBe(rows);
  });

  test("past the cursor a later page brings it", () => {
    const rows = held();
    const out = reconcileAlert(
      rows,
      "20.aa",
      "",
      envelope(line("cc", "c1", 50, 10)),
    );
    expect(out.rows).toBe(rows);
    expect(out.reload).toBeFalse();
  });

  test("a run off the search, or a row the server could not read, asks the server", () => {
    expect(
      reconcileAlert(held(), null, "zz", envelope(line("cc", "c1", 50, 30)))
        .reload,
    ).toBeTrue();
    expect(
      reconcileAlert(
        held(),
        null,
        "",
        envelope(line("aa", "a2", 60, 20), false),
      ).reload,
    ).toBeTrue();
    expect(
      reconcileAlert(
        held(),
        null,
        "",
        envelope(line("cc", "c1", 60, 20), false),
      ).reload,
    ).toBeFalse();
  });

  test("a chat changes nothing", () => {
    const rows = held();
    const chat = line("aa", "x", 99, 99, {
      origin: "chat",
      automationId: null,
    });
    expect(reconcileAlert(rows, null, "", envelope(chat)).rows).toBe(rows);
  });

  test("the changes replay over an answer read before them", () => {
    const out = replayAlerts(held(), null, "", [
      { ev: envelope(line("cc", "c1", 50, 50)) },
      { drop: (row) => row.automation?.id === "bb" },
    ]);
    expect(ids(out.rows)).toEqual(["c1", "a1"]);
    expect(out.reload).toBeFalse();
  });
});

describe("an automation frame over the pick", () => {
  test("a closed alert drops its line, a moved one moves it", () => {
    const rows = [line("bb", "b1", 40, 40), line("aa", "a1", 30, 20)];
    expect(
      ids(alertFrame(rows, { id: "bb", name: "bb", alert: null })),
    ).toEqual(["a1"]);
    const moved = alertFrame(rows, {
      id: "aa",
      name: "aa",
      alert: { since: 20, runs: 5, reason: "worse", by: null },
    });
    expect(moved[1]!.automation!.alert?.runs).toBe(5);
    expect(alertFrame(rows, { id: "zz", name: "zz", alert: null })).toBe(rows);
  });
});
