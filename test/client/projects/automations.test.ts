// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import {
  automations,
  loadAutomations,
  loadRuns,
  onAutomationsSocket,
  runs,
  upsertAutomation,
  upsertRun,
} from "../../../src/client/data/automations.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  canChange,
  type Draft,
  dirtyOf,
  draftOf,
  eventNote,
  lastLine,
  metaLine,
  requestOf,
  scheduleLine,
  scheduleWords,
} from "../../../src/client/views/projects/Automations.model.ts";
import type { StreamRow } from "../../../src/shared/api/sessions.ts";
import type { AutomationSummary } from "../../../src/shared/contracts/automation.ts";
import type { SessionSummary } from "../../../src/shared/contracts/session.ts";

const now = new Date(2026, 8, 14, 12).getTime();
const HOUR = 3_600_000;

const automation = (
  changes: Partial<AutomationSummary> = {},
): AutomationSummary => ({
  id: "au1",
  projectId: "p1",
  ownerId: "u1",
  agentId: "a1",
  name: "nightly",
  instructions: "Check the clusters",
  schedule: "0 9 * * MON-FRI",
  tz: "Europe/Bucharest",
  deadlineMs: null,
  retentionDays: 30,
  suspendedAt: null,
  nextAt: now + 4 * HOUR,
  lastEventAt: null,
  lastEventDueAt: null,
  lastEventSource: null,
  lastEventOutcome: null,
  lastEventReason: null,
  lastRunSessionId: null,
  lastRunStatus: null,
  revision: 1,
  createdAt: now - 24 * HOUR,
  updatedAt: now - 24 * HOUR,
  ...changes,
});

const session = (changes: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "s1",
  projectId: "p1",
  ownerId: "u1",
  agentId: "a1",
  origin: "automation",
  automationId: "au1",
  title: "nightly",
  status: "running",
  revision: 1,
  createdAt: now,
  lastActivityAt: now,
  usage: null,
  ...changes,
});

const run = (changes: Partial<SessionSummary> = {}): StreamRow => ({
  session: session(changes),
  send: null,
  last: null,
  automation: { id: "au1", name: "nightly" },
});

describe("scheduleWords", () => {
  test("reads the shapes people write most", () => {
    expect(scheduleWords("0 9 * * MON-FRI")).toBe("every weekday at 09:00");
    expect(scheduleWords("0 9 * * 1-5")).toBe("every weekday at 09:00");
    expect(scheduleWords("30 7 * * *")).toBe("every day at 07:30");
    expect(scheduleWords("0 18 * * FRI")).toBe("every Friday at 18:00");
    expect(scheduleWords("0 18 * * 0")).toBe("every Sunday at 18:00");
    expect(scheduleWords("0 18 * * 7")).toBe("every Sunday at 18:00");
    expect(scheduleWords("0 10 * * SAT,SUN")).toBe(
      "every weekend day at 10:00",
    );
    expect(scheduleWords("*/15 * * * *")).toBe("every 15 minutes");
    expect(scheduleWords("0 * * * *")).toBe("every hour");
    expect(scheduleWords("5 * * * *")).toBe("every hour at :05");
    expect(scheduleWords("0 6 1 * *")).toBe(
      "on the 1st of each month at 06:00",
    );
    expect(scheduleWords("0 6 22 * *")).toBe(
      "on the 22nd of each month at 06:00",
    );
    expect(scheduleWords("0 6 12 * *")).toBe(
      "on the 12th of each month at 06:00",
    );
  });

  test("reads the nicknames through their fields", () => {
    expect(scheduleWords("@daily")).toBe("every day at 00:00");
    expect(scheduleWords("@hourly")).toBe("every hour");
    expect(scheduleWords("@weekly")).toBe("every Sunday at 00:00");
  });

  test("gives up on a shape it does not know", () => {
    expect(scheduleWords("0 9 * 1 *")).toBeNull();
    expect(scheduleWords("0 9,17 * * *")).toBeNull();
    expect(scheduleWords("0 9 1 * MON")).toBeNull();
    expect(scheduleWords("0 25 * * *")).toBeNull();
    expect(scheduleWords("not cron")).toBeNull();
    expect(scheduleWords("")).toBeNull();
  });

  test("the row's line falls back to the expression, then the zone", () => {
    expect(scheduleLine("0 9,17 * * *", "UTC")).toBe("0 9,17 * * * UTC");
    expect(scheduleLine("@daily", "UTC")).toBe("every day at 00:00 UTC");
  });
});

