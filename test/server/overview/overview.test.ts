// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The overview answer over a composed app: the parsers, the days of a
// zone across a DST change, turns and runs apart, the totals and all
// time, cost coverage, both breakdowns over a fixture with a team and
// a personal project and their tasks, a send with several rounds
// counted once, the turn lengths without a running send or a run, the
// cache per zone, and the load read at each request.

import { describe, expect, test } from "bun:test";
import { parseNoQuery } from "../../../src/server/lib/body.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  BOARD_KEEP_MS,
  canonicalZone,
  KEEP_MS,
  overviewArea,
  type Probe,
  parseOverviewQuery,
  parseUsageQuery,
  type Reading,
  sampler,
} from "../../../src/server/overview/index.ts";
import { parseZoneQuery } from "../../../src/server/usage/index.ts";
import type {
  LoadResponse,
  OverviewResponse,
  UsageResponse,
} from "../../../src/shared/api/admin.ts";
import { collectLogs, testApp } from "../../helpers/app.ts";
import {
  automationBody,
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import { type ChatApp, chatApp, FLASH, startChat } from "../../helpers/chat.ts";
import { createTeam } from "../../helpers/projects.ts";

const IDLE = { chats: 0, runs: 0, scheduled: 0, projectsFull: 0 };
const NOW = Date.parse("2026-06-15T12:00:00Z");
const DAY = 86_400_000;
const LONG_AGO = Date.parse("2020-01-01T00:00:00Z");
const NO_ATTENTION = () => ({
  providers: [],
  mcp: [],
  skills: [],
  credentials: [],
  search: { provider: null, hasKey: false },
});

async function overview(
  chat: ChatApp,
  tz = "UTC",
  range?: string,
): Promise<OverviewResponse> {
  const res = await chat.admin.call(
    "GET",
    `/api/admin/overview?tz=${encodeURIComponent(tz)}${range ? `&range=${range}` : ""}`,
  );
  expect(res.status).toBe(200);
  return res.json();
}

// the fixture's month, June 2026, up to its noon on the 15th
async function usage(
  chat: ChatApp,
  month = "2026-06",
  tz = "UTC",
): Promise<UsageResponse> {
  const res = await chat.admin.call(
    "GET",
    `/api/admin/usage?tz=${encodeURIComponent(tz)}&month=${month}`,
  );
  expect(res.status).toBe(200);
  return res.json();
}

async function load(chat: ChatApp): Promise<LoadResponse> {
  const res = await chat.admin.call("GET", "/api/admin/load");
  expect(res.status).toBe(200);
  return res.json();
}

// a chat app whose clock sits on a fixed noon; its logins made again
// past their life, and every real send and usage row moved out of any
// window, so the rows a test inserts are all the range holds
async function fixture(): Promise<ChatApp> {
  const chat = await chatApp();
  chat.app.now.value = NOW;
  await chat.admin.login("admin", "hunter2-test");
  await chat.member.login("casey", "pw");
  return chat;
}

async function settledChat(chat: ChatApp, projectId = chat.projectId) {
  const { script, sessionId } = await startChat(
    chat,
    "hello there",
    chat.member,
    projectId,
  );
  script.reply("a reply");
  await settleRun(chat, sessionId);
  return sessionId;
}

async function runOf(chat: ChatApp, automationId: string): Promise<string> {
  const { sessionId, main } = await startRun(chat, automationId);
  main.reply("done");
  await settleRun(chat, sessionId);
  return sessionId;
}

function hide(chat: ChatApp) {
  chat.app.db.query("update sends set started_at = ?").run(LONG_AGO);
  chat.app.db.query("update usage set created_at = ?").run(LONG_AGO);
}

type Round = {
  prompt?: number;
  completion?: number;
  cached?: number | null;
  cost?: number | null;
  at?: number;
  // the model a router said answered, when it is not the one asked for
  served?: string;
};

let ids = 0;

// a send on a session, with its usage rows; the session's own user,
// project and agent, the fixture's provider and model
function addSend(
  chat: ChatApp,
  sessionId: string,
  fields: {
    at: number;
    finishedAt?: number | null;
    status?: "running" | "done" | "failed" | "stopped";
    rounds?: number;
    usage?: Round[];
    model?: string;
  },
): string {
  const db = chat.app.db;
  const session = db
    .query<
      { projectId: string; ownerId: string; agentId: string; origin: string },
      [string]
    >(
      "select project_id as projectId, owner_id as ownerId, agent_id as agentId, origin from sessions where id = ?",
    )
    .get(sessionId)!;
  const id = `send-${++ids}`;
  const status = fields.status ?? "done";
  db.query(
    `insert into sends (id, session_id, kind, user_id, agent_id, provider_id,
       provider_name, model, status, first_message_id, rounds, started_at,
       finished_at)
     values (?, ?, ?, ?, ?, ?, 'local', ?, ?, 'm', ?, ?, ?)`,
  ).run(
    id,
    sessionId,
    session.origin === "automation" ? "run" : "chat",
    session.ownerId,
    session.agentId,
    chat.providerId,
    fields.model ?? FLASH,
    status,
    fields.rounds ?? 1,
    fields.at,
    fields.finishedAt === undefined
      ? status === "running"
        ? null
        : fields.at
      : fields.finishedAt,
  );
  (fields.usage ?? []).forEach((round, i) => {
    db.query(
      `insert into usage (id, send_id, session_id, project_id, user_id,
         agent_id, provider_id, model, round, seq, prompt_tokens,
         completion_tokens, cached_tokens, cost, created_at, served_model)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${id}-${i}`,
      id,
      sessionId,
      session.projectId,
      session.ownerId,
      session.agentId,
      chat.providerId,
      fields.model ?? FLASH,
      i + 1,
      i + 1,
      round.prompt ?? 100,
      round.completion ?? 10,
      round.cached ?? null,
      round.cost ?? null,
      round.at ?? fields.at,
      round.served ?? null,
    );
  });
  return id;
}

describe("the overview queries", () => {
  const zone = (query: string) =>
    canonicalZone(
      parseZoneQuery(new URL(`http://x/api/admin/overview${query}`)),
    );
  const loadQuery = (query: string) =>
    parseNoQuery(new URL(`http://x/api/admin/load${query}`));

  test("take one zone by its canonical name", () => {
    expect(zone("?tz=Europe%2FBerlin")).toBe("Europe/Berlin");
    expect(zone("?tz=eUrOpE%2FbErLiN")).toBe("Europe/Berlin");
    expect(zone("?tz=utc")).toBe("UTC");
  });

  test("refuse anything else", () => {
    for (const query of [
      "",
      "?tz=UTC&tz=UTC",
      "?tz=Mars%2FOlympus",
      "?tz=UTC&days=30",
      "?tz=UTC&x=1",
    ]) {
      expect(() => zone(query), query).toThrow();
    }
    expect(() => loadQuery("")).not.toThrow();
    expect(() => loadQuery("?tz=UTC")).toThrow();
  });

  test("take a zone and a calendar month for usage", () => {
    const month = (query: string) =>
      parseUsageQuery(new URL(`http://x/api/admin/usage${query}`));
    expect(month("?tz=utc&month=2026-09")).toEqual({
      timeZone: "UTC",
      month: "2026-09",
    });
    for (const query of [
      "?tz=UTC",
      "?month=2026-09",
      "?tz=UTC&month=2026-13",
      "?tz=UTC&month=2026-9",
      "?tz=UTC&month=2026-09&month=2026-08",
      "?tz=UTC&month=2026-09&x=1",
    ]) {
      expect(() => month(query), query).toThrow();
    }
  });
});

describe("the overview days", () => {
  test("fall on the zone's days across a DST change", async () => {
    const chat = await fixture();
    chat.app.now.value = Date.parse("2026-03-31T12:00:00Z");
    await chat.admin.login("admin", "hunter2-test");
    await chat.member.login("casey", "pw");
    const sessionId = await settledChat(chat);
    hide(chat);
    // Berlin's 29th starts at 23:00Z the day before and, the clocks
    // moved, ends at 22:00Z
    addSend(chat, sessionId, { at: Date.parse("2026-03-28T23:30:00Z") });
    addSend(chat, sessionId, {
      at: Date.parse("2026-03-29T21:30:00Z"),
      status: "failed",
    });
    addSend(chat, sessionId, { at: Date.parse("2026-03-29T22:30:00Z") });
    const body = await overview(chat, "Europe/Berlin");
    expect(body.days).toHaveLength(30);
    expect(body.days[0]?.day).toBe("2026-03-02");
    expect(body.days.at(-1)?.day).toBe("2026-03-31");
    const byDay = Object.fromEntries(body.days.map((day) => [day.day, day]));
    expect(byDay["2026-03-29"]).toMatchObject({
      start: Date.parse("2026-03-28T23:00:00Z"),
      turns: 2,
      turnsFailed: 1,
    });
    expect(byDay["2026-03-30"]).toMatchObject({
      start: Date.parse("2026-03-29T22:00:00Z"),
      turns: 1,
      turnsFailed: 0,
    });
    expect(byDay["2026-03-28"]?.turns).toBe(0);
    expect(body.totals).toMatchObject({ turns: 3, turnsFailed: 1 });
    const utc = await overview(chat, "UTC");
    expect(utc.days.find((day) => day.day === "2026-03-28")?.turns).toBe(1);
  });

  test("count turns and runs apart and sum the 30 days", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    const task = await createAutomation(chat);
    const runId = await runOf(chat, task.id);
    hide(chat);
    const tokens = (prompt: number, completion: number, at: number) => ({
      prompt,
      completion,
      at,
    });
    // today, the first of the 30 days, and the day before them
    addSend(chat, sessionId, {
      at: NOW,
      usage: [tokens(100, 10, NOW), tokens(200, 20, NOW)],
      rounds: 2,
    });
    addSend(chat, runId, {
      at: NOW,
      status: "failed",
      usage: [tokens(50, 5, NOW)],
    });
    addSend(chat, sessionId, {
      at: NOW - 29 * DAY,
      usage: [tokens(300, 30, NOW - 29 * DAY)],
    });
    addSend(chat, runId, {
      at: NOW - 30 * DAY,
      usage: [tokens(1000, 100, NOW - 30 * DAY)],
    });
    const body = await overview(chat);
    expect(body.readAt).toBe(NOW);
    expect(body.days).toHaveLength(30);
    expect(body.days.at(-1)).toEqual({
      day: "2026-06-15",
      start: Date.parse("2026-06-15T00:00:00Z"),
      turns: 1,
      turnsFailed: 0,
      runs: 1,
      runsFailed: 1,
      promptTokens: 350,
      cachedTokens: 0,
      completionTokens: 35,
      cost: null,
      decisions: 0,
      decisionTokens: 0,
      pricedDecisions: 0,
      decisionCost: null,
      // the turn ended as it started
      medianMs: 0,
      p95Ms: 0,
      // the member ran both
      activeUsers: 1,
    });
    expect(body.days[0]).toMatchObject({ day: "2026-05-17", turns: 1 });
    expect(body.totals).toEqual({
      turns: 2,
      turnsFailed: 0,
      runs: 1,
      runsFailed: 1,
      promptTokens: 650,
      cachedTokens: 0,
      completionTokens: 65,
      rounds: 4,
      pricedRounds: 0,
      cost: null,
      decisions: 0,
      decisionTokens: 0,
      pricedDecisions: 0,
      decisionCost: null,
    });
  });

  test("sum cost over the priced rounds and cached tokens as given", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    hide(chat);
    addSend(chat, sessionId, {
      at: NOW,
      rounds: 3,
      usage: [
        { cost: 0.5, cached: 40 },
        { cost: 0.25, cached: null },
        { cost: null },
      ],
    });
    addSend(chat, sessionId, { at: NOW - DAY, usage: [{ cost: null }] });
    const body = await overview(chat);
    expect(body.totals).toMatchObject({
      rounds: 4,
      pricedRounds: 2,
      cost: 0.75,
      cachedTokens: 40,
    });
    expect(body.days.at(-1)).toMatchObject({ cachedTokens: 40, cost: 0.75 });
    expect(body.days.at(-2)?.cost).toBeNull();
  });

  test("count decisions apart from the rounds, priced or not", async () => {
    const chat = await fixture();
    const decision = (at: number, tokens: number | null, cost: number | null) =>
      chat.app.db
        .query(
          `insert into decision_usage (id, decider_id, decider_name,
             provider_id, provider_name, model, purpose, input_tokens,
             output_tokens, cost, duration, created_at)
           values (?, 'd1', 'judge', 'p1', 'router', 'm', 'check', ?, 0, ?, 5, ?)`,
        )
        .run(`d${ids++}`, tokens, cost, at);
    decision(NOW, 400, 0.00002);
    decision(NOW, 100, null);
    decision(NOW - DAY, null, null);
    decision(NOW - 400 * DAY, 50, 0.001);
    const body = await overview(chat);
    expect(body.days.at(-1)).toMatchObject({
      decisions: 2,
      decisionTokens: 500,
      pricedDecisions: 1,
      decisionCost: 0.00002,
      cost: null,
    });
    expect(body.days.at(-2)).toMatchObject({
      decisions: 1,
      decisionTokens: 0,
      pricedDecisions: 0,
      decisionCost: null,
    });
    expect(body.totals).toMatchObject({
      decisions: 3,
      decisionTokens: 500,
      pricedDecisions: 1,
      decisionCost: 0.00002,
    });
    expect((await overview(chat, "UTC", "all")).totals).toMatchObject({
      decisions: 4,
      decisionTokens: 550,
      pricedDecisions: 2,
      decisionCost: 0.00102,
    });
  });
});

