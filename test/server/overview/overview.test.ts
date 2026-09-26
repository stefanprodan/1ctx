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
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  KEEP_MS,
  overviewArea,
  type Probe,
  parseLoadQuery,
  parseZoneQuery,
  type Reading,
  sampler,
} from "../../../src/server/overview/index.ts";
import type {
  LoadResponse,
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

async function overview(chat: ChatApp, tz = "UTC"): Promise<OverviewResponse> {
  const res = await chat.admin.call(
    "GET",
    `/api/admin/overview?tz=${encodeURIComponent(tz)}`,
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
    parseZoneQuery(new URL(`http://x/api/admin/overview${query}`));
  const loadQuery = (query: string) =>
    parseLoadQuery(new URL(`http://x/api/admin/load${query}`));

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
});

describe("the overview all time", () => {
  test("counts every send and round since the first", async () => {
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
    addSend(chat, runId, { at: NOW - 400 * DAY, usage: [{ prompt: 20 }] });
    const body = await overview(chat);
    // the two real sends moved long ago, and the two above
    expect(body.all).toMatchObject({
      turns: 2,
      turnsFailed: 1,
      runs: 2,
      runsFailed: 0,
      cachedTokens: 4,
      pricedRounds: 1,
      cost: 0.1,
      since: LONG_AGO,
    });
    expect(body.all.rounds).toBeGreaterThanOrEqual(2);
    expect(body.totals.turns).toBe(1);
    expect(body.totals.runs).toBe(0);
  });

  test("is empty with no send", async () => {
    const app = await testApp();
    const admin = app.client();
    await admin.login("admin", "hunter2-test");
    const res = await admin.call("GET", "/api/admin/overview?tz=UTC");
    const body: OverviewResponse = await res.json();
    expect(body.all).toEqual({
      turns: 0,
      turnsFailed: 0,
      runs: 0,
      runsFailed: 0,
      promptTokens: 0,
      cachedTokens: 0,
      completionTokens: 0,
      rounds: 0,
      pricedRounds: 0,
      cost: null,
      since: null,
    });
    expect(body.days.every((day) => day.turns === 0 && day.cost === null)).toBe(
      true,
    );
    expect(body.lengths).toEqual([]);
    await app.shutdown();
  });
});

describe("the overview breakdowns", () => {
  test("name a team project, never a personal one", async () => {
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
    expect(body.by.agents).toEqual([
      {
        id: chat.agentId,
        name: "coder",
        owner: null,
        deleted: false,
        tokens: 190,
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
        turns: 1,
        runs: 1,
      },
      {
        id: null,
        name: null,
        owner: "casey",
        deleted: false,
        tokens: 60,
        turns: 1,
        runs: 1,
      },
    ]);
    expect(body.instance).toMatchObject({
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
    const live = await team(chat, "research");
    const liveChat = await settledChat(chat, live);
    const goneChats: string[] = [];
    const gone: string[] = [];
    for (const name of ["old", "older"]) {
      const id = await team(chat, name);
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
    const body = await overview(chat);
    expect(body.by.projects).toEqual([
      {
        id: null,
        name: null,
        owner: null,
        deleted: true,
        tokens: 60 + 70,
        turns: 0,
        runs: 0,
      },
      {
        id: live,
        name: "research",
        owner: null,
        deleted: false,
        tokens: 100,
        turns: 1,
        runs: 0,
      },
    ]);
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
    const body = await overview(chat);
    const row = { tokens: 660, turns: 1, runs: 0 };
    expect(body.by.agents[0]).toMatchObject(row);
    expect(body.by.projects[0]).toMatchObject(row);
    expect(body.totals).toMatchObject({
      turns: 1,
      rounds: 3,
      pricedRounds: 2,
      cost: expect.closeTo(0.3, 10),
    });
    expect(body.lengths[0]).toMatchObject({ turns: 1 });
  });
});

describe("the overview turn lengths", () => {
  test("give medians over the ended turns and count the running one", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    const task = await createAutomation(chat);
    const runId = await runOf(chat, task.id);
    hide(chat);
    const at = NOW - DAY;
    addSend(chat, sessionId, { at, finishedAt: at + 100 });
    addSend(chat, sessionId, {
      at,
      finishedAt: at + 300,
      status: "failed",
    });
    addSend(chat, sessionId, { at, finishedAt: at + 200 });
    addSend(chat, sessionId, { at, finishedAt: at + 900 });
    addSend(chat, sessionId, { at: NOW, status: "running" });
    addSend(chat, sessionId, { at, model: "other", finishedAt: at + 50 });
    // a run is its task's length, never the model's
    addSend(chat, runId, { at, finishedAt: at + 99_000 });
    addSend(chat, runId, { at, model: "runs-only", finishedAt: at + 10 });
    const body = await overview(chat);
    expect(body.lengths).toEqual([
      {
        provider: "local",
        model: FLASH,
        turns: 5,
        medianMs: 250,
        slowestMs: 900,
      },
      {
        provider: "local",
        model: "other",
        turns: 1,
        medianMs: 50,
        slowestMs: 50,
      },
    ]);
  });

  test("read a turn the clock stepped back on as zero long", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    hide(chat);
    addSend(chat, sessionId, { at: NOW, finishedAt: NOW - 5_000 });
    addSend(chat, sessionId, { at: NOW, finishedAt: NOW + 400 });
    const body = await overview(chat);
    expect(body.lengths[0]).toMatchObject({
      turns: 2,
      medianMs: 200,
      slowestMs: 400,
    });
  });

  test("say null for a model whose turns all run", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    hide(chat);
    addSend(chat, sessionId, { at: NOW, status: "running" });
    const body = await overview(chat);
    expect(body.lengths).toEqual([
      {
        provider: "local",
        model: FLASH,
        turns: 1,
        medianMs: null,
        slowestMs: null,
      },
    ]);
  });

  test("keep the ten models with the most turns", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    hide(chat);
    for (let i = 1; i <= 12; i++) {
      for (let n = 0; n < i; n++) {
        addSend(chat, sessionId, { at: NOW, model: `model-${i}` });
      }
    }
    const body = await overview(chat);
    expect(body.lengths.map((row) => row.model)).toEqual(
      [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((i) => `model-${i}`),
    );
  });

  test("count a router's turns under the model its last round said answered", async () => {
    const chat = await fixture();
    const sessionId = await settledChat(chat);
    hide(chat);
    const router = "openrouter/free";
    for (let n = 0; n < 3; n++) {
      addSend(chat, sessionId, {
        at: NOW,
        model: router,
        rounds: 2,
        usage: [{ served: "vendor/first-pick" }, { served: "vendor/picked" }],
      });
    }
    addSend(chat, sessionId, {
      at: NOW,
      model: router,
      usage: [{ served: "vendor/other" }],
    });
    // no usage row, or none that said: the model asked for
    addSend(chat, sessionId, { at: NOW, model: router });
    addSend(chat, sessionId, { at: NOW, model: router, usage: [{}] });
    // an earlier round's pick says nothing about a last round without
    // usage, as a stopped one has
    addSend(chat, sessionId, {
      at: NOW,
      model: router,
      rounds: 2,
      usage: [{ served: "vendor/first-pick" }],
    });
    const body = await overview(chat);
    expect(body.lengths.map((row) => [row.model, row.turns])).toEqual([
      // a tie goes by name
      [router, 3],
      ["vendor/picked", 3],
      ["vendor/other", 1],
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
      pools: () => ({ chats: 0, chatsCap: 32, runs: 0 }),
      online: () => 0,
      automations: () => ({ total: 0, waiting: 0 }),
      probe: probe([]),
      worker: new URL(
        "../../../src/server/overview/scan.worker.ts",
        import.meta.url,
      ),
      scanner: {
        scan: () => Promise.reject(new Error("not this")),
        range: (input) => {
          keys.push(`${input.since}-${input.until}`);
          return Promise.resolve({
            readAt: input.now,
            sends: [],
            usage: [],
            by: { agents: [], projects: [] },
            models: [],
            all: {
              turns: 0,
              turnsFailed: 0,
              runs: 0,
              runsFailed: 0,
              prompt: 0,
              cached: 0,
              completion: 0,
              rounds: 0,
              priced: 0,
              cost: null,
              since: null,
            },
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
    // the parser gives every spelling the canonical name
    const url = "http://x/api/admin/overview?tz=eUrOpE%2FbErLiN";
    const spelled = await built.routes[0]!.handle(new Request(url), {
      url: new URL(url),
    } as never);
    expect(spelled?.status).toBe(200);
    expect(keys).toHaveLength(2);
    app.now.value += KEEP_MS;
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
        // 2s of CPU over the first 4s of life: half of one of four cores
        { cpuMicros: 2_000_000, rss: 100, ms: 50, uptimeMs: 4000 },
        // 8s of CPU over 5s on four cores: 40%
        { cpuMicros: 10_000_000, rss: 200, ms: 5050, uptimeMs: 9000 },
        // more than the cores can give is all of them
        { cpuMicros: 40_000_000, rss: 300, ms: 6050, uptimeMs: 10000 },
        // no time passed is none
        { cpuMicros: 40_000_000, rss: 400, ms: 6050, uptimeMs: 10000 },
      ]),
    });
    for (let i = 0; i < 4; i++) {
      samples.sample();
      now += 5000;
    }
    expect(samples.samples()).toEqual({
      at: [1000, 6000, 11000, 16000],
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
    for (let i = 0; i < 5; i++) samples.sample();
    expect(samples.samples().rss).toEqual([3, 4, 5]);
    expect(samples.samples().at).toEqual([3, 4, 5]);
  });
});

describe("the load", () => {
  test("is read at each request", async () => {
    const app = await testApp();
    const state = { chats: 1, runs: 2, online: 3, total: 4, waiting: 1 };
    const built = overviewArea({
      db: app.db,
      clock: () => app.now.value,
      log: collectLogs().logFactory("overview"),
      limits: { current: () => ({ ...DEFAULT_LIMITS, runsRunning: 12 }) },
      version: "v9.9.9",
      startedAt: 1234,
      pools: () => ({ chats: state.chats, chatsCap: 32, runs: state.runs }),
      online: () => state.online,
      automations: () => ({ total: state.total, waiting: state.waiting }),
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
      chatsCap: 32,
      runs: 2,
      runsCap: 12,
      online: 3,
      automations: 4,
      waiting: 1,
      cores: 2,
      memoryLimit: 2048,
      contained: true,
      samples: { at: [app.now.value], cpu: [0.5], rss: [512] },
    });
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
      pools: () => ({ chats: 0, chatsCap: 32, runs: 0 }),
      online: () => 0,
      automations: () => ({ total: 0, waiting: 0 }),
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
    // the first sample is taken at once, the loop waits for start()
    expect(built.load().samples.rss).toEqual([1]);
    expect(ticks).toHaveLength(0);
    built.start();
    built.start();
    expect(ticks).toHaveLength(1);
    ticks[0]!();
    expect(built.load().samples.rss).toEqual([1, 2]);
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
      runsCap: DEFAULT_LIMITS.runsRunning,
    });
    expect(body.chatsCap).toBeGreaterThan(0);
    expect(body.cores).toBeGreaterThan(0);
    expect(body.memoryLimit).toBeGreaterThan(0);
    expect(body.samples.cpu.length).toBeGreaterThanOrEqual(1);
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await settleRun(chat, sessionId);
  });
});