describe("the row's words", () => {
  test("next fire, then the last run", () => {
    expect(metaLine(automation(), now)).toBe(
      "every weekday at 09:00 Europe/Bucharest · next in 4h",
    );
    const done = automation({
      lastEventAt: now - 2 * 24 * HOUR,
      lastEventOutcome: "run",
      lastRunStatus: "done",
    });
    expect(metaLine(done, now)).toBe(
      "every weekday at 09:00 Europe/Bucharest · next in 4h · last run done 2d ago",
    );
  });

  test("a suspended row says so and has no next fire", () => {
    const off = automation({ suspendedAt: now - HOUR, nextAt: null });
    expect(metaLine(off, now)).toBe(
      "every weekday at 09:00 Europe/Bucharest · suspended",
    );
  });

  test("a run in flight wins over a later skip", () => {
    const busy = automation({
      lastEventAt: now - 60_000,
      lastEventOutcome: "skipped",
      lastEventReason: "still running",
      lastRunStatus: "running",
    });
    expect(lastLine(busy, now)).toBe("running");
    const skipped = automation({
      ...busy,
      lastRunStatus: "done",
    });
    expect(lastLine(skipped, now)).toBe("skipped 1m ago");
    expect(eventNote(skipped, now)).toBe("Skipped 1m ago: still running");
  });

  test("a scheduled fire a minute or more late says how late", () => {
    const late = automation({
      lastEventAt: now - HOUR,
      lastEventDueAt: now - 9 * HOUR,
      lastEventSource: "schedule",
      lastEventOutcome: "run",
      lastRunStatus: "done",
    });
    expect(eventNote(late, now)).toBe("The last run started 8h late");
    expect(
      eventNote({ ...late, lastEventDueAt: late.lastEventAt! - 5000 }, now),
    ).toBeNull();
    expect(eventNote({ ...late, lastEventSource: "manual" }, now)).toBeNull();
  });

  test("the owner changes a row, and an admin only in a team project", () => {
    const row = automation();
    expect(canChange(row, { id: "u1", role: "member" }, "team")).toBe(true);
    expect(canChange(row, { id: "u2", role: "member" }, "team")).toBe(false);
    expect(canChange(row, { id: "u2", role: "admin" }, "team")).toBe(true);
    expect(canChange(row, { id: "u2", role: "admin" }, "personal")).toBe(false);
    expect(canChange(row, null, "team")).toBe(false);
  });
});

describe("the form", () => {
  const filled = (changes: Partial<Draft> = {}): Draft => ({
    ...draftOf(null, "a1", "UTC"),
    name: "nightly",
    instructions: "Check the clusters",
    ...changes,
  });

  test("a new draft starts on weekdays at nine in the given zone", () => {
    expect(draftOf(null, "a1", "Europe/Bucharest")).toEqual({
      name: "",
      agentId: "a1",
      instructions: "",
      schedule: "0 9 * * MON-FRI",
      tz: "Europe/Bucharest",
      deadline: "",
      retention: "30",
    });
  });

  test("the body trims, turns minutes into ms and leaves the rest to the server", () => {
    expect(
      requestOf(filled({ deadline: " 5 ", schedule: " * * * * * " })),
    ).toEqual({
      body: {
        name: "nightly",
        agentId: "a1",
        instructions: "Check the clusters",
        schedule: "* * * * *",
        tz: "UTC",
        deadlineMs: 300_000,
        retentionDays: 30,
      },
    });
    const empty = requestOf(filled({ deadline: "" }));
    expect("body" in empty && empty.body.deadlineMs).toBeNull();
  });

  test("only emptiness and the numbers' shape are refused here", () => {
    expect(requestOf(filled({ name: " " }))).toEqual({
      problem: "Name is empty",
    });
    expect(requestOf(filled({ agentId: "" }))).toEqual({
      problem: "Pick an agent",
    });
    expect(requestOf(filled({ schedule: "" }))).toEqual({
      problem: "Schedule is empty",
    });
    expect(requestOf(filled({ deadline: "1.5" }))).toEqual({
      problem: "Deadline needs whole minutes",
    });
    expect(requestOf(filled({ retention: "" }))).toEqual({
      problem: "Keep runs needs whole days",
    });
    // out of range is the server's word
    expect("body" in requestOf(filled({ retention: "9999" }))).toBe(true);
  });

  test("a draft is dirty when a field moved off the row", () => {
    const row = automation({ deadlineMs: 120_000 });
    const same = draftOf(row, "ignored", "ignored");
    expect(same.deadline).toBe("2");
    expect(dirtyOf(same, row)).toBe(false);
    expect(dirtyOf({ ...same, schedule: "0 10 * * *" }, row)).toBe(true);
    expect(dirtyOf(same, null)).toBe(true);
  });
});