describe("the overview turn lengths", () => {
  test("give each day's median and p95 of ended chat turns", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    const task = await createAutomation(chat);
    const runId = await runOf(chat, task.id);
    hide(chat);
    const at = NOW - DAY;
    for (let n = 1; n <= 20; n++) {
      addSend(chat, sessionId, { at, finishedAt: at + n * 1000 });
    }
    addSend(chat, sessionId, { at: NOW, finishedAt: NOW + 400 });
    // a running turn has no length yet, and a run's is its task's
    addSend(chat, sessionId, { at: NOW, status: "running" });
    addSend(chat, runId, { at: NOW, finishedAt: NOW + 99_000 });
    const body = await overview(chat);
    expect(body.days.at(-2)).toMatchObject({
      turns: 20,
      medianMs: 10_500,
      p95Ms: 19_000,
    });
    expect(body.days.at(-1)).toMatchObject({ medianMs: 400, p95Ms: 400 });
    expect(body.days.at(-3)).toMatchObject({ medianMs: null, p95Ms: null });
    expect(body.turnLength).toEqual({ medianMs: 10_000, p95Ms: 19_000 });
  });

  test("have none with no ended turn", async () => {
    const chat = await fixture();
    hide(chat);
    const body = await overview(chat);
    expect(body.turnLength).toEqual({ medianMs: null, p95Ms: null });
  });
});

