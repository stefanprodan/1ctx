// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A finished run's answer is asked of the run-attention decision's
// decider once the run is done: the chance it needs attention stored on its session with the
// decider's name and one rows-free envelope, nothing for a chat or a run
// that did not finish, and the asks capped, logged on failure and
// aborted and awaited at shutdown.

import { describe, expect, test } from "bun:test";
import { DecisionError } from "../../../src/server/deciders/index.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import {
  ASKS_AT_ONCE,
  type AttentionPort,
  attention,
  MAX_QUEUED,
  outcomeQuestion,
  QUESTION_TOKENS,
  stateOf,
  UNKNOWN_WINDOW_TOKENS,
} from "../../../src/server/runner/attention.ts";
import {
  FINALIZE_ATTEMPTS,
  FINALIZE_RETRY_MS,
} from "../../../src/server/runner/ending.ts";
import { SHUTDOWN_DRAIN_MS } from "../../../src/server/runner/index.ts";
import type { ActiveSend } from "../../../src/server/runner/send.ts";
import { runAnswer } from "../../../src/server/sessions/attention.ts";
import {
  DECISION_OPTIONS,
  type DecisionSummary,
} from "../../../src/shared/contracts/decision.ts";
import { collectLogs, PROVIDER_URL } from "../../helpers/app.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import { chatApp, startChat, tick, waitScript } from "../../helpers/chat.ts";
import { systemoneAnswer } from "../../helpers/systemone.ts";

const ANSWER = "The check failed: the Flux controllers are not ready.";

const DEFAULTS: DecisionSummary = {
  id: "run-attention",
  enabled: true,
  deciderId: null,
  options: DECISION_OPTIONS["run-attention"].map((o) => ({
    ...o,
    default: o.description,
  })),
};
const [GOOD, BAD] = DECISION_OPTIONS["run-attention"].map((o) => o.key) as [
  string,
  string,
];

type Held = { body: string; release(): void; signal: AbortSignal | null };

// the decisions server: the recorded answer at once, or held until the
// test releases it or, unless deaf, the ask is aborted
function decisions(hold = false, deaf = false) {
  const asked: Held[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== `${PROVIDER_URL}/systemone`) {
      throw new TypeError("unable to connect");
    }
    const body = typeof init?.body === "string" ? init.body : "{}";
    const signal = init?.signal ?? null;
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    asked.push({ body, release, signal });
    if (hold) {
      await new Promise<void>((resolve, reject) => {
        void released.then(resolve);
        if (!deaf) {
          signal?.addEventListener("abort", () => reject(signal.reason));
        }
      });
    }
    return systemoneAnswer(body);
  }) as unknown as typeof fetch;
  return { fetcher, asked };
}

async function deciderApp(
  options: {
    hold?: boolean;
    deaf?: boolean;
    decider?: boolean;
    logs?: boolean;
    drainMs?: number;
  } = {},
) {
  const server = decisions(options.hold, options.deaf);
  const logs = collectLogs();
  const chat = await chatApp({
    fetcher: server.fetcher,
    logFactory: options.logs ? logs.logFactory : undefined,
    drainMs: options.drainMs,
  });
  chat.app.automationScheduler.stop();
  if (options.decider !== false) {
    chat.app.deciders.store.create({
      name: "judge",
      providerId: chat.providerId,
      model: "kev-latest",
      contextLength: 32000,
      promptPrice: null,
      now: chat.app.now.value,
    });
  }
  return { chat, asked: server.asked, logs: logs.events };
}

type SessionMark = {
  attention: number | null;
  attention_by: string | null;
  revision: number;
  last_activity_at: number;
};

const mark = (chat: Awaited<ReturnType<typeof chatApp>>, id: string) =>
  chat.app.db
    .query<SessionMark, [string]>(
      "select attention, attention_by, revision, last_activity_at from sessions where id = ?",
    )
    .get(id);

async function finishedRun(chat: Awaited<ReturnType<typeof chatApp>>) {
  const automation = await createAutomation(chat);
  const { sessionId, main } = await startRun(chat, automation.id);
  main.reply(ANSWER);
  expect((await settleRun(chat, sessionId))?.status).toBe("done");
  return sessionId;
}

