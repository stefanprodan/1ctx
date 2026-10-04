// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A round asks a busy or unreachable provider again: through the whole
// app with the scripted provider, and through runRound alone for what
// the scripted fetch cannot make, a headers wait that ran out.

import { describe, expect, test } from "bun:test";
import type { WorkNode } from "../../../src/client/transcript/rows.ts";
import { groupRows } from "../../../src/client/transcript/rows.ts";
import { workSummary } from "../../../src/client/transcript/Work.model.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import type {
  ChatEvent,
  ChatRequest,
} from "../../../src/server/providers/index.ts";
import { providerFor } from "../../../src/server/providers/provider.ts";
import {
  REFUSED,
  type RoundDeps,
  runRound,
  STREAM_IDLE_MS,
} from "../../../src/server/runner/round.ts";
import type { ActiveSend } from "../../../src/server/runner/send.ts";
import type {
  LiveRetry,
  SessionDetail,
} from "../../../src/shared/contracts/session.ts";
import { collectLogs } from "../../helpers/app.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  setLimits,
  startChat,
  tick,
  waitScript,
} from "../../helpers/chat.ts";
import { frames, watch, watcher } from "../../helpers/socket.ts";

const BUSY = '{"error":{"message":"busy"}}';

async function post(chat: ChatApp) {
  const res = await chat.member.call("POST", "/api/sessions", {
    body: { projectId: chat.projectId, agentId: chat.agentId, message: "x" },
  });
  expect(res.status).toBe(201);
  const { session, send } = await res.json();
  await tick();
  return { sessionId: session.id as string, sendId: send.id as string };
}

// past the longest backoff with its jitter
async function advance(chat: ChatApp, ms = 5000) {
  await tick();
  chat.app.now.value += ms;
  await tick();
  await tick();
}