describe("the overview active users", () => {
  test("count each user once a day and once over the range", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    hide(chat);
    addSend(chat, sessionId, { at: NOW });
    addSend(chat, sessionId, { at: NOW + 1000 });
    addSend(chat, sessionId, { at: NOW - DAY });
    // the same chat's send as another user, as a shared project has
    const other = addSend(chat, sessionId, { at: NOW });
    chat.app.db
      .query(
        "update sends set user_id = (select id from users where username = 'admin') where id = ?",
      )
      .run(other);
    const body = await overview(chat);
    expect(body.days.at(-1)?.activeUsers).toBe(2);
    expect(body.days.at(-2)?.activeUsers).toBe(1);
    expect(body.days.at(-3)?.activeUsers).toBe(0);
    expect(body.activeUsers).toBe(2);
  });
});

describe("the overview ranges", () => {
  test("take 30 days, 90 days or every day from the first", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    const task = await createAutomation(chat);
    const runId = await runOf(chat, task.id);
    hide(chat);
    addSend(chat, sessionId, {
      at: NOW,
      status: "failed",
      usage: [{ prompt: 10, completion: 1, cached: 4, cost: 0.1 }],
    });
    addSend(chat, sessionId, { at: NOW - 60 * DAY, usage: [{ prompt: 30 }] });
    addSend(chat, runId, { at: NOW - 400 * DAY, usage: [{ prompt: 20 }] });
    const days30 = await overview(chat);
    expect(days30.range).toBe("30d");
    expect(days30.days).toHaveLength(30);
    expect(days30.totals).toMatchObject({ turns: 1, runs: 0 });
    const days90 = await overview(chat, "UTC", "90d");
    expect(days90.days).toHaveLength(90);
    expect(days90.days.at(-1)?.day).toBe("2026-06-15");
    expect(days90.totals).toMatchObject({ turns: 2, runs: 0 });
    const all = await overview(chat, "UTC", "all");
    // the two real sends moved long ago lead the days
    expect(all.days[0]?.day).toBe("2020-01-01");
    expect(all.days.at(-1)?.day).toBe("2026-06-15");
    expect(all.totals).toMatchObject({
      turns: 3,
      turnsFailed: 1,
      runs: 2,
      runsFailed: 0,
      cachedTokens: 4,
      pricedRounds: 1,
      cost: 0.1,
    });
    // a zone ahead of UTC starts the first day at its own midnight
    const east = await overview(chat, "Asia/Tokyo", "all");
    expect(east.days[0]?.day).toBe("2020-01-01");
  });

  test("all is today alone with no send", async () => {
    const app = await testApp();
    const admin = app.client();
    await admin.login("admin", "hunter2-test");
    const res = await admin.call("GET", "/api/admin/overview?tz=UTC&range=all");
    expect(res.status).toBe(200);
    const body: OverviewResponse = await res.json();
    expect(body.days).toHaveLength(1);
    expect(body.totals).toMatchObject({ turns: 0, runs: 0, cost: null });
    await app.shutdown();
  });

  test("refuse an unknown range", () => {
    const query = (q: string) =>
      parseOverviewQuery(new URL(`http://x/api/admin/overview${q}`));
    expect(query("?tz=UTC")).toEqual({ timeZone: "UTC", range: "30d" });
    expect(query("?tz=UTC&range=all")).toEqual({
      timeZone: "UTC",
      range: "all",
    });
    for (const q of ["?tz=UTC&range=7d", "?tz=UTC&range=all&range=30d"]) {
      expect(() => query(q), q).toThrow();
    }
  });
});