describe("a finished run", () => {
  test.serial(
    "stores the chance it needs attention with one envelope",
    async () => {
      const { chat, asked } = await deciderApp({ hold: true });
      const events: BusEvent[] = [];
      const unsubscribe = subscribe((event) => events.push(event), silent);
      try {
        const id = await finishedRun(chat);
        while (asked.length === 0) await tick();
        const before = mark(chat, id)!;
        expect(before.attention).toBeNull();
        const request = JSON.parse(asked[0]!.body);
        expect(request.state).toBe(ANSWER);
        expect(request.questions).toEqual(outcomeQuestion(DEFAULTS));
        const seen = events.length;
        chat.app.now.value += 1000;
        asked[0]!.release();
        await chat.app.runner.settled();
        const after = mark(chat, id)!;
        expect(after.attention).toBe(0.9802);
        expect(after.attention_by).toBe("judge");
        expect(after.revision).toBe(before.revision + 1);
        expect(after.last_activity_at).toBe(before.last_activity_at);
        const envelopes = events.slice(seen);
        expect(envelopes).toHaveLength(1);
        expect(envelopes[0]).toMatchObject({
          type: "session.changed",
          data: {
            session: { id, attention: 0.9802, revision: after.revision },
            messages: [],
          },
        });
        expect(
          chat.app.db
            .query("select purpose, session_id from decision_usage")
            .all(),
        ).toEqual([{ purpose: "run-attention", session_id: id }]);
      } finally {
        unsubscribe();
      }
      await chat.app.shutdown();
    },
  );

  test("is asked with the option descriptions an admin saved", async () => {
    const { chat, asked } = await deciderApp();
    const text = {
      [GOOD]: "The report came from the live cluster",
      [BAD]: "The report used a cached snapshot",
    };
    const save = (options: Record<string, string>) =>
      chat.admin.call("PUT", "/api/decisions/run-attention", {
        body: { enabled: true, deciderId: null, options },
      });
    expect((await save(text)).status).toBe(200);
    const automation = await createAutomation(chat);
    const run = async () => {
      const { sessionId, main } = await startRun(chat, automation.id);
      main.reply(ANSWER);
      await settleRun(chat, sessionId);
      await chat.app.runner.settled();
    };
    await run();
    expect(JSON.parse(asked[0]!.body).questions).toEqual({
      outcome: {
        type: "choice",
        instructions: "What is the outcome of this task run?",
        criteria: text,
      },
    });
    await save(
      Object.fromEntries(DEFAULTS.options.map((o) => [o.key, o.default])),
    );
    await run();
    expect(JSON.parse(asked[1]!.body).questions).toEqual(
      outcomeQuestion(DEFAULTS),
    );
    await chat.app.shutdown();
  });

  test("turned off asks nothing and records nothing", async () => {
    const { chat, asked } = await deciderApp();
    const res = await chat.admin.call("PUT", "/api/decisions/run-attention", {
      body: {
        enabled: false,
        deciderId: null,
        options: Object.fromEntries(
          DEFAULTS.options.map((o) => [o.key, o.default]),
        ),
      },
    });
    expect(res.status).toBe(200);
    const id = await finishedRun(chat);
    await chat.app.runner.settled();
    expect(asked).toHaveLength(0);
    expect(mark(chat, id)?.attention).toBeNull();
    expect(
      chat.app.db.query("select count(*) as n from decision_usage").get(),
    ).toEqual({ n: 0 });
    await chat.app.shutdown();
  });

  test("asks the decider the decision names, not the default", async () => {
    const { chat, asked } = await deciderApp();
    const named = chat.app.deciders.store.create({
      name: "named",
      providerId: chat.providerId,
      model: "jaredpalmer/kev-4b",
      contextLength: 32000,
      promptPrice: null,
      now: chat.app.now.value,
    });
    const res = await chat.admin.call("PUT", "/api/decisions/run-attention", {
      body: {
        enabled: true,
        deciderId: named.id,
        options: Object.fromEntries(
          DEFAULTS.options.map((o) => [o.key, o.default]),
        ),
      },
    });
    expect(res.status).toBe(200);
    const id = await finishedRun(chat);
    await chat.app.runner.settled();
    expect(asked.map((a) => JSON.parse(a.body).model)).toEqual([
      "jaredpalmer/kev-4b",
    ]);
    expect(mark(chat, id)?.attention_by).toBe("named");
    expect(
      chat.app.db.query("select decider_name from decision_usage").all(),
    ).toEqual([{ decider_name: "named" }]);
    await chat.app.shutdown();
  });

  test("is asked about its answer alone, never the memory phase", async () => {
    const { chat } = await deciderApp();
    const id = await finishedRun(chat);
    await chat.app.runner.settled();
    const send = chat.app.sessions.lastSend(id)!;
    expect(runAnswer(chat.app.db, send.id, null)).toBe(ANSWER);
    // a phase from the answer's round on leaves nothing before it
    expect(runAnswer(chat.app.db, send.id, 1)).toBeNull();
    expect(runAnswer(chat.app.db, "gone", null)).toBeNull();
    await chat.app.shutdown();
  });

  test("with its own memory is asked about the answer, not its notes", async () => {
    const { chat, asked } = await deciderApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const { sessionId, main } = await startRun(chat, automation.id);
    main.reply(ANSWER);
    const phase = await waitScript(chat.scripted, 2);
    phase.reply("Noted the Flux failure for the next run.");
    expect((await settleRun(chat, sessionId))?.status).toBe("done");
    await chat.app.runner.settled();
    expect(chat.app.sessions.lastSend(sessionId)?.memoryRound).toBe(2);
    expect(asked).toHaveLength(1);
    expect(JSON.parse(asked[0]!.body).state).toBe(ANSWER);
    expect(mark(chat, sessionId)?.attention).toBe(0.9802);
    await chat.app.shutdown();
  });

  test("keeps no mark when its fork is made", async () => {
    const { chat } = await deciderApp();
    const id = await finishedRun(chat);
    await chat.app.runner.settled();
    expect(mark(chat, id)?.attention).toBe(0.9802);
    const answer = chat.app.sessions
      .messages(id)
      .find((row) => row.slot === "answer")!;
    const forked = await chat.member.call("POST", `/api/sessions/${id}/fork`, {
      body: { messageId: answer.id, agentId: chat.agentId },
    });
    expect(forked.status).toBe(201);
    const fork = (await forked.json()).session;
    expect(fork.attention).toBeNull();
    expect(mark(chat, fork.id)?.attention_by).toBeNull();
    await chat.app.runner.settled();
    await chat.app.shutdown();
  });

  test("deleted before the answer takes no mark", async () => {
    const { chat, asked, logs } = await deciderApp({ hold: true, logs: true });
    const id = await finishedRun(chat);
    while (asked.length === 0) await tick();
    const deleted = await chat.member.call("DELETE", `/api/sessions/${id}`);
    expect(deleted.status).toBe(200);
    asked[0]!.release();
    await chat.app.runner.settled();
    expect(mark(chat, id)).toBeNull();
    expect(logs.filter((e) => e.msg === "run attention failed")).toEqual([]);
    await chat.app.shutdown();
  });
});