describe("provider retries through a turn", () => {
  test("a 503 then an answer finishes the turn with one warning", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    chat.scripted.refuse(503, BUSY, { times: 1 });
    const { sendId, sessionId } = await post(chat);
    expect(chat.scripted.chats()).toBe(1);
    await advance(chat);
    (await waitScript(chat.scripted, 1)).reply("hello");
    await tick();
    await tick();
    expect(chat.scripted.chats()).toBe(2);
    expect(chat.app.sessions.send(sendId)!.status).toBe("done");
    // the first token is timed from the round's start, the wait
    // included, and the finished fold says how long the turn took
    const reply = chat.app.sessions
      .messages(sessionId)
      .find((row) => row.kind === "reply")!;
    expect(reply.ttftMs).toBe(5000);
    const detail: SessionDetail = await (
      await chat.member.call("GET", `/api/sessions/${sessionId}`)
    ).json();
    const turn = groupRows(detail.messages, detail.send).find(
      (node) => node.kind === "reply",
    )!;
    if (turn.kind !== "reply") throw new Error("no reply node");
    const work: WorkNode = turn.work ?? {
      sendId: turn.sendId,
      rows: [],
      rounds: [],
      answer: turn.message,
      send: turn.send,
    };
    expect(workSummary(work, false).text).toBe("Worked for 5.0 s");
    const retried = logs.events.filter((e) => e.msg === "round retried");
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ level: "warn", area: "runner" });
    expect(retried[0]!.fields).toEqual({
      chat: sessionId,
      round: 1,
      attempt: 1,
      provider_status: 503,
      wait: expect.any(Number),
    });
    const wait = retried[0]!.fields.wait as number;
    expect(wait).toBeGreaterThanOrEqual(1000);
    expect(wait).toBeLessThanOrEqual(1250);
  });

  test.each([
    [429, BUSY],
    [500, "down"],
    [502, "bad gateway"],
    [503, BUSY],
    [504, "timeout"],
  ])(
    "four refusals (%i) fail the turn with the last words",
    async (status, body) => {
      const logs = collectLogs();
      const chat = await chatApp({ logFactory: logs.logFactory });
      chat.scripted.refuse(status, body);
      const { sendId, sessionId } = await post(chat);
      for (let i = 0; i < 3; i++) await advance(chat);
      await tick();
      expect(chat.scripted.chats()).toBe(4);
      expect(chat.app.sessions.send(sendId)!).toMatchObject({
        status: "failed",
        cause: "failure",
        error: `HTTP ${status}: ${body}`,
      });
      expect(chat.app.sessions.byId(sessionId)!.status).toBe("failed");
      const attempts = logs.events
        .filter((e) => e.msg === "round retried")
        .map((e) => e.fields.attempt);
      expect(attempts).toEqual([1, 2, 3]);
    },
  );

  test("a 429 with Retry-After waits at least that long on the clock", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    chat.scripted.refuse(429, BUSY, {
      times: 1,
      headers: { "retry-after": "2" },
    });
    const { sendId } = await post(chat);
    await tick();
    chat.app.now.value += 1999;
    await tick();
    expect(chat.scripted.chats()).toBe(1);
    // the jitter rides on top of the asked wait
    chat.app.now.value += 501;
    (await waitScript(chat.scripted, 1)).reply("hello");
    await tick();
    await tick();
    expect(chat.scripted.chats()).toBe(2);
    expect(chat.app.sessions.send(sendId)!.status).toBe("done");
    const fields = logs.events.find((e) => e.msg === "round retried")!.fields;
    expect(fields).toMatchObject({ provider_status: 429 });
    expect(fields.wait as number).toBeGreaterThanOrEqual(2000);
    expect(fields.wait as number).toBeLessThanOrEqual(2500);
  });

  test("a Retry-After past 30 s fails the turn at once", async () => {
    const chat = await chatApp();
    chat.scripted.refuse(429, BUSY, { headers: { "retry-after": "31" } });
    const { sendId } = await post(chat);
    await tick();
    expect(chat.scripted.chats()).toBe(1);
    expect(chat.app.sessions.send(sendId)!).toMatchObject({
      status: "failed",
      error: `HTTP 429: ${BUSY}`,
    });
  });

  test("Stop during a wait ends the turn at once", async () => {
    const chat = await chatApp();
    chat.scripted.refuse(503, BUSY);
    const { sendId, sessionId } = await post(chat);
    await tick();
    const stop = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/stop`,
    );
    expect(stop.status).toBe(200);
    await tick();
    await tick();
    expect(chat.app.sessions.send(sendId)!).toMatchObject({
      status: "stopped",
      cause: "stop",
    });
    await advance(chat, 60_000);
    expect(chat.scripted.chats()).toBe(1);
  });

  test("a 400 fails the turn at once", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    chat.scripted.refuse(400, '{"error":{"message":"bad request"}}');
    const { sendId, sessionId } = await post(chat);
    await tick();
    expect(chat.scripted.chats()).toBe(1);
    expect(chat.app.sessions.send(sendId)!).toMatchObject({
      status: "failed",
      error: 'HTTP 400: {"error":{"message":"bad request"}}',
    });
    expect(logs.events.some((e) => e.msg === "round retried")).toBe(false);
    // the words stay on the chat row; a log names the status alone
    expect(logs.events.find((e) => e.msg === "round failed")!.fields).toEqual({
      chat: sessionId,
      round: 1,
      provider_status: 400,
      error: REFUSED,
    });
    expect(logs.events.find((e) => e.msg === "send end")!.fields).toMatchObject(
      { status: "failed", provider_status: 400, error: REFUSED },
    );
    expect(JSON.stringify(logs.events)).not.toContain("bad request");
  });

  test("an error after the first content fails the turn at once", async () => {
    const chat = await chatApp();
    const { sendId } = await post(chat);
    const script = await waitScript(chat.scripted, 1);
    script.content("so far");
    script.sse(
      `data: ${JSON.stringify({ error: { code: 503, message: "busy" } })}\n\n`,
    );
    await tick();
    await tick();
    expect(chat.scripted.chats()).toBe(1);
    expect(chat.app.sessions.send(sendId)!).toMatchObject({
      status: "failed",
      error: "busy",
    });
  });

  test("an error frame before any event is asked again", async () => {
    const chat = await chatApp();
    const { sendId } = await post(chat);
    const first = await waitScript(chat.scripted, 1);
    first.sse(
      `data: ${JSON.stringify({
        error: { code: 503, message: "overloaded", status: "UNAVAILABLE" },
      })}\n\n`,
    );
    first.end();
    await advance(chat);
    (await waitScript(chat.scripted, 2)).reply("hello");
    await tick();
    await tick();
    expect(chat.app.sessions.send(sendId)!.status).toBe("done");
  });

  test("a failed connection is asked again", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    chat.scripted.drop(1);
    const { sendId } = await post(chat);
    await advance(chat);
    (await waitScript(chat.scripted, 1)).reply("hello");
    await tick();
    await tick();
    expect(chat.scripted.chats()).toBe(2);
    expect(chat.app.sessions.send(sendId)!.status).toBe("done");
    const retried = logs.events.filter((e) => e.msg === "round retried");
    expect(retried).toHaveLength(1);
    expect(retried[0]!.fields).toMatchObject({
      round: 1,
      attempt: 1,
      error_type: "Error",
      error: "local failed: the connection was reset",
    });
  });

  test("four failed connections fail the round", async () => {
    const chat = await chatApp();
    chat.scripted.drop(9);
    const { sendId } = await post(chat);
    for (let i = 0; i < 3; i++) await advance(chat);
    await tick();
    expect(chat.scripted.chats()).toBe(4);
    expect(chat.app.sessions.send(sendId)!).toMatchObject({
      status: "failed",
      cause: "failure",
      error: "local failed: the connection was reset",
    });
  });
});

describe("a provider's words never reach a log", () => {
  test.each([
    { error: { code: "context_length_exceeded", message: "secret words" } },
    { error: { status: "INVALID_ARGUMENT", message: "secret words" } },
    { error: "secret words" },
  ])("an error frame with no code: %j", async (body) => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    const { sendId, sessionId } = await post(chat);
    const script = await waitScript(chat.scripted, 1);
    script.sse(`data: ${JSON.stringify(body)}\n\n`);
    await tick();
    await tick();
    expect(chat.scripted.chats()).toBe(1);
    // the chat row keeps the words exactly
    expect(chat.app.sessions.send(sendId)!).toMatchObject({
      status: "failed",
      error: "secret words",
    });
    expect(logs.events.find((e) => e.msg === "round failed")!.fields).toEqual({
      chat: sessionId,
      round: 1,
      error: REFUSED,
    });
    expect(logs.events.find((e) => e.msg === "send end")!.fields).toMatchObject(
      { status: "failed", error: REFUSED },
    );
    expect(JSON.stringify(logs.events)).not.toContain("secret words");
  });

  test("our own words stay in the log", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    await post(chat);
    (await waitScript(chat.scripted, 1)).end();
    await tick();
    await tick();
    expect(
      logs.events.find((e) => e.msg === "round failed")!.fields,
    ).toMatchObject({ error: "stream ended early" });
  });
});

describe("every round kind retries", () => {
  test("a memory phase round is asked again", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    chat.scripted.refuse(503, BUSY, { times: 1 });
    run.main.reply("Done.");
    for (let i = 0; i < 400 && chat.scripted.chats() < 2; i++) await tick();
    await advance(chat);
    (await waitScript(chat.scripted, 2)).reply("No change.");
    await settleRun(chat, run.sessionId);
    expect(chat.scripted.chats()).toBe(3);
    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      status: "done",
      memoryError: null,
    });
    await chat.app.shutdown();
  });

  test("a wait past the memory phase's window is not started", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    const active = chat.app.runner.registry.get(run.sessionId)!;
    active.policy.limits.memoryPhaseMs = 900;
    chat.scripted.refuse(503, BUSY, { times: 1 });
    run.main.reply("Done.");
    await settleRun(chat, run.sessionId);
    expect(chat.scripted.chats()).toBe(2);
    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      status: "done",
      memoryError: `HTTP 503: ${BUSY}`,
    });
    await chat.app.shutdown();
  });

  test("a wait past the turn's deadline is not started", async () => {
    const chat = await chatApp();
    await setLimits(chat, { sendDeadlineMs: 60_000 });
    expect(DEFAULT_LIMITS.sendDeadlineMs).toBeGreaterThan(60_000);
    const { script, sessionId, detail } = await startChat(chat, "use time");
    script.reasoning("thinking");
    await tick();
    chat.app.now.value += 59_500;
    chat.scripted.refuse(503, BUSY, { times: 1 });
    script.toolRound([
      { id: "time", name: "datetime", arguments: '{"timezone":"UTC"}' },
    ]);
    script.end();
    for (let i = 0; i < 400 && chat.scripted.chats() < 2; i++) await tick();
    await tick();
    await tick();
    expect(chat.scripted.chats()).toBe(2);
    expect(chat.app.sessions.send(detail.send.id)!).toMatchObject({
      status: "failed",
      error: `HTTP 503: ${BUSY}`,
    });
    expect(chat.app.sessions.byId(sessionId)!.status).toBe("failed");
  });

  test("a compaction round is asked again", async () => {
    const chat = await chatApp();
    const { script, sessionId } = await startChat(chat, "question");
    script.reply("answer");
    for (let i = 0; i < 200; i++) {
      if (chat.app.sessions.byId(sessionId)?.status !== "running") break;
      await tick();
    }
    chat.scripted.refuse(503, BUSY, { times: 1 });
    const compacted = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/compact`,
    );
    expect(compacted.status).toBe(200);
    const { send } = await compacted.json();
    await tick();
    expect(chat.scripted.chats()).toBe(2);
    await advance(chat);
    (await waitScript(chat.scripted, 2)).reply("the summary");
    await tick();
    await tick();
    expect(chat.scripted.chats()).toBe(3);
    expect(chat.app.sessions.send(send.id)!).toMatchObject({
      kind: "compact",
      status: "done",
    });
  });
});