describe("the usage breakdowns", () => {
  test("name a team project, never a personal one", async () => {
    const chat = await fixture();
    const teamId = (await createTeam(chat.admin, "research", [chat.memberId]))
      .id;
    const personalChat = await settledChat(chat);
    const teamChat = await settledChat(chat, teamId);
    const personalTask = await createAutomation(chat, { name: "secret-task" });
    const personalRun = await runOf(chat, personalTask.id);
    const made = await chat.member.call(
      "POST",
      `/api/projects/${teamId}/automations`,
      { body: automationBody(chat, { name: "digest" }) },
    );
    expect(made.status).toBe(201);
    const teamTask = (await made.json()).automation;
    const teamRun = await runOf(chat, teamTask.id);
    hide(chat);
    addSend(chat, personalChat, { at: NOW, usage: [{ prompt: 10 }] });
    addSend(chat, teamChat, {
      at: NOW,
      status: "failed",
      usage: [{ prompt: 20 }],
    });
    addSend(chat, personalRun, { at: NOW, usage: [{ prompt: 30 }] });
    addSend(chat, teamRun, {
      at: NOW,
      rounds: 2,
      usage: [{ prompt: 40 }, { prompt: 50, completion: 0 }],
    });
    const body = await usage(chat);
    expect(body.by.agents).toEqual([
      {
        id: chat.agentId,
        name: "coder",
        owner: null,
        deleted: false,
        tokens: 190,
        cost: null,
        turns: 2,
        runs: 2,
      },
    ]);
    expect(body.by.projects).toEqual([
      {
        id: teamId,
        name: "research",
        owner: null,
        deleted: false,
        tokens: 110 + 20,
        cost: null,
        turns: 1,
        runs: 1,
      },
      {
        id: null,
        name: null,
        owner: "casey",
        deleted: false,
        tokens: 60,
        cost: null,
        turns: 1,
        runs: 1,
      },
    ]);
    expect((await overview(chat)).instance).toMatchObject({
      version: "v0.0.0-test",
      users: 2,
      projects: 1,
      agents: 1,
      automations: 2,
      databaseBytes: 0,
    });
    const text = JSON.stringify(body);
    for (const secret of [
      chat.projectId,
      personalChat,
      personalRun,
      personalTask.id,
      "secret-task",
      "hello there",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  test("sum every deleted project into one ranked row", async () => {
    const chat = await fixture();
    const live = (await createTeam(chat.admin, "research", [chat.memberId])).id;
    const liveChat = await settledChat(chat, live);
    const goneChats: string[] = [];
    const gone: string[] = [];
    for (const name of ["old", "older"]) {
      const id = (await createTeam(chat.admin, name, [chat.memberId])).id;
      gone.push(id);
      goneChats.push(await settledChat(chat, id));
    }
    hide(chat);
    addSend(chat, liveChat, { at: NOW, usage: [{ prompt: 90 }] });
    addSend(chat, goneChats[0]!, { at: NOW, usage: [{ prompt: 50 }] });
    addSend(chat, goneChats[1]!, { at: NOW, usage: [{ prompt: 60 }] });
    for (const id of gone) {
      const res = await chat.admin.call("DELETE", `/api/projects/${id}`);
      expect(res.status).toBe(200);
    }
    const body = await usage(chat);
    expect(body.by.projects).toEqual([
      {
        id: null,
        name: null,
        owner: null,
        deleted: true,
        tokens: 60 + 70,
        cost: null,
        turns: 0,
        runs: 0,
      },
      {
        id: live,
        name: "research",
        owner: null,
        deleted: false,
        tokens: 100,
        cost: null,
        turns: 1,
        runs: 0,
      },
    ]);
    await chat.app.shutdown();
  });

  test("leave out what was deleted and used no tokens", async () => {
    const chat = await fixture();
    const liveChat = await settledChat(chat);
    const goneId = (await createTeam(chat.admin, "old", [chat.memberId])).id;
    const goneChat = await settledChat(chat, goneId);
    hide(chat);
    // turns that failed before a round: sends with no usage
    addSend(chat, liveChat, { at: NOW, status: "failed" });
    addSend(chat, goneChat, { at: NOW, status: "failed" });
    const res = await chat.admin.call("DELETE", `/api/projects/${goneId}`);
    expect(res.status).toBe(200);
    // a live agent without tokens keeps its row
    const live = await usage(chat);
    expect(live.by.agents).toMatchObject([{ tokens: 0, turns: 1 }]);
    expect(live.by.projects).toMatchObject([
      { owner: "casey", deleted: false, tokens: 0, turns: 1 },
    ]);
    const retired = await chat.admin.call(
      "DELETE",
      `/api/agents/${chat.agentId}`,
    );
    expect(retired.status).toBe(200);
    chat.app.now.value += KEEP_MS;
    const body = await usage(chat);
    expect(body.by.agents).toEqual([]);
    expect(body.by.projects.map((row) => row.deleted)).toEqual([false]);
    await chat.app.shutdown();
  });

  test("count a send with several rounds once", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    hide(chat);
    addSend(chat, sessionId, {
      at: NOW,
      rounds: 3,
      usage: [
        { prompt: 100, completion: 10, cost: 0.1 },
        { prompt: 200, completion: 20, cost: 0.2 },
        { prompt: 300, completion: 30 },
      ],
    });
    const body = await usage(chat);
    const row = { tokens: 660, turns: 1, runs: 0 };
    expect(body.by.agents[0]).toMatchObject(row);
    expect(body.by.projects[0]).toMatchObject(row);
    expect(body.totals).toMatchObject({
      turns: 1,
      rounds: 3,
      pricedRounds: 2,
      cost: expect.closeTo(0.3, 10),
    });
  });
});

describe("the usage month", () => {
  test("lays the month's days in the zone up to today", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    hide(chat);
    addSend(chat, sessionId, { at: NOW, usage: [{ prompt: 10 }] });
    addSend(chat, sessionId, {
      at: Date.parse("2026-06-01T00:30:00Z"),
      usage: [{ prompt: 20 }],
    });
    addSend(chat, sessionId, {
      at: Date.parse("2026-05-31T23:30:00Z"),
      usage: [{ prompt: 40 }],
    });
    const utc = await usage(chat);
    expect(utc.month).toBe("2026-06");
    expect(utc.since).toBe(LONG_AGO);
    expect(utc.days).toHaveLength(15);
    expect(utc.days[0]).toMatchObject({ day: "2026-06-01", turns: 1 });
    expect(utc.totals).toMatchObject({ turns: 2, promptTokens: 30 });
    // Bucharest's June starts three hours before UTC's
    const local = await usage(chat, "2026-06", "Europe/Bucharest");
    expect(local.totals).toMatchObject({ turns: 3, promptTokens: 70 });
    const may = await usage(chat, "2026-05");
    expect(may.days).toHaveLength(31);
    expect(may.totals).toMatchObject({ turns: 1, promptTokens: 40 });
    const later = await usage(chat, "2026-07");
    expect(later.days).toEqual([]);
    expect(later.by.projects).toEqual([]);
  });

  test("names the model that answered and its provider, by tokens", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    hide(chat);
    addSend(chat, sessionId, {
      at: NOW,
      model: "openrouter/free",
      rounds: 2,
      usage: [
        { prompt: 100, served: "vendor/picked", cost: 0.25 },
        { prompt: 300, served: "vendor/picked" },
      ],
    });
    addSend(chat, sessionId, { at: NOW, usage: [{ prompt: 50 }] });
    chat.app.db
      .query(
        "update usage set provider_id = 'gone' where created_at = ? and model = ?",
      )
      .run(NOW, FLASH);
    const body = await usage(chat);
    expect(body.by.models).toEqual([
      {
        provider: "local",
        model: "vendor/picked",
        tokens: 420,
        cost: 0.25,
        rounds: 2,
      },
      { provider: null, model: FLASH, tokens: 60, cost: null, rounds: 1 },
    ]);
  });

  test("counts the deciders under their latest name", async () => {
    const chat = await fixture();
    const decision = (
      decider: string,
      name: string,
      at: number,
      cost: number | null,
    ) =>
      chat.app.db
        .query(
          `insert into decision_usage (id, decider_id, decider_name,
             provider_id, provider_name, model, purpose, input_tokens,
             output_tokens, cost, duration, created_at)
           values (?, ?, ?, 'p1', 'router', 'm', 'check', 10, 1, ?, 5, ?)`,
        )
        .run(`d${ids++}`, decider, name, cost, at);
    decision("d1", "judge", NOW - DAY, 0.5);
    decision("d1", "arbiter", NOW, null);
    decision("d2", "second", NOW, null);
    decision("d2", "second", NOW - 60 * DAY, null);
    const body = await usage(chat);
    expect(body.deciders).toEqual([
      { name: "arbiter", decisions: 2, tokens: 22, cost: 0.5 },
      { name: "second", decisions: 1, tokens: 11, cost: null },
    ]);
  });

  test("count the decisions in the model that answered them", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    hide(chat);
    addSend(chat, sessionId, {
      at: NOW,
      usage: [{ prompt: 100, completion: 10, cost: 0.1 }],
    });
    chat.app.db
      .query(
        `insert into decision_usage (id, decider_id, decider_name,
           provider_id, provider_name, model, purpose, input_tokens,
           output_tokens, cost, duration, created_at)
         values ('dm1', 'd1', 'jev', ?, 'local', ?, 'check', 40, 2, null, 5, ?)`,
      )
      .run(chat.providerId, FLASH, NOW);
    const body = await usage(chat);
    expect(body.by.models).toEqual([
      { provider: "local", model: FLASH, tokens: 152, cost: 0.1, rounds: 2 },
    ]);
  });
});