describe("no ask", () => {
  test("for a chat turn", async () => {
    const { chat, asked } = await deciderApp();
    const started = await startChat(chat);
    started.script.reply("hello");
    await settleRun(chat, started.sessionId);
    await chat.app.runner.settled();
    expect(asked).toHaveLength(0);
    expect(mark(chat, started.sessionId)?.attention).toBeNull();
    await chat.app.shutdown();
  });

  test("for a run that failed or was stopped", async () => {
    const { chat, asked } = await deciderApp();
    const automation = await createAutomation(chat);
    const failed = await startRun(chat, automation.id);
    failed.main.content("half");
    failed.main.end();
    expect((await settleRun(chat, failed.sessionId))?.status).toBe("failed");
    const stopped = await startRun(chat, automation.id);
    const stop = await chat.member.call(
      "POST",
      `/api/sessions/${stopped.sessionId}/stop`,
    );
    expect(stop.status).toBe(200);
    expect((await settleRun(chat, stopped.sessionId))?.status).toBe("stopped");
    await chat.app.runner.settled();
    expect(asked).toHaveLength(0);
    await chat.app.shutdown();
  });

  test("for a run that hit its deadline", async () => {
    const { chat, asked } = await deciderApp();
    const automation = await createAutomation(chat);
    const { sessionId } = await startRun(chat, automation.id);
    chat.app.now.value += 600_000;
    expect((await settleRun(chat, sessionId))?.status).toBe("stopped");
    expect(chat.app.sessions.lastSend(sessionId)?.cause).toBe("deadline");
    await chat.app.runner.settled();
    expect(asked).toHaveLength(0);
    await chat.app.shutdown();
  });

  test("for a run whose finalize failed", async () => {
    const { chat, asked, logs } = await deciderApp({ logs: true });
    const automation = await createAutomation(chat);
    const run = await startRun(chat, automation.id);
    const store = chat.app.sessions;
    const original = store.finishSend.bind(store);
    store.finishSend = () => {
      throw new Error("finalize failed");
    };
    run.main.reply(ANSWER);
    for (let i = 0; i < FINALIZE_ATTEMPTS; i++) {
      await tick();
      chat.app.now.value += FINALIZE_RETRY_MS;
    }
    while (!logs.some((e) => e.msg === "chat finalize failed")) await tick();
    store.finishSend = original;
    await chat.app.runner.settled();
    expect(asked).toHaveLength(0);
    expect(mark(chat, run.sessionId)?.attention).toBeNull();
  });

  test("for a decider whose window leaves no room", async () => {
    const { chat, asked, logs } = await deciderApp({ logs: true });
    const tiny = chat.app.deciders.store.create({
      name: "tiny",
      providerId: chat.providerId,
      model: "kev-latest",
      contextLength: 300,
      promptPrice: null,
      now: chat.app.now.value,
    });
    chat.app.deciders.store.setDefault(tiny.id, true);
    const id = await finishedRun(chat);
    await chat.app.runner.settled();
    expect(asked).toHaveLength(0);
    expect(mark(chat, id)?.attention).toBeNull();
    expect(logs.filter((e) => e.msg.includes("attention"))).toEqual([]);
    expect(chat.app.db.query("select * from decision_usage").all()).toEqual([]);
    await chat.app.shutdown();
  });

  test("with no decider, without a word", async () => {
    const { chat, asked, logs } = await deciderApp({
      decider: false,
      logs: true,
    });
    const id = await finishedRun(chat);
    await chat.app.runner.settled();
    expect(asked).toHaveLength(0);
    expect(mark(chat, id)?.attention).toBeNull();
    expect(logs.filter((e) => e.msg.includes("attention"))).toEqual([]);
    await chat.app.shutdown();
  });
});

