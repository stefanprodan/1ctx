// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The overview answer over a composed app: the parser, the days of a
// zone across a DST change, the totals and the range before, cost
// coverage, each breakdown over a fixture with a team and a personal
// project and their tasks, a send with several rounds counted once, the
// models' medians without a running send, the cache per zone and range,
// and the pools read at each request.

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  KEEP_MS,
  overviewArea,
  parseOverviewQuery,
} from "../../../src/server/overview/index.ts";
import type {
  OverviewRange,
  OverviewResponse,
} from "../../../src/shared/api/admin.ts";
import { collectLogs, testApp } from "../../helpers/app.ts";
import {
  automationBody,
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import { type ChatApp, chatApp, FLASH, startChat } from "../../helpers/chat.ts";

const NOW = Date.parse("2026-06-15T12:00:00Z");
const DAY = 86_400_000;
const LONG_AGO = Date.parse("2020-01-01T00:00:00Z");

async function overview(
  chat: ChatApp,
  days: OverviewRange = 7,
  tz = "UTC",
): Promise<OverviewResponse> {
  const res = await chat.admin.call(
    "GET",
    `/api/admin/overview?tz=${encodeURIComponent(tz)}&days=${days}`,
  );
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

async function team(chat: ChatApp, name: string): Promise<string> {
  const res = await chat.admin.call("POST", "/api/projects", {
    body: { name },
  });
  expect(res.status).toBe(201);
  const { project } = await res.json();
  const added = await chat.admin.call(
    "POST",
    `/api/projects/${project.id}/members`,
    { body: { userId: chat.memberId } },
  );
  expect(added.status).toBe(201);
  return project.id as string;
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
    .query<{ projectId: string; ownerId: string; agentId: string }, [string]>(
      "select project_id as projectId, owner_id as ownerId, agent_id as agentId from sessions where id = ?",
    )
    .get(sessionId)!;
  const id = `send-${++ids}`;
  const status = fields.status ?? "done";
  db.query(
    `insert into sends (id, session_id, kind, user_id, agent_id, provider_id,
       model, status, first_message_id, rounds, started_at, finished_at)
     values (?, ?, 'chat', ?, ?, ?, ?, ?, 'm', ?, ?, ?)`,
  ).run(
    id,
    sessionId,
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
         completion_tokens, cached_tokens, cost, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
  });
  return id;
}

describe("the overview query", () => {
  const parse = (query: string) =>
    parseOverviewQuery(new URL(`http://x/api/admin/overview${query}`));

  test("takes a zone and a range, once each", () => {
    expect(parse("?tz=Europe%2FBerlin&days=30")).toEqual({
      timeZone: "Europe/Berlin",
      days: 30,
    });
    expect(parse("?days=7&tz=UTC").days).toBe(7);
    expect(parse("?tz=UTC&days=90").days).toBe(90);
  });

  test("gives the zone its canonical name", () => {
    expect(parse("?tz=eUrOpE%2FbErLiN&days=7").timeZone).toBe("Europe/Berlin");
    expect(parse("?tz=utc&days=7").timeZone).toBe("UTC");
  });

  test("refuses anything else", () => {
    for (const query of [
      "",
      "?tz=UTC",
      "?days=7",
      "?tz=UTC&days=8",
      "?tz=UTC&days=",
      "?tz=UTC&days=07",
      "?tz=UTC&days=7&days=30",
      "?tz=UTC&tz=UTC&days=7",
      "?tz=Mars%2FOlympus&days=7",
      "?tz=UTC&days=7&x=1",
    ]) {
      expect(() => parse(query), query).toThrow();
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
    const body = await overview(chat, 7, "Europe/Berlin");
    expect(body.days.map((day) => day.day)).toEqual([
      "2026-03-25",
      "2026-03-26",
      "2026-03-27",
      "2026-03-28",
      "2026-03-29",
      "2026-03-30",
      "2026-03-31",
    ]);
    const byDay = Object.fromEntries(body.days.map((day) => [day.day, day]));
    expect(byDay["2026-03-29"]).toMatchObject({
      start: Date.parse("2026-03-28T23:00:00Z"),
      sends: 2,
      failed: 1,
    });
    expect(byDay["2026-03-30"]).toMatchObject({
      start: Date.parse("2026-03-29T22:00:00Z"),
      sends: 1,
      failed: 0,
    });
    expect(byDay["2026-03-28"]?.sends).toBe(0);
    expect(body.totals).toMatchObject({ sends: 3, failed: 1 });
    const utc = await overview(chat, 7, "UTC");
    expect(utc.days.find((day) => day.day === "2026-03-28")?.sends).toBe(1);
  });

  test("sum the range and the same number of days before it", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    hide(chat);
    // today, the first day of the range, the last day before it, the
    // first day before it, and one past both
    const tokens = (prompt: number, completion: number, at: number) => ({
      prompt,
      completion,
      at,
    });
    addSend(chat, sessionId, {
      at: NOW,
      usage: [tokens(100, 10, NOW), tokens(200, 20, NOW)],
      rounds: 2,
    });
    addSend(chat, sessionId, {
      at: NOW - 6 * DAY,
      usage: [tokens(300, 30, NOW - 6 * DAY)],
    });
    addSend(chat, sessionId, {
      at: NOW - 7 * DAY,
      status: "failed",
      usage: [tokens(1000, 100, NOW - 7 * DAY)],
    });
    addSend(chat, sessionId, {
      at: NOW - 13 * DAY,
      usage: [tokens(2000, 200, NOW - 13 * DAY)],
    });
    addSend(chat, sessionId, {
      at: NOW - 14 * DAY,
      usage: [tokens(5000, 500, NOW - 14 * DAY)],
    });
    const body = await overview(chat, 7);
    expect(body.readAt).toBe(NOW);
    expect(body.days).toHaveLength(7);
    expect(body.days.at(-1)).toEqual({
      day: "2026-06-15",
      start: Date.parse("2026-06-15T00:00:00Z"),
      sends: 1,
      failed: 0,
      promptTokens: 300,
      cachedTokens: 0,
      completionTokens: 30,
    });
    expect(body.totals).toEqual({
      sends: 2,
      failed: 0,
      promptTokens: 600,
      cachedTokens: 0,
      completionTokens: 60,
      rounds: 3,
      pricedRounds: 0,
      cost: null,
    });
    expect(body.before).toEqual({
      sends: 2,
      failed: 1,
      promptTokens: 3000,
      cachedTokens: 0,
      completionTokens: 300,
      rounds: 2,
      pricedRounds: 0,
      cost: null,
    });
    const wide = await overview(chat, 30);
    expect(wide.totals.sends).toBe(5);
    expect(wide.before.sends).toBe(0);
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
    const body = await overview(chat);
    expect(body.totals).toMatchObject({
      rounds: 3,
      pricedRounds: 2,
      cost: 0.75,
      cachedTokens: 40,
    });
    expect(body.days.at(-1)?.cachedTokens).toBe(40);
    expect(body.by.users[0]).toMatchObject({ name: "casey", cost: 0.75 });
  });
});

describe("the overview breakdowns", () => {
  test("name a team project and its task, never a personal one", async () => {
    const chat = await fixture();
    const teamId = await team(chat, "research");
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
    const body = await overview(chat);
    expect(body.by.users).toEqual([
      {
        id: chat.memberId,
        name: "casey",
        owner: null,
        sub: null,
        tokens: 150 + 40,
        sends: 4,
        failed: 1,
        cost: null,
      },
    ]);
    expect(body.by.agents).toEqual([
      {
        id: chat.agentId,
        name: "coder",
        owner: null,
        sub: null,
        tokens: 190,
        sends: 4,
        failed: 1,
        cost: null,
      },
    ]);
    expect(body.by.models).toEqual([
      {
        id: null,
        name: FLASH,
        owner: null,
        sub: "local",
        tokens: 190,
        sends: 4,
        failed: 1,
        cost: null,
      },
    ]);
    expect(body.by.projects).toEqual([
      {
        id: teamId,
        name: "research",
        owner: null,
        sub: null,
        tokens: 110 + 20,
        sends: 2,
        failed: 1,
        cost: null,
      },
      {
        id: null,
        name: null,
        owner: "casey",
        sub: null,
        tokens: 60,
        sends: 2,
        failed: 0,
        cost: null,
      },
    ]);
    expect(body.by.tasks).toEqual([
      {
        id: teamTask.id,
        name: "digest",
        owner: null,
        sub: "research",
        tokens: 100,
        sends: 1,
        failed: 0,
        cost: null,
      },
      {
        id: null,
        name: null,
        owner: "casey",
        sub: null,
        tokens: 40,
        sends: 1,
        failed: 0,
        cost: null,
      },
    ]);
    expect(body.instance).toMatchObject({
      version: "v0.0.0-test",
      users: 2,
      projects: 1,
      agents: 1,
      tasks: 2,
      servers: 0,
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

  test("count a send with several rounds once", async () => {
    const chat = await fixture();
    const task = await createAutomation(chat);
    const runId = await runOf(chat, task.id);
    hide(chat);
    addSend(chat, runId, {
      at: NOW,
      rounds: 3,
      usage: [
        { prompt: 100, completion: 10, cost: 0.1 },
        { prompt: 200, completion: 20, cost: 0.2 },
        { prompt: 300, completion: 30 },
      ],
    });
    const body = await overview(chat);
    const row = {
      tokens: 660,
      sends: 1,
      failed: 0,
      cost: expect.closeTo(0.3, 10),
    };
    expect(body.by.users[0]).toMatchObject(row);
    expect(body.by.agents[0]).toMatchObject(row);
    expect(body.by.models[0]).toMatchObject(row);
    expect(body.by.projects[0]).toMatchObject(row);
    expect(body.by.tasks[0]).toMatchObject(row);
    expect(body.totals).toMatchObject({
      sends: 1,
      rounds: 3,
      pricedRounds: 2,
      cost: expect.closeTo(0.3, 10),
    });
    expect(body.models[0]).toMatchObject({ sends: 1, medianRounds: 3 });
  });

  test("leave out rows with nothing and keep the ten largest", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    hide(chat);
    for (let i = 1; i <= 12; i++) {
      addSend(chat, sessionId, {
        at: NOW,
        model: `model-${i}`,
        usage: [{ prompt: i * 10, completion: 0 }],
      });
    }
    addSend(chat, sessionId, { at: NOW, model: "no-tokens" });
    const body = await overview(chat);
    expect(body.by.models).toHaveLength(10);
    expect(body.by.models.map((row) => row.name)).toEqual([
      "model-12",
      "model-11",
      "model-10",
      "model-9",
      "model-8",
      "model-7",
      "model-6",
      "model-5",
      "model-4",
      "model-3",
    ]);
    // a send without tokens is still a row; the admin, with none, is not
    expect(body.by.users.map((row) => row.name)).toEqual(["casey"]);
    expect(body.by.users[0]?.sends).toBe(13);
    expect(body.models).toHaveLength(10);
  });
});

describe("the overview models", () => {
  test("give medians over the ended sends and count the running one", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    hide(chat);
    const at = NOW - DAY;
    addSend(chat, sessionId, { at, finishedAt: at + 100, rounds: 1 });
    addSend(chat, sessionId, {
      at,
      finishedAt: at + 300,
      rounds: 4,
      status: "failed",
    });
    addSend(chat, sessionId, { at, finishedAt: at + 200, rounds: 2 });
    addSend(chat, sessionId, { at, finishedAt: at + 900, rounds: 3 });
    addSend(chat, sessionId, { at: NOW, status: "running", rounds: 9 });
    addSend(chat, sessionId, { at, model: "other", finishedAt: at + 50 });
    const body = await overview(chat);
    expect(body.models).toEqual([
      {
        provider: "local",
        model: FLASH,
        sends: 5,
        failed: 1,
        medianMs: 250,
        slowestMs: 900,
        medianRounds: 3,
      },
      {
        provider: "local",
        model: "other",
        sends: 1,
        failed: 0,
        medianMs: 50,
        slowestMs: 50,
        medianRounds: 1,
      },
    ]);
  });

  test("read a send the clock stepped back on as zero long", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    hide(chat);
    addSend(chat, sessionId, { at: NOW, finishedAt: NOW - 5_000 });
    addSend(chat, sessionId, { at: NOW, finishedAt: NOW + 400 });
    const body = await overview(chat);
    expect(body.models[0]).toMatchObject({
      sends: 2,
      medianMs: 200,
      slowestMs: 400,
    });
  });

  test("say null for a model whose sends all run", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    hide(chat);
    addSend(chat, sessionId, { at: NOW, status: "running" });
    const body = await overview(chat);
    expect(body.models[0]).toMatchObject({
      sends: 1,
      medianMs: null,
      slowestMs: null,
      medianRounds: null,
    });
  });
});

describe("the overview now", () => {
  const area = async (state: {
    chats: number;
    runs: number;
    online: number;
  }) => {
    const app = await testApp();
    let reads = 0;
    const built = overviewArea({
      db: app.db,
      clock: () => app.now.value,
      log: collectLogs().logFactory("overview"),
      limits: { current: () => ({ ...DEFAULT_LIMITS, runsRunning: 12 }) },
      version: "v9.9.9",
      startedAt: 1234,
      pools: () => {
        reads++;
        return { chats: state.chats, chatsCap: 32, runs: state.runs };
      },
      online: () => state.online,
      worker: new URL(
        "../../../src/server/overview/scan.worker.ts",
        import.meta.url,
      ),
    });
    return { app, built, reads: () => reads };
  };

  test("is read at each request while the range is kept", async () => {
    const state = { chats: 1, runs: 2, online: 3 };
    const { app, built, reads } = await area(state);
    const first = await built.overview("UTC", 7);
    expect(first.now).toEqual({
      chats: 1,
      chatsCap: 32,
      runs: 2,
      runsCap: 12,
      online: 3,
    });
    expect(first.instance).toMatchObject({
      version: "v9.9.9",
      startedAt: 1234,
      users: 1,
    });
    state.chats = 0;
    state.runs = 5;
    state.online = 1;
    const second = await built.overview("UTC", 7);
    expect(second.now).toMatchObject({ chats: 0, runs: 5, online: 1 });
    expect(second.readAt).toBe(first.readAt);
    expect(reads()).toBe(2);
    await app.shutdown();
  });

  test("keeps the range a minute per zone and range", async () => {
    const app = await testApp();
    const keys: string[] = [];
    const built = overviewArea({
      db: app.db,
      clock: () => app.now.value,
      log: collectLogs().logFactory("overview"),
      limits: { current: () => DEFAULT_LIMITS },
      version: "v0",
      startedAt: 0,
      pools: () => ({ chats: 0, chatsCap: 32, runs: 0 }),
      online: () => 0,
      worker: new URL(
        "../../../src/server/overview/scan.worker.ts",
        import.meta.url,
      ),
      scanner: {
        scan: () => Promise.reject(new Error("not this")),
        range: (input) => {
          keys.push(`${input.rangeSince}-${input.until}`);
          return Promise.resolve({
            readAt: input.now,
            sends: [],
            usage: [],
            by: { users: [], agents: [], models: [], projects: [], tasks: [] },
            models: [],
            instance: {
              users: 0,
              projects: 0,
              agents: 0,
              tasks: 0,
              servers: 0,
              databaseBytes: 0,
            },
          });
        },
        close() {},
      },
    });
    await built.overview("UTC", 7);
    await built.overview("UTC", 7);
    expect(keys).toHaveLength(1);
    await built.overview("UTC", 30);
    expect(keys).toHaveLength(2);
    await built.overview("Europe/Berlin", 7);
    expect(keys).toHaveLength(3);
    // the parser gives every spelling the canonical name
    const spelled = await built.routes[0]!.handle(
      new Request("http://x/api/admin/overview?tz=eUrOpE%2FbErLiN&days=7"),
      {
        url: new URL("http://x/api/admin/overview?tz=eUrOpE%2FbErLiN&days=7"),
      } as never,
    );
    expect(spelled?.status).toBe(200);
    expect(keys).toHaveLength(3);
    app.now.value += KEEP_MS;
    await built.overview("UTC", 7);
    expect(keys).toHaveLength(4);
    await app.shutdown();
  });

  test("reads the runner's pools and the sockets through the app", async () => {
    const chat = await fixture();
    const { sessionId } = await startChat(chat);
    const body = await overview(chat);
    expect(body.now).toMatchObject({ chats: 1, runs: 0, online: 0 });
    expect(body.now.chatsCap).toBeGreaterThan(0);
    expect(body.now.runsCap).toBe(DEFAULT_LIMITS.runsRunning);
    expect(body.instance.startedAt).toBeLessThanOrEqual(NOW);
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await settleRun(chat, sessionId);
  });
});