describe("the overview cache", () => {
  test("keeps the days a minute per zone", async () => {
    const app = await testApp();
    const keys: string[] = [];
    const built = overviewArea({
      db: app.db,
      clock: () => app.now.value,
      log: collectLogs().logFactory("overview"),
      limits: { current: () => DEFAULT_LIMITS },
      version: "v0",
      startedAt: 0,
      running: () => IDLE,
      online: () => 0,
      automations: () => ({ total: 0, waiting: 0 }),
      queue: () => ({ queued: 0, notSent: 0, oldestQueuedAt: null }),
      attention: NO_ATTENTION,
      probe: probe([]),
      worker: new URL(
        "../../../src/server/overview/scan.worker.ts",
        import.meta.url,
      ),
      scanner: {
        scan: () => Promise.reject(new Error("not this")),
        month: () => Promise.reject(new Error("not this")),
        range: (input) => {
          keys.push(`${input.since}-${input.until}`);
          return Promise.resolve({
            readAt: input.now,
            ended: { at: [], ms: [] },
            actives: { users: [], slot: [], user: [] },
            sends: [],
            usage: [],
            decisions: [],
            instance: {
              users: 0,
              projects: 0,
              agents: 0,
              automations: 0,
              databaseBytes: 0,
            },
          });
        },
        close() {},
      },
    });
    await built.overview("UTC");
    await built.overview("UTC");
    expect(keys).toHaveLength(1);
    await built.overview("Europe/Berlin");
    expect(keys).toHaveLength(2);
    // a range is its own read, all from the first instant there is
    await built.overview("UTC", "all");
    expect(keys).toHaveLength(3);
    expect(keys[2]!.startsWith("0-")).toBe(true);
    await built.overview("UTC", "all");
    expect(keys).toHaveLength(3);
    keys.splice(2, 1);
    // the parser gives every spelling the canonical name
    const url = "http://x/api/admin/overview?tz=eUrOpE%2FbErLiN";
    const spelled = await built.routes[0]!.handle(new Request(url), {
      url: new URL(url),
    } as never);
    expect(spelled?.status).toBe(200);
    expect(keys).toHaveLength(2);
    // kept for the page's poll period, not the storage scan's minute
    app.now.value += BOARD_KEEP_MS - 1;
    await built.overview("UTC");
    expect(keys).toHaveLength(2);
    app.now.value += 1;
    await built.overview("UTC");
    expect(keys).toHaveLength(3);
    built.close();
    await app.shutdown();
  });
});