test("a refusal stores nothing and is logged without the answer", async () => {
  const { chat, logs } = await deciderApp({ logs: true });
  const strict = chat.app.deciders.store.create({
    name: "strict",
    providerId: chat.providerId,
    model: "respan/span-01-lite:free",
    contextLength: null,
    promptPrice: null,
    now: chat.app.now.value,
  });
  chat.app.deciders.store.setDefault(strict.id, true);
  const id = await finishedRun(chat);
  await chat.app.runner.settled();
  expect(mark(chat, id)).toMatchObject({ attention: null, attention_by: null });
  const failed = logs.filter((e) => e.msg === "run attention failed");
  expect(failed).toHaveLength(1);
  expect(failed[0]).toMatchObject({ area: "runner", level: "warn" });
  expect(failed[0]!.fields.chat).toBe(id);
  expect(JSON.stringify(failed[0]!.fields)).not.toContain(ANSWER);
  expect(chat.app.db.query("select * from decision_usage").all()).toEqual([]);
  await chat.app.shutdown();
});

test("shutdown aborts the asks and waits for them", async () => {
  const { chat, asked, logs } = await deciderApp({ hold: true, logs: true });
  const id = await finishedRun(chat);
  while (asked.length === 0) await tick();
  await chat.app.shutdown();
  expect(asked[0]!.signal?.aborted).toBeTrue();
  expect(mark(chat, id)?.attention).toBeNull();
  expect(
    logs
      .filter((e) => e.msg === "run attention failed")
      .map((e) => e.fields.chat),
  ).toEqual([id]);
});

