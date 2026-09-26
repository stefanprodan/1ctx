// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import {
  automationCount,
  automations,
  loadAutomationPage,
  loadAutomations,
  matchesFilter,
  onAutomationsSocket,
  runDeadlineMs,
  upsertAutomation,
  upsertRun,
} from "../../../src/client/data/automations.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  closeRuns,
  loadMoreRuns,
  loadRuns,
  relabelRuns,
  runs,
} from "../../../src/client/data/runs.ts";
import { IDLE } from "../../../src/client/data/stream.ts";
import { placeOf } from "../../../src/client/lib/places.ts";
import { filterOptions } from "../../../src/client/ui/Select.model.ts";
import { zoneOptions } from "../../../src/client/ui/Zone.model.ts";
import { accessOf } from "../../../src/client/views/projects/Access.model.ts";
import {
  automationFieldOf,
  automationPageOf,
  canChange,
  type Draft,
  deadlineShare,
  deadlineText,
  dirtyOf,
  draftOf,
  durationOf,
  durationText,
  eventNote,
  followDeadlineLimit,
  nextLine,
  nextRunWords,
  OWN_MEMORY_GUIDANCE,
  pickMemory,
  requestOf,
  rowState,
  scheduleTitle,
  scheduleWords,
  sourceText,
  suspendedText,
  waitingSince,
} from "../../../src/client/views/projects/Automations.model.ts";
import type { StreamRow } from "../../../src/shared/api/sessions.ts";
import type { AutomationSummary } from "../../../src/shared/contracts/automation.ts";
import type { SessionSummary } from "../../../src/shared/contracts/session.ts";
import type { RunFilter } from "../../../src/shared/words.ts";

const now = new Date(2026, 8, 14, 12).getTime();
const HOUR = 3_600_000;

const automation = (
  changes: Partial<AutomationSummary> = {},
): AutomationSummary => ({
  id: "au1",
  projectId: "p1",
  ownerId: "u1",
  ownerName: "casey",
  agentId: "a1",
  name: "nightly",
  instructions: "Check the clusters",
  schedule: "0 9 * * MON-FRI",
  tz: "Europe/Bucharest",
  deadlineMs: null,
  retentionDays: 30,
  ownMemory: false,
  memoryGuidance: "",
  suspendedAt: null,
  suspendedBy: null,
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
  disabledCapabilities: [],
  ...changes,
});

const session = (changes: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "s1",
  projectId: "p1",
  ownerId: "u1",
  agentId: "a1",
  origin: "automation",
  automationId: "au1",
  runSource: "schedule",
  forkedFromId: null,
  title: "nightly",
  status: "running",
  revision: 1,
  createdAt: now,
  lastActivityAt: now,
  usage: null,
  disabledCapabilities: [],
  ...changes,
});

const run = (changes: Partial<SessionSummary> = {}): StreamRow => ({
  session: session(changes),
  agent: "assistant",
  send: null,
  last: null,
  automation: { id: "au1", name: "nightly" },
  runBy: null,
  runs: null,
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

  test("names the days of a list or a range", () => {
    expect(scheduleWords("0 9 * * 1,3,5")).toBe(
      "every Monday, Wednesday and Friday at 09:00",
    );
    expect(scheduleWords("0 9 * * TUE,THU")).toBe(
      "every Tuesday and Thursday at 09:00",
    );
    expect(scheduleWords("0 9 * * 5-7")).toBe(
      "every Friday, Saturday and Sunday at 09:00",
    );
    expect(scheduleWords("0 9 * * 0-6")).toBe("every day at 09:00");
  });

  test("gives up on a shape it does not know", () => {
    expect(scheduleWords("0 9 * 1 *")).toBeNull();
    expect(scheduleWords("0 9,17 * * *")).toBeNull();
    expect(scheduleWords("0 9 * * */2")).toBeNull();
    expect(scheduleWords("0 9 1 * MON")).toBeNull();
    expect(scheduleWords("0 25 * * *")).toBeNull();
    expect(scheduleWords("not cron")).toBeNull();
    expect(scheduleWords("")).toBeNull();
  });

  test("a title starts with a capital, or is the expression", () => {
    expect(scheduleTitle("0 9,17 * * *")).toBe("0 9,17 * * *");
    expect(scheduleTitle("@daily")).toBe("Every day at 00:00");
  });
});