describe("the revision rule", () => {
  test("a row replaces the held one only above its revision", () => {
    const held = [automation({ revision: 3, name: "b" })];
    expect(upsertAutomation(held, automation({ revision: 3 }))).toBe(held);
    expect(upsertAutomation(held, automation({ revision: 2 }))).toBe(held);
    const next = upsertAutomation(
      held,
      automation({ revision: 4, name: "b2" }),
    );
    expect(next.map((a) => a.name)).toEqual(["b2"]);
    const two = upsertAutomation(next, automation({ id: "au0", name: "a" }));
    expect(two.map((a) => a.name)).toEqual(["a", "b2"]);
  });

  test("runs keep the newest first and the higher revision", () => {
    const older = run({ id: "s0", createdAt: now - HOUR });
    const rows = upsertRun([older], run({ id: "s1", revision: 2 }));
    expect(rows.map((r) => r.session.id)).toEqual(["s1", "s0"]);
    expect(upsertRun(rows, run({ id: "s1", revision: 1 }))).toBe(rows);
  });
});

describe("the entity over the socket", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    me.value = null;
  });

  test.serial("frames of the project on screen move its rows", async () => {
    me.value = {
      id: "u1",
      username: "oana",
      fullName: "Oana",
      role: "member",
      mustChangePassword: false,
    };
    globalThis.fetch = (async () =>
      Response.json({
        automations: [automation()],
      })) as unknown as typeof fetch;
    await loadAutomations("p1");
    expect(automations.value?.map((a) => a.revision)).toEqual([1]);

    onAutomationsSocket({
      type: "automation",
      projectId: "p1",
      automation: automation({ revision: 2, lastRunStatus: "running" }),
    });
    expect(automations.value?.[0]?.lastRunStatus).toBe("running");

    let release: (response: Response) => void = () => {};
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as unknown as typeof fetch;
    const stale = loadAutomations("p1");
    onAutomationsSocket({
      type: "automation",
      projectId: "p1",
      automation: automation({ id: "au2", name: "added", revision: 1 }),
    });
    release(Response.json({ automations: [automation()] }));
    await stale;
    expect(automations.value?.map((a) => a.id)).toEqual(["au2", "au1"]);

    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as unknown as typeof fetch;
    const staleDelete = loadAutomations("p1");
    onAutomationsSocket({
      type: "automationDeleted",
      projectId: "p1",
      automationId: "au2",
    });
    release(
      Response.json({
        automations: [
          automation(),
          automation({ id: "au2", name: "added", revision: 1 }),
        ],
      }),
    );
    await staleDelete;
    expect(automations.value?.map((a) => a.id)).toEqual(["au1"]);

    // another project's frame is not this list's
    onAutomationsSocket({
      type: "automation",
      projectId: "p2",
      automation: automation({ id: "au9", projectId: "p2", revision: 1 }),
    });
    expect(automations.value?.length).toBe(1);

    // a run's envelope joins the open row's runs
    runs.value = { id: "au1", rows: [] };
    onAutomationsSocket({
      type: "session",
      projectId: "p1",
      session: session({ revision: 1 }),
      messages: [],
      send: null,
    });
    expect(runs.value?.rows?.map((r) => r.session.id)).toEqual(["s1"]);
    // a chat's envelope does not
    onAutomationsSocket({
      type: "session",
      projectId: "p1",
      session: session({ id: "c1", origin: "chat", automationId: null }),
      messages: [],
      send: null,
    });
    expect(runs.value?.rows?.length).toBe(1);

    // a rename relabels the open row's runs
    const renamed = automations.value?.[0]?.revision ?? 0;
    onAutomationsSocket({
      type: "automation",
      projectId: "p1",
      automation: automation({ revision: renamed + 1, name: "digest" }),
    });
    expect(runs.value?.rows?.[0]?.automation?.name).toBe("digest");

    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as unknown as typeof fetch;
    const staleRuns = loadRuns("au1");
    onAutomationsSocket({
      type: "session",
      projectId: "p1",
      session: session({ revision: 2, title: "newer run" }),
      messages: [],
      send: null,
    });
    release(Response.json({ rows: [] }));
    await staleRuns;
    expect(runs.value?.rows?.[0]?.session.title).toBe("newer run");

    onAutomationsSocket({
      type: "automationDeleted",
      projectId: "p1",
      automationId: "au1",
    });
    expect(automations.value).toEqual([]);
    expect(runs.value).toBeNull();

    onAutomationsSocket({ type: "revoked", projectId: "p1" });
    expect(automations.value).toBeNull();
  });
});