test("shutdown with a run in flight and a held ask meets the deadline", async () => {
  const { chat, asked } = await deciderApp({ hold: true, deaf: true });
  await finishedRun(chat);
  while (asked.length === 0) await tick();
  const other = await createAutomation(chat, { name: "other-run" });
  await startRun(chat, other.id);
  expect(chat.app.runner.registry.size).toBe(1);
  const done = chat.app.shutdown();
  await tick();
  expect(asked[0]!.signal?.aborted).toBeTrue();
  chat.app.now.value += SHUTDOWN_DRAIN_MS;
  expect(await done).toEqual({ ended: 1, timedOut: true, drained: 0 });
});

describe("a drain", () => {
  test("waits for the ask of a run that finished inside it", async () => {
    const { chat, asked } = await deciderApp({ hold: true, drainMs: 10_000 });
    const automation = await createAutomation(chat);
    const { sessionId, main } = await startRun(chat, automation.id);
    const done = chat.app.shutdown();
    main.reply(ANSWER);
    while (asked.length === 0) await tick();
    expect(chat.app.sessions.byId(sessionId)?.status).toBe("done");
    asked[0]!.release();
    expect(await done).toEqual({ ended: 0, timedOut: false, drained: 1 });
    expect(mark(chat, sessionId)?.attention).toBe(0.9802);
  });

  test("aborts an ask still held at its bound", async () => {
    const { chat, asked } = await deciderApp({ hold: true, drainMs: 10_000 });
    const automation = await createAutomation(chat);
    const { sessionId, main } = await startRun(chat, automation.id);
    const done = chat.app.shutdown();
    main.reply(ANSWER);
    while (asked.length === 0) await tick();
    expect(asked[0]!.signal?.aborted).toBe(false);
    chat.app.now.value += 10_000;
    expect(await done).toEqual({ ended: 0, timedOut: false, drained: 1 });
    expect(asked[0]!.signal?.aborted).toBe(true);
    expect(mark(chat, sessionId)?.attention).toBeNull();
  });
});

