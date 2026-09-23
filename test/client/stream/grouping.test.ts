// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  mergeNextPage,
  oneLine,
  refreshHead,
  swapRun,
} from "../../../src/client/data/sessions-rows.ts";
import type { StreamRow } from "../../../src/shared/api/sessions.ts";
import type { SessionSummary } from "../../../src/shared/contracts/session.ts";

function summary(changes: Partial<SessionSummary> = {}): SessionSummary {
  return {
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
    createdAt: 0,
    lastActivityAt: 0,
    usage: null,
    disabledCapabilities: [],
    ...changes,
  };
}

const chat = (id: string, at: number): StreamRow => ({
  session: summary({ id, lastActivityAt: at }),
  agent: "assistant",
  send: null,
  last: null,
  automation: null,
  runBy: null,
  runs: null,
});

// the line of automation au: its run id at a time, counting runs
const line = (
  id: string,
  at: number,
  runs: number,
  changes: Partial<SessionSummary> = {},
): StreamRow => ({
  session: summary({
    id,
    origin: "automation",
    automationId: "au",
    title: "digest",
    createdAt: at,
    lastActivityAt: at,
    ...changes,
  }),
  agent: "sre",
  send: null,
  last: { seq: 2, author: "sre", text: "all good" },
  automation: { id: "au", name: "digest" },
  runBy: null,
  runs,
});

const ids = (rows: StreamRow[]) => rows.map((r) => r.session.id);

describe("swapRun", () => {
  const held = () => [chat("c1", 50), line("r1", 40, 7), chat("c2", 30)];

  test("puts a new run in its line's place, counting it", () => {
    const next = line("r2", 60, 0, { status: "running" }).session;
    const rows = swapRun(held(), { session: next, send: null });
    expect(ids(rows!)).toEqual(["r2", "c1", "c2"]);
    expect(rows![0]!.runs).toBe(8);
    expect(rows![0]!.last).toBeNull();
    expect(rows![0]!.automation).toEqual({ id: "au", name: "digest" });
    expect(rows![0]!.agent).toBe("sre");
  });

  test("moves the line's own run in place, keeping its count", () => {
    const next = line("r1", 70, 0, { revision: 2 }).session;
    const rows = swapRun(held(), { session: next, send: null });
    expect(ids(rows!)).toEqual(["r1", "c1", "c2"]);
    expect(rows![0]!.runs).toBe(7);
    expect(rows![0]!.last?.text).toBe("all good");
  });

  test("names no agent for a run on another agent", () => {
    const next = line("r2", 60, 0, { agentId: "a2" }).session;
    const rows = swapRun(held(), { session: next, send: null });
    expect(rows![0]!.agent).toBeNull();
  });

  test("changes nothing for an older run or an older revision", () => {
    const older = line("r0", 10, 0).session;
    expect(swapRun(held(), { session: older, send: null })).toBeNull();
    const stale = line("r1", 40, 0, { revision: 1 }).session;
    expect(swapRun(held(), { session: stale, send: null })).toBeNull();
  });

  test("answers undefined when no line of the automation is held", () => {
    const other = line("x1", 90, 0, { automationId: "other" }).session;
    expect(swapRun(held(), { session: other, send: null })).toBeUndefined();
    // a run row outside All is no line
    const tasks = [{ ...line("r1", 40, 0), runs: null }];
    const next = line("r2", 60, 0).session;
    expect(swapRun(tasks, { session: next, send: null })).toBeUndefined();
  });
});

describe("one line per automation", () => {
  test("keeps the newer run with the higher count", () => {
    const rows = oneLine([
      line("r2", 60, 8),
      chat("c1", 50),
      line("r1", 40, 9),
    ]);
    expect(ids(rows)).toEqual(["r2", "c1"]);
    expect(rows[0]!.runs).toBe(9);
  });

  test("a later page never repeats a held line", () => {
    const held = [line("r2", 60, 8), chat("c1", 50)];
    const merged = mergeNextPage(held, [chat("c2", 20), line("r1", 10, 7)]);
    expect(ids(merged)).toEqual(["r2", "c1", "c2"]);
  });

  test("a first page drops a held line its head has a newer run of", () => {
    const held = [chat("c1", 50), chat("c2", 40), line("r1", 10, 7)];
    const answer = {
      rows: [line("r2", 60, 8), chat("c1", 50)],
      next: "after-c1",
    };
    const got = refreshHead(held, answer, "after-r1");
    expect(ids(got.rows)).toEqual(["r2", "c1", "c2"]);
    expect(got.rows[0]!.runs).toBe(8);
  });
});