describe("the row's words", () => {
  test("the next fire, after a failed last run", () => {
    expect(rowState(automation(), now)).toEqual({
      bad: null,
      text: "next in 4h",
    });
    const failed = automation({
      lastEventAt: now - 2 * HOUR,
      lastEventOutcome: "run",
      lastRunStatus: "failed",
    });
    expect(rowState(failed, now)).toEqual({
      bad: "failed 2h ago",
      text: "next in 4h",
    });
    const done = automation({ ...failed, lastRunStatus: "done" });
    expect(rowState(done, now).text).toBe("next in 4h");
  });

  test("a next run past the page's clock is a wait, said first", () => {
    const clock = Date.UTC(2026, 8, 14, 11, 20);
    const nine = Date.UTC(2026, 8, 14, 9);
    const waiting = automation({
      tz: "UTC",
      nextAt: nine,
      lastEventAt: clock - 2 * HOUR,
      lastEventOutcome: "run",
      lastRunStatus: "failed",
    });
    expect(waitingSince(waiting, clock)).toBe(nine);
    expect(rowState(waiting, clock)).toEqual({
      bad: "failed 2h ago",
      text: "waiting for a slot",
    });
    expect(nextLine(waiting, clock)).toBe(
      "Waiting for a free slot since 09:00",
    );
    expect(nextLine({ ...waiting, nextAt: clock + 2 * HOUR }, clock)).toBe(
      "Next run today 13:20, in 2h",
    );
    expect(nextRunWords(clock + 2 * HOUR, clock, "UTC")).toBe(
      "Next run today 13:20, in 2h",
    );
    expect(nextLine({ ...waiting, nextAt: nine - 24 * HOUR }, clock)).toBe(
      "Waiting for a free slot since Sun Sep 13 09:00",
    );
    // a fire the server is starting this moment, or a clock a few
    // seconds ahead, is not a wait
    expect(waitingSince({ ...waiting, nextAt: clock - 5_000 }, clock)).toBe(
      null,
    );
    expect(waitingSince({ ...waiting, nextAt: clock - 11_000 }, clock)).toBe(
      clock - 11_000,
    );
    const off = { ...waiting, suspendedAt: clock - HOUR };
    expect(waitingSince(off, clock)).toBeNull();
    expect(rowState(off, clock).text).toBe("suspended");
    expect(rowState({ ...waiting, lastRunStatus: "running" }, clock)).toEqual({
      bad: null,
      text: "running",
    });
  });

  test("a suspended row names who suspended it", () => {
    const off = {
      suspendedAt: now - 2 * HOUR,
      suspendedBy: { id: "u9", username: "admin" },
    };
    expect(suspendedText(off, now)).toBe("Suspended by @admin 2h ago");
    expect(suspendedText({ ...off, suspendedBy: null }, now)).toBe(
      "Suspended 2h ago",
    );
    expect(suspendedText({ suspendedAt: null, suspendedBy: null }, now)).toBe(
      "",
    );
  });

  test("a suspended row says so, and a run in flight wins", () => {
    const off = automation({ suspendedAt: now - HOUR, nextAt: null });
    expect(rowState(off, now).text).toBe("suspended");
    const busy = automation({ lastRunStatus: "running" });
    expect(rowState(busy, now)).toEqual({ bad: null, text: "running" });
  });

  test("a skip's reason shows on the page", () => {
    const skipped = automation({
      lastEventAt: now - 60_000,
      lastEventOutcome: "skipped",
      lastEventReason: "still running",
      lastRunStatus: "done",
    });
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

  test("the page finds its row and project, or says it was deleted", () => {
    const page = {
      id: "au1",
      rows: [automation()],
      found: { id: "au1", projectId: "p1" },
      project: { id: "p1" },
      agentsIn: true,
      failure: null,
    };
    expect(automationPageOf(page)).toEqual({
      row: automation(),
      projectId: "p1",
      shown: { id: "p1" },
      error: null,
    });
    // another project on screen, or one found for another automation
    expect(automationPageOf({ ...page, project: { id: "p2" } }).shown).toBe(
      null,
    );
    expect(
      automationPageOf({ ...page, found: { id: "au2", projectId: "p1" } })
        .projectId,
    ).toBe(null);
    const gone = { ...page, rows: [] };
    expect(automationPageOf(gone).error).toBe("This automation was deleted.");
    // still loading: no list, no agents or no project found yet
    expect(automationPageOf({ ...gone, rows: null }).error).toBe(null);
    expect(automationPageOf({ ...gone, agentsIn: false }).error).toBe(null);
    expect(automationPageOf({ ...gone, found: null }).error).toBe(null);
    const failure = { words: "not found", status: 404 };
    expect(automationPageOf({ ...gone, failure }).error).toBe(failure);
  });
});

const LIMIT = 600_000;

describe("the form", () => {
  const filled = (changes: Partial<Draft> = {}): Draft => ({
    ...draftOf(null, "a1", "UTC", LIMIT),
    name: "nightly",
    instructions: "Check the clusters",
    ...changes,
  });

  test("a new draft starts on weekdays at nine, at the deadline limit", () => {
    expect(draftOf(null, "a1", "Europe/Bucharest", LIMIT)).toEqual({
      name: "",
      agentId: "a1",
      instructions: "",
      schedule: "0 9 * * MON-FRI",
      tz: "Europe/Bucharest",
      deadline: "10",
      retention: "30",
      memory: "own",
      memoryGuidance: OWN_MEMORY_GUIDANCE,
      web: true,
      visuals: true,
      mcpOff: [],
      skillsOff: [],
      credentialsOff: [],
    });
  });

  test("the body trims, turns minutes into ms and leaves the rest to the server", () => {
    expect(
      requestOf(filled({ deadline: " 5 ", schedule: " * * * * * " }), LIMIT),
    ).toEqual({
      body: {
        name: "nightly",
        agentId: "a1",
        instructions: "Check the clusters",
        schedule: "* * * * *",
        tz: "UTC",
        deadlineMs: 300_000,
        retentionDays: 30,
        ownMemory: true,
        memoryGuidance: OWN_MEMORY_GUIDANCE,
        disabledCapabilities: [],
      },
    });
    const empty = requestOf(filled({ deadline: "" }), LIMIT);
    expect("body" in empty && empty.body.deadlineMs).toBeNull();
    // the limit itself goes as none, so the row follows the limit
    const atLimit = requestOf(filled({ deadline: "10" }), LIMIT);
    expect("body" in atLimit && atLimit.body.deadlineMs).toBeNull();
    const part = requestOf(filled({ deadline: "1.5" }), LIMIT);
    expect("body" in part && part.body.deadlineMs).toBe(90_000);
  });

  test("only emptiness and the numbers' shape are refused here", () => {
    expect(requestOf(filled({ name: " " }), LIMIT)).toEqual({
      problem: "Name is empty",
      field: "name",
    });
    expect(requestOf(filled({ agentId: "" }), LIMIT)).toEqual({
      problem: "Pick an agent",
      field: "agent",
    });
    expect(requestOf(filled({ schedule: "" }), LIMIT)).toEqual({
      problem: "The schedule is not complete",
      field: "schedule",
    });
    expect(requestOf(filled({ deadline: "ten" }), LIMIT)).toEqual({
      problem: "Deadline needs a number of minutes",
      field: "deadline",
    });
    expect(requestOf(filled({ retention: "" }), LIMIT)).toEqual({
      problem: "History retention needs whole days",
      field: "retention",
    });
    // out of range is the server's word
    expect("body" in requestOf(filled({ retention: "9999" }), LIMIT)).toBe(
      true,
    );
  });

  test("a draft is dirty when a field moved off the row", () => {
    const row = automation({ deadlineMs: 120_000 });
    const same = draftOf(row, "ignored", "ignored", LIMIT);
    expect(same.deadline).toBe("2");
    expect(dirtyOf(same, row, LIMIT)).toBe(false);
    expect(dirtyOf({ ...same, schedule: "0 10 * * *" }, row, LIMIT)).toBe(true);
    expect(dirtyOf(same, null, LIMIT)).toBe(true);
    // a row with no deadline shows the limit and is not dirty for it
    const none = automation({ deadlineMs: null });
    const shown = draftOf(none, "ignored", "ignored", LIMIT);
    expect(shown.deadline).toBe("10");
    expect(dirtyOf(shown, none, LIMIT)).toBe(false);
  });

  test("web access is on for a new task, follows the row, and saves as the set", () => {
    expect(draftOf(null, "a1", "UTC", LIMIT).web).toBe(true);
    const off = automation({ disabledCapabilities: ["web"] });
    const shown = draftOf(off, "ignored", "ignored", LIMIT);
    expect(shown.web).toBe(false);
    expect(dirtyOf(shown, off, LIMIT)).toBe(false);
    expect(dirtyOf({ ...shown, web: true }, off, LIMIT)).toBe(true);
    const body = (web: boolean) => {
      const request = requestOf(filled({ web }), LIMIT);
      return "body" in request ? request.body.disabledCapabilities : null;
    };
    expect(body(false)).toEqual(["web"]);
    expect(body(true)).toEqual([]);
  });

  test("visuals are on for a new task, follow the row, and save as the key", () => {
    expect(draftOf(null, "a1", "UTC", LIMIT).visuals).toBe(true);
    const off = automation({ disabledCapabilities: ["visualize"] });
    const shown = draftOf(off, "ignored", "ignored", LIMIT);
    expect(shown.visuals).toBe(false);
    expect(shown.web).toBe(true);
    expect(dirtyOf(shown, off, LIMIT)).toBe(false);
    expect(dirtyOf({ ...shown, visuals: true }, off, LIMIT)).toBe(true);
    const request = requestOf(filled({ visuals: false, web: false }), LIMIT);
    expect(
      "body" in request ? request.body.disabledCapabilities : null,
    ).toEqual(["visualize", "web"]);
  });

  test("servers off follow the row and save only for the picked agent", () => {
    const row = automation({ disabledCapabilities: ["mcp:a1", "mcp:gone"] });
    const shown = draftOf(row, "ignored", "ignored", LIMIT);
    expect(shown.mcpOff).toEqual(["mcp:a1", "mcp:gone"]);
    expect(dirtyOf(shown, row, LIMIT)).toBe(false);
    expect(dirtyOf({ ...shown, mcpOff: ["mcp:a1"] }, row, LIMIT)).toBe(true);
    const servers = [
      { id: "a1", name: "flux", tools: 18 },
      { id: "b2", name: "github", tools: 42 },
    ];
    const request = requestOf(
      filled({ web: false, mcpOff: ["mcp:gone", "mcp:a1"] }),
      LIMIT,
      servers,
    );
    expect("body" in request && request.body.disabledCapabilities).toEqual([
      "mcp:a1",
      "web",
    ]);
  });

  test("skills off follow the row and save only for the picked agent", () => {
    const row = automation({
      disabledCapabilities: ["skill:gone", "skill:s1"],
    });
    const shown = draftOf(row, "ignored", "ignored", LIMIT);
    expect(shown.skillsOff).toEqual(["skill:gone", "skill:s1"]);
    expect(shown.mcpOff).toEqual([]);
    expect(dirtyOf(shown, row, LIMIT)).toBe(false);
    expect(dirtyOf({ ...shown, skillsOff: [] }, row, LIMIT)).toBe(true);
    const request = requestOf(
      filled({ mcpOff: ["mcp:a1"], skillsOff: ["skill:gone", "skill:s1"] }),
      LIMIT,
      [{ id: "a1", name: "flux", tools: 18 }],
      [{ id: "s1", name: "gitops" }],
    );
    expect("body" in request && request.body.disabledCapabilities).toEqual([
      "mcp:a1",
      "skill:s1",
    ]);
  });

  test("the page's aside names what the row keeps its runs from", () => {
    const servers = [
      { id: "b2", name: "github", tools: 42 },
      { id: "a1", name: "flux", tools: 18 },
    ];
    const skills = [
      { id: "s2", name: "visualize" },
      { id: "s1", name: "gitops" },
    ];
    expect(accessOf(automation({}), servers, skills)).toEqual({
      web: true,
      visuals: true,
      mcpOff: [],
      skillsOff: [],
      credentialsOff: [],
    });
    const row = automation({
      disabledCapabilities: [
        "mcp:a1",
        "mcp:b2",
        "mcp:gone",
        // runs are never offered memory_edit, so the aside says nothing
        "memory",
        "skill:gone",
        "skill:s1",
        "skill:s2",
        "visualize",
        "web",
      ],
    });
    expect(accessOf(row, servers, skills)).toEqual({
      web: false,
      visuals: false,
      mcpOff: ["flux", "github"],
      skillsOff: ["gitops", "visualize"],
      credentialsOff: [],
    });
    // nor does the editor keep a key it never shows
    const saved = requestOf(draftOf(row, "a1", "UTC", LIMIT), LIMIT);
    expect(
      "body" in saved ? saved.body.disabledCapabilities : null,
    ).not.toContain("memory");
  });

  test("credentials off follow the row and save only for the project's", () => {
    const row = automation({
      disabledCapabilities: ["credential:c1", "credential:gone"],
    });
    const shown = draftOf(row, "ignored", "ignored", LIMIT);
    expect(shown.credentialsOff).toEqual(["credential:c1", "credential:gone"]);
    expect(shown.mcpOff).toEqual([]);
    expect(dirtyOf(shown, row, LIMIT)).toBe(false);
    expect(dirtyOf({ ...shown, credentialsOff: [] }, row, LIMIT)).toBe(true);
    const credentials = [
      { id: "c1", name: "finnhub" },
      { id: "c2", name: "github" },
    ];
    const request = requestOf(
      filled({ credentialsOff: ["credential:gone", "credential:c1"] }),
      LIMIT,
      [],
      [],
      credentials,
    );
    expect("body" in request && request.body.disabledCapabilities).toEqual([
      "credential:c1",
    ]);
  });

  test("the aside names the credentials off, none while the web is off", () => {
    const credentials = [
      { id: "c2", name: "github" },
      { id: "c1", name: "finnhub" },
    ];
    const keys = ["credential:c1", "credential:c2", "credential:gone"];
    expect(
      accessOf(automation({ disabledCapabilities: keys }), [], [], credentials)
        .credentialsOff,
    ).toEqual(["finnhub", "github"]);
    const off = accessOf(
      automation({ disabledCapabilities: [...keys, "web"] }),
      [],
      [],
      credentials,
    );
    expect(off.web).toBe(false);
    expect(off.credentialsOff).toEqual([]);
  });

  test("memory is none or the task's own note", () => {
    const mode = (ownMemory: boolean) =>
      draftOf(automation({ ownMemory }), "a1", "UTC", LIMIT).memory;
    expect(mode(false)).toBe("none");
    expect(mode(true)).toBe("own");
    const own = (memory: Draft["memory"]) => {
      const sent = requestOf(filled({ memory }), LIMIT);
      return "body" in sent ? sent.body.ownMemory : null;
    };
    expect(own("none")).toBe(false);
    expect(own("own")).toBe(true);
    expect(automationFieldOf("ownMemory must be boolean")).toBe("memory");
  });

  test("the server's range refusals land at their fields", () => {
    expect(automationFieldOf("deadline must be above zero")).toBe("deadline");
    expect(automationFieldOf("deadline is above the run limit")).toBe(
      "deadline",
    );
    expect(automationFieldOf("retention must be from 1 to 365 days")).toBe(
      "retention",
    );
    expect(
      automationFieldOf("memory guidance must be at most 2000 bytes"),
    ).toBe("memoryGuidance");
  });

  test("own memory fills an empty box with a suggestion and takes it back unchanged", () => {
    const fresh = { ...draftOf(null, "a1", "UTC", LIMIT), memoryGuidance: "" };
    const none = pickMemory(fresh, "none");
    expect(none).toMatchObject({ memory: "none", memoryGuidance: "" });
    const own = pickMemory(none, "own");
    expect(own).toMatchObject({
      memory: "own",
      memoryGuidance: OWN_MEMORY_GUIDANCE,
    });
    expect(pickMemory(own, "none").memoryGuidance).toBe("");
    // what someone typed stays across modes
    const edited = { ...fresh, memoryGuidance: "Keep the versions" };
    expect(pickMemory(edited, "none").memoryGuidance).toBe("Keep the versions");
    expect(pickMemory(edited, "own")).toBe(edited);
  });

  test("an untouched deadline follows a limit changed under the form", () => {
    const row = automation({ deadlineMs: null });
    const shown = draftOf(row, "ignored", "ignored", LIMIT);
    const lowered = followDeadlineLimit(shown, false, row, 300_000);
    expect(lowered.deadline).toBe("5");
    expect(requestOf(lowered, 300_000)).toMatchObject({
      body: { deadlineMs: null },
    });
    expect(followDeadlineLimit(shown, true, row, 300_000)).toBe(shown);
    const fixed = automation({ deadlineMs: 120_000 });
    expect(followDeadlineLimit(shown, false, fixed, 300_000)).toBe(shown);
  });
});

describe("the pickers", () => {
  test("a zone is found by its city or its country, accents folded", () => {
    const at = Date.UTC(2026, 0, 15, 12);
    const zones = zoneOptions(Intl.supportedValuesOf("timeZone"), "", at);
    const find = (q: string) => filterOptions(zones, q).map((z) => z.value);
    expect(find("cluj")).toEqual(["Europe/Bucharest"]);
    expect(find("romania")).toEqual(["Europe/Bucharest"]);
    expect(find("san francisco")).toEqual(["America/Los_Angeles"]);
    expect(find("munich")).toEqual(["Europe/Berlin"]);
    expect(find("Zürich")).toEqual(["Europe/Zurich"]);
    expect(find("bangalore")).toHaveLength(1);
    expect(find("london")).toContain("Europe/London");
    expect(placeOf("Asia/Calcutta")).toEqual(placeOf("Asia/Kolkata"));
  });

  test("a zone carries its offset, and a link the list leaves out stays", () => {
    const at = Date.UTC(2026, 0, 15, 12);
    const zones = zoneOptions(
      ["Europe/Bucharest", "America/New_York"],
      "UTC",
      at,
    );
    expect(zones.map((z) => [z.label, z.detail])).toEqual([
      ["UTC", "GMT"],
      ["Europe/Bucharest", "GMT+2 · Romania"],
      ["America/New_York", "GMT-5 · United States"],
    ]);
    expect(
      zoneOptions(["Europe/Bucharest"], "Europe/Bucharest", at).length,
    ).toBe(1);
  });
});

describe("the run log", () => {
  test("a run says what started it, a person by name alone", () => {
    expect(sourceText(run())).toBe("Scheduled");
    const pressed = {
      ...run({ runSource: "manual", ownerId: "u9" }),
      runBy: { id: "u9", username: "admin" },
    };
    expect(sourceText(pressed)).toBe("@admin");
    expect(sourceText(run({ runSource: "manual" }))).toBe("");
    expect(sourceText(run({ runSource: null }))).toBe("");
  });

  test("a run's length, to the second, against its deadline", () => {
    const send = {
      id: "d1",
      sessionId: "s1",
      kind: "run" as const,
      userId: "u1",
      agentId: "a1",
      providerId: "pr1",
      model: "m",
      status: "running" as const,
      cause: null,
      error: null,
      firstMessageId: "m1",
      rounds: 1,
      toolCalls: 0,
      memoryRound: null,
      memoryError: null,
      memorySkipped: null,
      tokens: 0,
      startedAt: now - 250_000,
      finishedAt: null,
    };
    expect(durationOf(run(), now)).toBeNull();
    expect(durationOf({ ...run(), send }, now)).toBe(250_000);
    expect(
      durationOf(
        { ...run(), send: { ...send, finishedAt: now - 200_000 } },
        now,
      ),
    ).toBe(50_000);
    expect(durationText(38_000)).toBe("38s");
    expect(durationText(250_000)).toBe("4m 10s");
    expect(durationText(3_720_000)).toBe("1h 02m");
    expect(deadlineShare(250_000, LIMIT)).toBeCloseTo(0.4167, 3);
    expect(deadlineShare(900_000, LIMIT)).toBe(1);
    expect(deadlineText(LIMIT)).toBe("10 min");
    expect(deadlineText(90_000)).toBe("90 s");
  });

  test("a filter holds failed or manual runs", () => {
    expect(matchesFilter(run(), null)).toBe(true);
    expect(matchesFilter(run({ status: "failed" }), "failed")).toBe(true);
    expect(matchesFilter(run({ status: "stopped" }), "failed")).toBe(false);
    expect(matchesFilter(run({ runSource: "manual" }), "manual")).toBe(true);
    expect(matchesFilter(run(), "manual")).toBe(false);
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
    const older = run({ id: "s0", lastActivityAt: now - HOUR });
    const rows = upsertRun([older], run({ id: "s1", revision: 2 }));
    expect(rows.map((r) => r.session.id)).toEqual(["s1", "s0"]);
    expect(upsertRun(rows, run({ id: "s1", revision: 1 }))).toBe(rows);
  });

  test("runs go in the server's order: last activity, then id", () => {
    // opened first, active last: activity places it, not creation
    const late = run({
      id: "s9",
      createdAt: now - HOUR,
      lastActivityAt: now + HOUR,
    });
    const tied = [
      run({ id: "s2", createdAt: now + 2, lastActivityAt: now }),
      run({ id: "s1", createdAt: now + 1, lastActivityAt: now }),
    ];
    const rows = [late, ...tied].reduce(upsertRun, [] as StreamRow[]);
    expect(rows.map((r) => r.session.id)).toEqual(["s9", "s1", "s2"]);
    const running = run({
      id: "s3",
      status: "running",
      revision: 2,
      lastActivityAt: now + 2 * HOUR,
    });
    expect(upsertRun(rows, running).map((r) => r.session.id)).toEqual([
      "s3",
      "s9",
      "s1",
      "s2",
    ]);
  });
});

describe("the entity over the socket", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    me.value = null;
  });

  test.serial("a row read before its delete never joins again", async () => {
    me.value = {
      id: "u1",
      username: "casey",
      fullName: "Casey",
      role: "member",
      mustChangePassword: false,
    };
    let release: (response: Response) => void = () => {};
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/automations/au7") {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      if (url === "/api/projects/p1/automations") {
        return Response.json({ automations: [], runDeadlineMs: LIMIT });
      }
      return Response.json({ error: "no" }, { status: 404 });
    }) as unknown as typeof fetch;
    const page = loadAutomationPage("au7", undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    onAutomationsSocket({
      type: "automationDeleted",
      projectId: "p1",
      automationId: "au7",
      runs: true,
    });
    release(Response.json({ automation: automation({ id: "au7" }) }));
    await page;
    expect(automations.value?.map((a) => a.id)).toEqual([]);
  });

  test.serial("frames of the project on screen move its rows", async () => {
    me.value = {
      id: "u1",
      username: "casey",
      fullName: "Casey",
      role: "member",
      mustChangePassword: false,
    };
    globalThis.fetch = (async () =>
      Response.json({
        automations: [automation()],
        runDeadlineMs: LIMIT,
      })) as unknown as typeof fetch;
    await loadAutomations("p1");
    expect(automations.value?.map((a) => a.revision)).toEqual([1]);
    expect(automationCount("p1")).toBe(1);
    expect(automationCount("p2")).toBeNull();
    expect(runDeadlineMs.value).toBe(LIMIT);

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
    release(
      Response.json({ automations: [automation()], runDeadlineMs: LIMIT }),
    );
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
      runs: false,
    });
    release(
      Response.json({
        automations: [
          automation(),
          automation({ id: "au2", name: "added", revision: 1 }),
        ],
        runDeadlineMs: LIMIT,
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

    // a run's envelope joins the runs on screen at once, and asks for
    // the runs again for the tally
    const tally = { running: 1, done: 0, failed: 0, stopped: 0 };
    let asked = 0;
    globalThis.fetch = (async () => {
      asked++;
      return Response.json({ rows: [run({ revision: 1 })], tally });
    }) as unknown as typeof fetch;
    runs.value = {
      id: "au1",
      filter: null,
      rows: [],
      tally: null,
      next: null,
      more: IDLE,
    };
    onAutomationsSocket({
      type: "session",
      projectId: "p1",
      session: session({ revision: 1 }),
      messages: [],
      send: null,
    });
    expect(runs.value?.rows?.map((r) => r.session.id)).toEqual(["s1"]);
    await Bun.sleep(0);
    expect(asked).toBe(1);
    expect(runs.value?.tally).toEqual(tally);
    // the same run under the same status moves in place, unasked
    onAutomationsSocket({
      type: "session",
      projectId: "p1",
      session: session({ revision: 2 }),
      messages: [],
      send: null,
    });
    expect(runs.value?.rows?.[0]?.session.revision).toBe(2);
    expect(asked).toBe(1);
    // a frame while the tally is asked does not lose the answer, and the
    // answer keeps the frame's newer row
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as unknown as typeof fetch;
    onAutomationsSocket({
      type: "session",
      projectId: "p1",
      session: session({ id: "s3", revision: 1 }),
      messages: [],
      send: null,
    });
    onAutomationsSocket({
      type: "session",
      projectId: "p1",
      session: session({ id: "s3", revision: 2, title: "moved" }),
      messages: [],
      send: null,
    });
    const counted = { ...tally, running: 2 };
    release(
      Response.json({
        rows: [run({ id: "s3" }), run({ revision: 2 })],
        tally: counted,
      }),
    );
    await Bun.sleep(0);
    expect(runs.value?.tally).toEqual(counted);
    expect(
      runs.value?.rows?.find((r) => r.session.id === "s3")?.session.title,
    ).toBe("moved");
    runs.value = {
      ...runs.value!,
      rows: runs.value!.rows!.filter((r) => r.session.id !== "s3"),
    };
    // a chat's envelope does not join
    onAutomationsSocket({
      type: "session",
      projectId: "p1",
      session: session({ id: "c1", origin: "chat", automationId: null }),
      messages: [],
      send: null,
    });
    expect(runs.value?.rows?.length).toBe(1);

    // a rename relabels the runs
    const renamed = automations.value?.[0]?.revision ?? 0;
    onAutomationsSocket({
      type: "automation",
      projectId: "p1",
      automation: automation({ revision: renamed + 1, name: "digest" }),
    });
    expect(runs.value?.rows?.[0]?.automation?.name).toBe("digest");

    // under the failed filter a run that fails joins and one that is
    // done leaves
    runs.value = {
      id: "au1",
      filter: "failed",
      rows: [],
      tally,
      next: null,
      more: IDLE,
    };
    const failedRun = {
      type: "session" as const,
      projectId: "p1",
      session: session({ id: "s2", revision: 3, status: "failed" }),
      messages: [],
      send: null,
    };
    onAutomationsSocket(failedRun);
    expect(runs.value?.rows?.map((r) => r.session.id)).toEqual(["s2"]);
    onAutomationsSocket({
      ...failedRun,
      session: session({ id: "s2", revision: 4, status: "done" }),
    });
    expect(runs.value?.rows).toEqual([]);

    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as unknown as typeof fetch;
    runs.value = {
      id: "au1",
      filter: null,
      rows: [run()],
      tally,
      next: null,
      more: IDLE,
    };
    const staleRuns = loadRuns("au1");
    onAutomationsSocket({
      type: "session",
      projectId: "p1",
      session: session({ revision: 5, title: "newer run" }),
      messages: [],
      send: null,
    });
    release(Response.json({ rows: [], tally }));
    await staleRuns;
    expect(runs.value?.rows?.[0]?.session.title).toBe("newer run");

    onAutomationsSocket({
      type: "automationDeleted",
      projectId: "p1",
      automationId: "au1",
      runs: false,
    });
    expect(automations.value).toEqual([]);
    expect(runs.value).toBeNull();

    onAutomationsSocket({ type: "revoked", projectId: "p1" });
    expect(automations.value).toBeNull();
  });
});