describe("the asks", () => {
  const send = (id: string, fields: Partial<ActiveSend> = {}) =>
    ({
      id: `send-${id}`,
      sessionId: id,
      projectId: "p1",
      kind: "run",
      terminal: "finish",
      memoryRound: null,
      ...fields,
    }) as ActiveSend;

  // a decider whose answers the test gives one by one
  function port(answer: string | null = ANSWER) {
    const pending: {
      id: string;
      state: string;
      signal: AbortSignal;
      settle(p: number | Error): void;
    }[] = [];
    const marks: [string, number, string][] = [];
    const fake: AttentionPort = {
      decide: (use, _questions, state, signal) =>
        new Promise((resolve, reject) => {
          const text = typeof state === "function" ? state(null) : state;
          signal.addEventListener("abort", () =>
            reject(new DecisionError("the decider was stopped")),
          );
          pending.push({
            id: use.sessionId!,
            state: text ?? "",
            signal,
            settle: (p) =>
              p instanceof Error
                ? reject(p)
                : resolve({
                    decider: { id: "d1", name: "judge", contextLength: null },
                    served: "judge-1",
                    answers: {
                      outcome: {
                        type: "choice",
                        probabilities: {
                          "all-good": 1 - p,
                          "needs-attention": p,
                        },
                        pick: p >= 0.5 ? "needs-attention" : "all-good",
                        probability: Math.max(p, 1 - p),
                      },
                    },
                    usage: { inputTokens: 1, outputTokens: 1, cost: null },
                    ms: 1,
                  }),
          });
        }),
      decision: () => DEFAULTS,
      runAnswer: () => answer,
      markAttention: (sessionId, value, by) => {
        marks.push([sessionId, value, by]);
        return true;
      },
    };
    return { fake, pending, marks };
  }

  test("run at most two at once and queue the rest", async () => {
    const { fake, pending, marks } = port();
    const asks = attention(fake, silent);
    for (const id of ["a", "b", "c", "d"]) asks.ask(send(id));
    await tick();
    expect(ASKS_AT_ONCE).toBe(2);
    expect(pending.map((p) => p.id)).toEqual(["a", "b"]);
    pending[0]!.settle(0.1);
    await tick();
    expect(pending.map((p) => p.id)).toEqual(["a", "b", "c"]);
    pending[1]!.settle(new DecisionError("refused"));
    pending[2]!.settle(0.7);
    await tick();
    pending[3]!.settle(0.2);
    await asks.settled();
    expect(marks).toEqual([
      ["a", 0.1, "judge"],
      ["c", 0.7, "judge"],
      ["d", 0.2, "judge"],
    ]);
  });

  test("skip a send that is not a finished run with an answer", async () => {
    const none = port(null);
    const asks = attention(none.fake, silent);
    asks.ask(send("a"));
    const some = port();
    const others = attention(some.fake, silent);
    others.ask(send("b", { kind: "chat" }));
    others.ask(send("c", { terminal: "failure" }));
    others.ask(send("d", { terminal: "deadline" }));
    others.ask(send("e", { terminal: "stop" }));
    await tick();
    expect(none.pending).toEqual([]);
    expect(some.pending).toEqual([]);
    await asks.settled();
    await others.settled();
  });

  test("close aborts the asks in flight and asks no other", async () => {
    const { fake, pending, marks } = port();
    const logs = collectLogs();
    const asks = attention(fake, logs.logFactory("runner"));
    for (const id of ["a", "b", "c"]) asks.ask(send(id));
    await tick();
    await asks.close();
    expect(pending.every((p) => p.signal.aborted)).toBeTrue();
    asks.ask(send("d"));
    await asks.settled();
    expect(pending.map((p) => p.id)).toEqual(["a", "b"]);
    expect(marks).toEqual([]);
    expect(
      logs.events.map((e) => [e.msg, e.fields.chat, e.fields.error]),
    ).toEqual([
      ["run attention failed", "a", "the decider was stopped"],
      ["run attention failed", "b", "the decider was stopped"],
    ]);
  });

  test("a throw reading the answer is logged and frees its slot", async () => {
    const { fake, pending, marks } = port();
    fake.runAnswer = (sendId) => {
      if (sendId !== "send-c") throw new Error("database is locked");
      return ANSWER;
    };
    const logs = collectLogs();
    const asks = attention(fake, logs.logFactory("runner"));
    for (const id of ["a", "b", "c"]) asks.ask(send(id));
    await tick();
    expect(pending.map((p) => p.id)).toEqual(["c"]);
    pending[0]!.settle(0.4);
    await asks.settled();
    expect(marks).toEqual([["c", 0.4, "judge"]]);
    expect(
      logs.events.map((e) => [e.msg, e.fields.chat, e.fields.error]),
    ).toEqual([
      ["run attention failed", "a", "database is locked"],
      ["run attention failed", "b", "database is locked"],
    ]);
  });

  test("queue at most MAX_QUEUED and drop the oldest waiting", async () => {
    const { fake, pending } = port();
    const logs = collectLogs();
    const asks = attention(fake, logs.logFactory("runner"));
    const total = ASKS_AT_ONCE + MAX_QUEUED + 1;
    for (let i = 0; i < total; i++) asks.ask(send(`s${i}`));
    await tick();
    expect(pending.map((p) => p.id)).toEqual(["s0", "s1"]);
    expect(logs.events.map((e) => [e.msg, e.fields.chat])).toEqual([
      ["run attention dropped", `s${ASKS_AT_ONCE}`],
    ]);
    // the next to start is the oldest kept
    pending[0]!.settle(0.1);
    await tick();
    expect(pending[2]!.id).toBe(`s${ASKS_AT_ONCE + 1}`);
    await asks.close();
  });

  test("cut the answer to the decider's window", () => {
    const long = "lorem ipsum dolor sit amet\n".repeat(20_000);
    expect(stateOf("short")(null)).toBe("short");
    const unknown = stateOf(long)(null)!;
    const known = stateOf(long)(2000)!;
    expect(long.startsWith(unknown)).toBeTrue();
    expect(unknown.length).toBeGreaterThan(known.length);
    expect(UNKNOWN_WINDOW_TOKENS).toBe(4000);
    // a window with no room past the question asks nothing
    expect(stateOf(long)(QUESTION_TOKENS)).toBeNull();
    expect(stateOf("short")(300)).toBeNull();
  });
});