// a process that says each reading in turn, the last again after that
function probe(
  readings: Reading[],
  fields: Partial<Omit<Probe, "read">> = {},
): Probe {
  let at = 0;
  return {
    read: () =>
      readings[Math.min(at++, readings.length - 1)] ?? {
        cpuMicros: 0,
        rss: 0,
        ms: 0,
        uptimeMs: 0,
      },
    cores: 4,
    memoryLimit: 1024,
    contained: false,
    ...fields,
  };
}

describe("the load sampler", () => {
  test("shares the CPU since the last sample by the cores", () => {
    let now = 1000;
    const samples = sampler({
      clock: () => now,
      probe: probe([
        // the baseline: startup spent more CPU than wall time, as a
        // process compiling its source does, and is never drawn
        { cpuMicros: 9_000_000, rss: 50, ms: 0, uptimeMs: 800 },
        // 2s of CPU over 4s: half of one of four cores
        { cpuMicros: 11_000_000, rss: 100, ms: 4000, uptimeMs: 4800 },
        // 8s of CPU over 5s on four cores: 40%
        { cpuMicros: 19_000_000, rss: 200, ms: 9000, uptimeMs: 9800 },
        // more than the cores can give is all of them
        { cpuMicros: 49_000_000, rss: 300, ms: 10000, uptimeMs: 10800 },
        // no time passed is none
        { cpuMicros: 49_000_000, rss: 400, ms: 10000, uptimeMs: 10800 },
      ]),
    });
    samples.sample();
    expect(samples.samples()).toEqual({ at: [], cpu: [], rss: [] });
    for (let i = 0; i < 4; i++) {
      now += 5000;
      samples.sample();
    }
    expect(samples.samples()).toEqual({
      at: [6000, 11000, 16000, 21000],
      cpu: [0.125, 0.4, 1, 0],
      rss: [100, 200, 300, 400],
    });
  });

  test("keeps the newest samples up to its size", () => {
    let rss = 0;
    const samples = sampler({
      clock: () => rss,
      probe: {
        ...probe([]),
        read: () => ({ cpuMicros: 0, rss: ++rss, ms: rss, uptimeMs: rss }),
      },
      size: 3,
    });
    for (let i = 0; i < 6; i++) samples.sample();
    expect(samples.samples().rss).toEqual([4, 5, 6]);
    expect(samples.samples().at).toEqual([4, 5, 6]);
  });
});