describe("the working line while a round waits", () => {
  test("a retry frame sets it and the next attempt's first event clears it", async () => {
    const chat = await chatApp();
    const { script, sessionId, detail } = await startChat(chat, "use time");
    const conn = await watcher(chat);
    watch(chat, conn, sessionId);
    chat.scripted.refuse(503, BUSY, { times: 1 });
    script.toolRound([
      { id: "time", name: "datetime", arguments: '{"timezone":"UTC"}' },
    ]);
    script.end();
    for (let i = 0; i < 400 && chat.scripted.chats() < 2; i++) await tick();
    await tick();
    expect(frames(conn, "retry")).toEqual([
      {
        type: "retry",
        sessionId,
        sendId: detail.send.id,
        seq: expect.any(Number),
        retry: { attempt: 1, max: 3 },
      },
    ]);
    expect(chat.app.runner.live(sessionId)?.retry).toEqual({
      attempt: 1,
      max: 3,
    });
    await advance(chat);
    const answer = await waitScript(chat.scripted, 2);
    // asked again, and still nothing from the provider
    expect(frames(conn, "retry")).toHaveLength(1);
    answer.content("done");
    await tick();
    const [set, cleared] = frames(conn, "retry");
    expect(cleared).toMatchObject({ retry: null, seq: set!.seq + 1 });
    expect(frames(conn, "delta").at(-1)!.seq).toBe(cleared!.seq + 1);
    expect(chat.app.runner.live(sessionId)).not.toHaveProperty("retry");
    answer.finish();
    answer.usage();
    answer.end();
    await tick();
    await tick();
    expect(chat.app.sessions.send(detail.send.id)!.status).toBe("done");
    expect(frames(conn, "retry")).toHaveLength(2);
  });

  test("a watcher joining mid-wait sees it, and Stop clears it", async () => {
    const chat = await chatApp();
    chat.scripted.refuse(503, BUSY);
    const { sessionId, sendId } = await post(chat);
    await tick();
    const joined = await watcher(chat);
    watch(chat, joined, sessionId);
    expect(frames(joined, "watched")[0]?.live).toMatchObject({
      sendId,
      retry: { attempt: 1, max: 3 },
    });
    const held: SessionDetail = await (
      await chat.member.call("GET", `/api/sessions/${sessionId}`)
    ).json();
    expect(held.live?.retry).toEqual({ attempt: 1, max: 3 });
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await tick();
    await tick();
    expect(frames(joined, "retry").at(-1)).toMatchObject({ retry: null });
    expect(chat.app.sessions.send(sendId)!.status).toBe("stopped");
  });
});