describe("the runs' pages", () => {
  const realFetch = globalThis.fetch;
  const tally = { running: 0, done: 4, failed: 0, stopped: 0 };
  let urls: string[] = [];
  let answer: (url: string) => Response | Promise<Response>;
  afterEach(() => {
    closeRuns();
    globalThis.fetch = realFetch;
    me.value = null;
  });

  const done = (id: string, at: number, revision = 1) =>
    run({ id, status: "done", revision, lastActivityAt: at });
  const first = () => [done("r4", now - 1), done("r3", now - 2)];
  const second = () => [done("r2", now - 3), done("r1", now - 4)];
  const ids = () => runs.value?.rows?.map((r) => r.session.id);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const hold = () => {
    let release: (r: Response) => void = () => {};
    answer = () =>
      new Promise((r) => {
        release = r;
      });
    return (r: Response) => release(r);
  };

  async function firstPage(filter: RunFilter | null = null) {
    urls = [];
    me.value = {
      id: "u1",
      username: "casey",
      fullName: "Casey",
      role: "member",
      mustChangePassword: false,
    };
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return answer(url);
    }) as unknown as typeof fetch;
    answer = () => Response.json({ rows: first(), tally, next: "after-r3" });
    await loadRuns("au1", filter);
  }

  test.serial(
    "a later page follows under the filter, its tally the newest",
    async () => {
      await firstPage("manual");
      const newer = { ...tally, done: 5 };
      answer = () =>
        Response.json({ rows: second(), tally: newer, next: null });
      await loadMoreRuns();
      expect(urls).toEqual([
        "/api/automations/au1/runs?filter=manual",
        "/api/automations/au1/runs?filter=manual&before=after-r3",
      ]);
      expect(ids()).toEqual(["r4", "r3", "r2", "r1"]);
      expect(runs.value?.tally).toEqual(newer);
      expect(runs.value?.next).toBeNull();
    },
  );

  test.serial("an envelope places a run by its last activity", async () => {
    await firstPage();
    onAutomationsSocket({
      type: "session",
      projectId: "p1",
      session: session({
        id: "r3",
        status: "done",
        revision: 2,
        createdAt: now - HOUR,
        lastActivityAt: now,
      }),
      messages: [],
      send: null,
    });
    expect(ids()).toEqual(["r3", "r4"]);
  });

  test.serial("a failed page keeps the rows and says why", async () => {
    await firstPage();
    answer = () => Response.json({ error: "busy" }, { status: 503 });
    await loadMoreRuns();
    expect(ids()).toEqual(["r4", "r3"]);
    expect(runs.value?.next).toBe("after-r3");
    expect(runs.value?.more).toEqual({
      loading: false,
      error: { words: "busy", status: 503 },
    });
  });

  test.serial("a page read before a rename carries the new name", async () => {
    await firstPage();
    const release = hold();
    const more = loadMoreRuns();
    await settle();
    relabelRuns({ id: "au1", name: "renamed" });
    release(Response.json({ rows: second(), tally, next: null }));
    await more;
    expect(runs.value?.rows?.map((r) => r.automation?.name)).toEqual([
      "renamed",
      "renamed",
      "renamed",
      "renamed",
    ]);
  });

  test.serial(
    "a first page read before a rename carries the new name",
    async () => {
      await firstPage();
      const release = hold();
      const load = loadRuns("au1", "manual");
      await settle();
      relabelRuns({ id: "au1", name: "renamed" });
      release(Response.json({ rows: first(), tally, next: null }));
      await load;
      expect(runs.value?.rows?.map((r) => r.automation?.name)).toEqual([
        "renamed",
        "renamed",
      ]);
    },
  );

  test.serial("closing the runs drops a page in flight", async () => {
    await firstPage();
    const release = hold();
    const more = loadMoreRuns();
    await settle();
    closeRuns();
    release(Response.json({ rows: second(), tally, next: null }));
    await more;
    expect(runs.value).toBeNull();
  });

  test.serial(
    "a filter change drops a page in flight and keeps the tally",
    async () => {
      await firstPage();
      const release = hold();
      const more = loadMoreRuns();
      await settle();
      const releaseFailed = hold();
      const failed = loadRuns("au1", "failed");
      expect(runs.value?.rows).toBeNull();
      expect(runs.value?.tally).toEqual(tally);
      expect(runs.value?.more).toEqual(IDLE);
      release(Response.json({ rows: second(), tally, next: null }));
      await more;
      expect(runs.value?.rows).toBeNull();
      await settle();
      releaseFailed(Response.json({ rows: [], tally, next: null }));
      await failed;
      expect(ids()).toEqual([]);
      expect(runs.value?.filter).toBe("failed");
    },
  );

  test.serial(
    "a tally refresh drops a page in flight and keeps the tail",
    async () => {
      await firstPage();
      answer = () => Response.json({ rows: second(), tally, next: "after-r1" });
      await loadMoreRuns();
      const release = hold();
      const more = loadMoreRuns();
      await settle();
      // a new run moves the tally: the first page again, warm
      const counted = { ...tally, running: 1 };
      answer = () =>
        Response.json({
          rows: [
            run({ id: "r5", status: "running", lastActivityAt: now }),
            ...first(),
          ],
          tally: counted,
          next: "after-r3",
        });
      onAutomationsSocket({
        type: "session",
        projectId: "p1",
        session: session({ id: "r5", lastActivityAt: now }),
        messages: [],
        send: null,
      });
      expect(runs.value?.more).toEqual(IDLE);
      await settle();
      release(
        Response.json({ rows: [done("r0", now - 5)], tally, next: null }),
      );
      await more;
      expect(ids()).toEqual(["r5", "r4", "r3", "r2", "r1"]);
      expect(runs.value?.tally).toEqual(counted);
      expect(runs.value?.next).toBe("after-r1");
    },
  );

  test.serial("a navigation loads the first page cold", async () => {
    await firstPage();
    answer = () => Response.json({ rows: second(), tally, next: null });
    await loadMoreRuns();
    answer = () => Response.json({ rows: first(), tally, next: "after-r3" });
    await loadRuns("au1", null);
    expect(ids()).toEqual(["r4", "r3"]);
    expect(runs.value?.next).toBe("after-r3");
  });
});