describe("the load", () => {
  test("is read at each request", async () => {
    const app = await testApp();
    const state = {
      chats: 1,
      runs: 2,
      online: 3,
      total: 4,
      waiting: 1,
      perProject: 0,
    };
    const built = overviewArea({
      db: app.db,
      clock: () => app.now.value,
      log: collectLogs().logFactory("overview"),
      limits: {
        current: () => ({
          ...DEFAULT_LIMITS,
          sendsPerProject: 8,
          sendsRunning: 12,
        }),
      },
      version: "v9.9.9",
      startedAt: 1234,
      running: (perProject) => {
        state.perProject = perProject;
        return {
          chats: state.chats,
          runs: state.runs,
          scheduled: 1,
          projectsFull: 1,
        };
      },
      online: () => state.online,
      automations: () => ({ total: state.total, waiting: state.waiting }),
      queue: () => ({ queued: 2, notSent: 1, oldestQueuedAt: 500 }),
      attention: NO_ATTENTION,
      probe: probe(
        [{ cpuMicros: 1_000_000, rss: 512, ms: 0, uptimeMs: 1000 }],
        { cores: 2, memoryLimit: 2048, contained: true },
      ),
      worker: new URL(
        "../../../src/server/overview/scan.worker.ts",
        import.meta.url,
      ),
    });
    expect(built.load()).toEqual({
      at: app.now.value,
      chats: 1,
      runs: 2,
      cap: 12,
      scheduled: 1,
      scheduledCap: 9,
      projectsFull: 1,
      online: 3,
      automations: 4,
      waiting: 1,
      queued: 2,
      notSent: 1,
      oldestQueuedAt: 500,
      cores: 2,
      memoryLimit: 2048,
      contained: true,
      samples: { at: [], cpu: [], rss: [] },
    });
    expect(state.perProject).toBe(8);
    state.chats = 0;
    state.waiting = 0;
    expect(built.load()).toMatchObject({ chats: 0, waiting: 0 });
    built.close();
    await app.shutdown();
  });

  test("samples on its timer only once started, until closed", async () => {
    const app = await testApp();
    const ticks: (() => void)[] = [];
    let stopped = 0;
    let rss = 0;
    const built = overviewArea({
      db: app.db,
      clock: () => app.now.value,
      log: collectLogs().logFactory("overview"),
      limits: { current: () => DEFAULT_LIMITS },
      version: "v0",
      startedAt: 0,
      running: () => IDLE,
      online: () => 0,
      automations: () => ({ total: 0, waiting: 0 }),
      queue: () => ({ queued: 0, notSent: 0, oldestQueuedAt: null }),
      attention: NO_ATTENTION,
      probe: {
        ...probe([]),
        read: () => ({ cpuMicros: 0, rss: ++rss, ms: rss, uptimeMs: rss }),
      },
      every: (ms, tick) => {
        expect(ms).toBe(5_000);
        ticks.push(tick);
        return () => {
          stopped++;
        };
      },
      worker: new URL(
        "../../../src/server/overview/scan.worker.ts",
        import.meta.url,
      ),
    });
    // the baseline is read at once, the loop waits for start()
    expect(built.load().samples.rss).toEqual([]);
    expect(ticks).toHaveLength(0);
    built.start();
    built.start();
    expect(ticks).toHaveLength(1);
    ticks[0]!();
    expect(built.load().samples.rss).toEqual([2]);
    built.close();
    expect(stopped).toBe(1);
    await app.shutdown();
  });

  test("reads the pools, the sockets and the automations through the app", async () => {
    const chat = await fixture();
    const { sessionId } = await startChat(chat);
    const waiting = await createAutomation(chat, { name: "late" });
    await createAutomation(chat, { name: "later" });
    const suspended = await createAutomation(chat, { name: "off" });
    chat.app.db
      .query("update automations set next_at = ? where id = ?")
      .run(NOW - 60_000, waiting.id);
    chat.app.db
      .query(
        "update automations set suspended_at = ?, next_at = null where id = ?",
      )
      .run(NOW, suspended.id);
    const body = await load(chat);
    expect(body).toMatchObject({
      at: NOW,
      chats: 1,
      runs: 0,
      online: 0,
      automations: 3,
      waiting: 1,
      cap: DEFAULT_LIMITS.sendsRunning,
      scheduled: 0,
      scheduledCap: 48,
      projectsFull: 0,
    });
    expect(body.cores).toBeGreaterThan(0);
    expect(body.memoryLimit).toBeGreaterThan(0);
    // the baseline alone until the timer takes the first sample
    expect(body.samples.cpu).toHaveLength(body.samples.at.length);
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await settleRun(chat, sessionId);
  });
});