// runRound alone, with a chat port that plays one stream per request
function round(
  streams: ChatEvent[][],
  fields: {
    deadline?: number | null;
    chat?: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<ChatEvent>;
    // the quiet timer fires at once
    quiet?: boolean;
    // the quiet timer fires after these real milliseconds
    idleRealMs?: number;
    forgetReasoning?: RoundDeps["forgetReasoning"];
    // Stop lands during the first retry's wait
    stopInWait?: boolean;
  } = {},
) {
  const logs = collectLogs();
  let now = 1_000_000;
  const sleeps: number[] = [];
  const clock = Object.assign(() => now, {
    // a retry's wait passes at once; the quiet timer never fires
    sleep: (ms: number) => {
      if (ms >= STREAM_IDLE_MS) {
        if (fields.idleRealMs !== undefined) {
          return new Promise<void>((resolve) =>
            setTimeout(resolve, fields.idleRealMs),
          );
        }
        return fields.quiet ? Promise.resolve() : new Promise<void>(() => {});
      }
      if (fields.stopInWait) {
        send.controller.abort();
        return new Promise<void>(() => {});
      }
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
  });
  let asked = 0;
  // what the working line was told, as the writer skips a clear of nothing
  const shown: (LiveRetry | null)[] = [];
  const deps = {
    chat: (_id: string, req: ChatRequest, signal: AbortSignal) => {
      if (fields.chat !== undefined) return fields.chat(req, signal);
      const events = streams[asked++] ?? [];
      return (async function* () {
        yield* events;
      })();
    },
    writer: {
      delta() {},
      retrying(send: ActiveSend, retry: LiveRetry | null) {
        if (send.round!.retry === null && retry === null) return;
        send.round!.retry = retry;
        shown.push(retry);
      },
    },
    lookups: {},
    forgetReasoning: fields.forgetReasoning,
    clock,
    log: logs.logFactory("runner"),
    random: () => 0,
  } as unknown as RoundDeps;
  const send = {
    sessionId: "chat",
    roundNo: 1,
    phase: "provider",
    kind: "chat",
    summarizing: false,
    answering: null,
    startedAt: now,
    controller: new AbortController(),
    policy: {
      providerId: "p",
      deadlineMs: null,
      offered: { tools: [] },
    },
    round: {
      content: "",
      reasoning: "",
      reasoningDetails: [],
      finishReason: null,
      usage: null,
      retry: null,
      upstream: null,
      servedModel: null,
      startedAt: now,
    },
  } as unknown as ActiveSend;
  const run = runRound(deps, send, [], {
    request: { model: "m", messages: [], thinking: false },
    ...(fields.deadline === undefined ? {} : { deadline: fields.deadline }),
  });
  return { run, asked: () => asked, sleeps, logs, send, shown };
}

const timedOut: ChatEvent = {
  kind: "error",
  message: "local failed: the response headers timed out",
  unanswered: true,
  timedOut: true,
};
const busy: ChatEvent = { kind: "error", message: "HTTP 503", status: 503 };
const answer: ChatEvent[] = [
  { kind: "content", text: "hi" },
  { kind: "finish", reason: "stop", details: null },
];

describe("runRound retries", () => {
  test("a Stop during the wait leaves no one named as serving", async () => {
    const served: ChatEvent = { kind: "served", upstream: "Busy", model: "x" };
    const r = round([[served, busy], answer], { stopInWait: true });
    await r.run;
    expect(r.asked()).toBe(1);
    expect(r.send.round!.upstream).toBeNull();
    expect(r.send.round!.servedModel).toBeNull();
  });

  test("a stream quiet after naming who serves it goes quiet", async () => {
    const r = round([], {
      quiet: true,
      chat: () =>
        (async function* (): AsyncGenerator<ChatEvent> {
          yield { kind: "served", upstream: "Busy", model: "m" };
          await new Promise(() => {});
        })(),
    });
    await expect(r.run).rejects.toThrow("the provider went quiet");
  });

  test("a resend after refused reasoning has no idle cap until it answers", async () => {
    const forgot: string[] = [];
    const r = round([], {
      idleRealMs: 5,
      forgetReasoning: (sessionId, providerId, model) => {
        forgot.push(`${sessionId}/${providerId}/${model}`);
      },
      chat: () =>
        (async function* (): AsyncGenerator<ChatEvent> {
          yield { kind: "reasoningRefused" };
          // the resend's headers wait
          await new Promise((resolve) => setTimeout(resolve, 20));
          yield* answer;
        })(),
    });
    await r.run;
    expect(forgot).toEqual(["chat/p/m"]);
    expect(r.send.round!.content).toBe("");
    expect(r.send.round!.finishReason).toBe("stop");
  });

  // an azure stream shaped as the recordings: frames sent together, then
  // a gap where Azure sends nothing at all, then the rest
  const azureStream = (
    before: Record<string, unknown>[],
    gapMs: number,
    after: Record<string, unknown>[],
  ) => {
    const encoder = new TextEncoder();
    const frame = (body: Record<string, unknown>) =>
      encoder.encode(`event: ${body.type}\ndata: ${JSON.stringify(body)}\n\n`);
    const fetcher = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const body of before) controller.enqueue(frame(body));
            await new Promise((resolve) => setTimeout(resolve, gapMs));
            for (const body of after) controller.enqueue(frame(body));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch;
    const provider = providerFor(
      {
        id: "p",
        name: "foundry",
        wire: "azure",
        baseUrl: "https://foundry.test/openai/v1",
        keyName: null,
        createdAt: 0,
      },
      { fetcher, secret: () => null },
    );
    // the idle window is 30 real ms, every gap 100
    return round([], {
      idleRealMs: 30,
      chat: (req, signal) => provider.chat(req, signal),
    });
  };
  const opened = [
    { type: "response.created", response: {} },
    { type: "response.in_progress", response: {} },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning" },
    },
  ];
  const reasoned = {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "reasoning", summary: [], encrypted_content: "blob" },
  };
  const text = (delta: string) => ({
    type: "response.output_text.delta",
    output_index: 1,
    delta,
  });
  const completed = { type: "response.completed", response: {} };

  test("a silent start longer than the idle window still answers", async () => {
    const r = azureStream([opened[0]!, opened[1]!], 100, [
      text("hi"),
      completed,
    ]);
    await r.run;
    expect(r.send.round!.finishReason).toBe("stop");
  });

  test("an open reasoning item lifts the idle check until it closes", async () => {
    const r = azureStream(
      [
        ...opened,
        {
          type: "response.reasoning_summary_text.delta",
          output_index: 0,
          summary_index: 0,
          delta: "thinking",
        },
      ],
      100,
      [reasoned, text("hi"), completed],
    );
    await r.run;
    expect(r.send.round!.finishReason).toBe("stop");
  });

  test("after visible text, silence with no reasoning open goes quiet", async () => {
    const r = azureStream([...opened, reasoned, text("hi")], 100, [completed]);
    await expect(r.run).rejects.toThrow("the provider went quiet");
  });

  test("a stream left open by its error frame is closed on a retry", async () => {
    const closed: number[] = [];
    let opened = 0;
    const encoder = new TextEncoder();
    const frame = (body: object) =>
      encoder.encode(`data: ${JSON.stringify(body)}\n\n`);
    const fetcher = (async () => {
      const at = opened++;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (at === 0) {
            // held open, as a proxy that keeps the connection does
            controller.enqueue(
              frame({ error: { code: 503, message: "busy" } }),
            );
            return;
          }
          controller.enqueue(
            frame({
              choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
            }),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
        cancel() {
          closed.push(at);
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const provider = providerFor(
      {
        id: "p",
        name: "local",
        wire: "openai-compatible",
        baseUrl: "http://models.test/v1",
        keyName: null,
        createdAt: 0,
      },
      { fetcher, secret: () => null },
    );
    const r = round([], {
      chat: (req, signal) => provider.chat(req, signal),
    });
    await r.run;
    await tick();
    expect(opened).toBe(2);
    expect(closed).toContain(0);
    expect(r.send.round!.finishReason).toBe("stop");
  });

  test("who serves the round does not start it", async () => {
    const served: ChatEvent = { kind: "served", upstream: "Busy", model: "m" };
    const upstream: ChatEvent = {
      kind: "error",
      message: "upstream failed",
      status: 502,
    };
    const r = round([[served, upstream], answer]);
    await r.run;
    expect(r.asked()).toBe(2);
    // the attempt that answered named no one
    expect(r.send.round!.upstream).toBeNull();
  });

  test("the first token is timed from the round's start, waits included", async () => {
    const r = round([[busy], answer]);
    await r.run;
    expect(r.sleeps).toEqual([1000]);
    expect(r.send.round!.startedAt).toBe(1_000_000);
  });

  test("two headers timeouts fail the round", async () => {
    const r = round([[timedOut], [timedOut], answer]);
    await expect(r.run).rejects.toThrow(
      "local failed: the response headers timed out",
    );
    expect(r.asked()).toBe(2);
    expect(r.sleeps).toEqual([1000]);
  });

  test("a headers timeout counts toward the three", async () => {
    const r = round([[timedOut], [busy], [busy], [busy], answer]);
    await expect(r.run).rejects.toThrow("HTTP 503");
    expect(r.asked()).toBe(4);
    expect(r.sleeps).toEqual([1000, 2000, 4000]);
    expect(r.shown).toEqual([
      { attempt: 1, max: 3 },
      { attempt: 2, max: 3 },
      { attempt: 3, max: 3 },
      null,
    ]);
  });

  test("a third retry answered finishes the round", async () => {
    const r = round([[busy], [busy], [busy], answer]);
    await r.run;
    expect(r.asked()).toBe(4);
    expect(r.send.round!.finishReason).toBe("stop");
    expect(r.shown).toEqual([
      { attempt: 1, max: 3 },
      { attempt: 2, max: 3 },
      { attempt: 3, max: 3 },
      null,
    ]);
    expect(r.send.round!.retry).toBeNull();
  });

  test("a wait past the deadline is not started", async () => {
    const r = round([[busy], answer], { deadline: 1_000_000 + 1000 });
    await expect(r.run).rejects.toThrow("HTTP 503");
    expect(r.asked()).toBe(1);
    expect(r.sleeps).toEqual([]);
    expect(r.shown).toEqual([]);
  });
});
