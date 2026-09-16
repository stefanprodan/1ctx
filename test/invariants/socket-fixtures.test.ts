// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Records the socket traffic one send produces into a fixture under
// test/fixtures/socket/<path>.ndjson: the first line is the initial
// state the watcher starts from (the detail the POST answered, or, for
// a reconnect, a detail fetched mid-send followed by the watched answer),
// then one line per socket frame the watcher received (the durable
// session envelopes and the stream frames), in order. The same files
// drive the client tests, so both sides agree on what a send looks like.
// A new runner path gets its fixture recorded here before the client
// learns about it.
//
// The recorder drives the composed app through the real socket upgrade
// and the real writer, so a recorded frame is what the server actually
// sends. Paths that need a tool's outcome fixed (a pending, failed, slow
// or oversized result) inject a fake tools capability through
// chatApp({tools}); the shape it returns is the tools area's shape, so
// the rows the writer persists are the production rows. Paths that need
// a store to throw monkeypatch the store on the composed app, as the
// transaction suites do. Restart paths compose a second app over the
// same db, as the sessions repair suite does; the reconnect they model
// is the client refetching the repaired detail and watching again, since
// no connection is open while compose runs the repair.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compose } from "../../src/server/compose.ts";
import { silent } from "../../src/server/lib/log.ts";
import { LOOP_LIMITS } from "../../src/server/runner/limits.ts";
import type { Offered, ToolResult } from "../../src/server/tools/index.ts";
import { TOOL_CAPS } from "../../src/server/tools/index.ts";
import type { Conn, ConnData } from "../../src/server/web/socket.ts";
import type { ToolCall } from "../../src/shared/contracts/tool.ts";
import type { SocketEvent } from "../../src/shared/socket.ts";
import { ORIGIN, VERSION } from "../helpers/app.ts";
import { createAutomation } from "../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  NO_TOOLS,
  type Script,
  startChat,
  type ToolCallFrame,
  tick,
  waitScript,
} from "../helpers/chat.ts";
import { fixture, mcpFetch } from "../server/mcp/fake.ts";

const DIR = join(import.meta.dir, "..", "fixtures", "socket");

type FakeConn = Conn & { frames: SocketEvent[]; closed: number[] };

// open a socket connection for the member through the real upgrade
// route, capturing the connection data and every frame the server sends
async function watcher(chat: ChatApp): Promise<FakeConn> {
  const client = chat.member;
  if (client.cookie === null) throw new Error("not signed in");
  let captured: ConnData | null = null;
  const req = new Request(`${ORIGIN}/api/socket`, {
    headers: { cookie: client.cookie, host: "1ctx.test", origin: ORIGIN },
  });
  await chat.app.handle(req, "127.0.0.1", (data) => {
    captured = data as ConnData;
    return true;
  });
  if (captured === null) throw new Error("no upgrade data");
  const conn: FakeConn = {
    data: captured,
    frames: [],
    closed: [],
    send(text) {
      conn.frames.push(JSON.parse(text));
      return text.length;
    },
    close(code) {
      conn.closed.push(code ?? 1000);
    },
  };
  chat.app.socket.open(conn);
  return conn;
}

const watch = (chat: ChatApp, conn: FakeConn, sessionId: string) =>
  chat.app.socket.message(conn, JSON.stringify({ type: "watch", sessionId }));

// the ids the server generates are random, so a fixture written as is
// would change on every run. Every id-valued field (id, or a key ending
// in Id) is renamed to a stable token in order of first appearance, per
// file, so a rerun reproduces the file byte for byte and git shows a
// change only when the traffic changed
const ID_KEY = /^(id|[a-zA-Z]+Id)$/;
const ID_VALUE = /^[0-9a-z]{12}$/;
function stable(lines: unknown[]): string[] {
  const names = new Map<string, string>();
  const walk = (value: unknown, key: string | null): unknown => {
    if (Array.isArray(value)) return value.map((v) => walk(v, null));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
      return out;
    }
    if (
      typeof value === "string" &&
      key !== null &&
      ID_KEY.test(key) &&
      ID_VALUE.test(value)
    ) {
      let name = names.get(value);
      if (name === undefined) {
        name = `id-${String(names.size + 1).padStart(2, "0")}`;
        names.set(value, name);
      }
      return name;
    }
    return value;
  };
  return lines.map((line) => JSON.stringify(walk(line, null)));
}

// write one ndjson from a chosen list of lines
function writeLines(name: string, lines: unknown[]): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, `${name}.ndjson`), `${stable(lines).join("\n")}\n`);
}

// write one ndjson from a chosen first line and the frames after hello
function write(name: string, first: unknown, conn: FakeConn): void {
  writeLines(name, [first, ...conn.frames.filter((f) => f.type !== "hello")]);
}

// the detail the POST answered is the initial state for a live watch
const record = (name: string, detail: unknown, conn: FakeConn) =>
  write(name, { kind: "detail", detail }, conn);

async function settle(chat: ChatApp, n = 6) {
  for (let i = 0; i < n; i++) {
    await tick();
    chat.app.now.value += 200;
    await tick();
  }
}

// a scripted tool call in the OpenAI wire shape the provider streams
const call = (
  id: string,
  args: Record<string, unknown> = { timezone: "UTC" },
) => ({
  id,
  name: "datetime",
  arguments: JSON.stringify(args),
});

// a tools capability the recorder controls: offered() answers the two
// built-in schemas so a send on a tools model gets a real request, and
// run() resolves each call from a script keyed by call id. This is the
// tools area's shape, so the rows the writer persists are the production
// rows; only the result is under the recorder's control.
type ToolPlan = {
  // resolve with this result
  result?: ToolResult;
  // wait this many fake-clock ms (via real setTimeout ticks) before
  // resolving, so parallel calls settle out of order
  delayTicks?: number;
  // stay pending until the send's signal aborts (a stop, a shutdown or a
  // restart-time cleanup), then reject, so the round's allSettled can
  // settle and the send lets its lock go once the terminal cause is set
  hang?: boolean;
  // run this before resolving, e.g. to advance the app clock so the
  // tool-ms budget is spent
  onRun?: () => void;
  // resolve late whether or not the signal aborted: an abort-ignoring
  // tool. It settles after this many ticks, so the round can complete
  // even though the send terminated first; its finishTool is then a
  // no-op guarded by the terminal cleanup
  ignoreAbort?: number;
};

type FakeToolsCap = {
  offered(now: number): Offered;
  run(
    offered: Offered,
    c: ToolCall,
    ctx: { signal: AbortSignal },
  ): Promise<ToolResult>;
};

function fakeTools(plans: Record<string, ToolPlan>): { tools: FakeToolsCap } {
  const schemas: Offered["tools"] = [
    {
      name: "datetime",
      description: "the current time",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "webfetch",
      description: "fetch a url",
      parameters: { type: "object", properties: {} },
    },
  ];
  return {
    tools: {
      offered: () => ({
        tools: schemas,
        search: null,
        skills: { block: "", skills: [] },
        mcp: [],
        mcpPrompt: { text: "", digest: {} },
        mcpCatalog: "",
        memory: null,
      }),
      async run(_offered, c, ctx) {
        const plan = plans[c.id] ?? {
          result: { content: `ran ${c.name}`, error: false },
        };
        if (plan.hang) {
          // pending until the send aborts; then reject so allSettled
          // settles. A tool that ignored the abort would keep the lock,
          // which the drain suite records; here the round must settle so
          // the terminal envelope is written and recorded.
          return new Promise<ToolResult>((_resolve, reject) => {
            if (ctx.signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            ctx.signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          });
        }
        if (plan.ignoreAbort) {
          // ignore the abort: keep working and resolve late
          for (let i = 0; i < plan.ignoreAbort; i++) await tick();
          return plan.result ?? { content: "late result", error: false };
        }
        if (plan.delayTicks) {
          for (let i = 0; i < plan.delayTicks; i++) await tick();
        }
        plan.onRun?.();
        return plan.result ?? { content: `ran ${c.name}`, error: false };
      },
    },
  };
}

// run a whole tool round then leave the stream open for the next round
function toolRound(script: Script, calls: ToolCallFrame[]) {
  calls.forEach((c, i) => {
    script.toolCall({ ...c, index: i });
  });
  script.finish("tool_calls");
  script.usage();
  script.end();
}

describe("socket fixtures", () => {
  // ----- the simple paths, recorded live from the POST detail -----

  test("a plain reply", async () => {
    const chat = await chatApp();
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "hello");
    watch(chat, conn, sessionId);
    script.content("Hi there.");
    await tick();
    script.finish();
    script.usage();
    script.end();
    await settle(chat);
    record("plain-reply", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.status).toBe("done");
    chat.app.socket.dispose();
  });

  test("a memory phase after a run answer", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const conn = await watcher(chat);
    const pending = chat.scripted.next();
    const response = await chat.member.call(
      "POST",
      `/api/automations/${automation.id}/run`,
    );
    const detail = await response.json();
    watch(chat, conn, detail.session.id);
    const main = await pending;
    main.reply("The task finished.");
    const memory = await waitScript(chat.scripted, 2);
    memory.toolRound([
      {
        id: "m1",
        name: "memory_edit",
        arguments:
          '{"action":"set","topic":"Status","text":"The task finished."}',
      },
    ]);
    memory.end();
    const finish = await waitScript(chat.scripted, 3);
    finish.reply("Recorded.");
    await settle(chat, 10);
    record("memory-phase", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
      status: "done",
      memoryRound: 2,
      rounds: 3,
      toolCalls: 1,
    });
    chat.app.socket.dispose();
  });

  test("a stop during the memory phase", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const conn = await watcher(chat);
    const pending = chat.scripted.next();
    const response = await chat.member.call(
      "POST",
      `/api/automations/${automation.id}/run`,
    );
    const detail = await response.json();
    watch(chat, conn, detail.session.id);
    const main = await pending;
    main.reply("The task finished.");
    const memory = await waitScript(chat.scripted, 2);
    memory.toolRound([
      {
        id: "m1",
        name: "memory_edit",
        arguments:
          '{"action":"set","topic":"Status","text":"Stopped before the note was done."}',
      },
    ]);
    memory.end();
    const open = await waitScript(chat.scripted, 3);
    await chat.member.call("POST", `/api/sessions/${detail.session.id}/stop`);
    await settle(chat, 10);
    record("stop-during-memory", detail, conn);
    expect(open.aborted).toBe(true);
    // the stop ends the fold, not the run: the cause the run claimed stands
    expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
      status: "done",
      cause: "finish",
      memoryRound: 2,
    });
    chat.app.socket.dispose();
  });

  test("thinking then an answer", async () => {
    const chat = await chatApp();
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "think");
    watch(chat, conn, sessionId);
    script.reasoning("let me think");
    await tick();
    script.content("The answer.");
    await tick();
    script.finish();
    script.usage();
    script.end();
    await settle(chat);
    record("thinking-answer", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.status).toBe("done");
    chat.app.socket.dispose();
  });

  test("a plain reply on a model without the tools flag", async () => {
    const chat = await chatApp({ model: NO_TOOLS });
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "plain");
    watch(chat, conn, sessionId);
    script.reply("no tools here");
    await settle(chat);
    record("no-tools", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.toolCalls).toBe(0);
    chat.app.socket.dispose();
  });

  test("a send that compacts after its answer", async () => {
    const chat = await chatApp();
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "long chat");
    watch(chat, conn, sessionId);
    script.content("the answer");
    await tick();
    script.finish();
    script.usage({ prompt: 1_040_000, completion: 10 });
    script.end();
    const summary = await waitScript(chat.scripted, 2);
    summary.content("## Goal\n\n- Continue");
    await tick();
    summary.finish();
    summary.usage({ prompt: 41_000, completion: 100 });
    summary.end();
    await settle(chat, 10);
    record("compact-after-answer", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.rounds).toBe(2);
    chat.app.socket.dispose();
  });

  test("a stop during the summary round", async () => {
    const chat = await chatApp();
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "stop summary");
    watch(chat, conn, sessionId);
    script.content("the answer");
    script.finish();
    script.usage({ prompt: 1_040_000, completion: 10 });
    script.end();
    const summary = await waitScript(chat.scripted, 2);
    summary.content("partial summary");
    await tick();
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await settle(chat, 10);
    record("stop-during-summary", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.status).toBe("stopped");
    chat.app.socket.dispose();
  });

  test("a compact send", async () => {
    const chat = await chatApp();
    const started = await startChat(chat, "compact this");
    started.script.reply("the answer");
    await settle(chat, 8);
    const conn = await watcher(chat);
    watch(chat, conn, started.sessionId);
    conn.frames = [];
    const pending = chat.scripted.next();
    const response = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/compact`,
    );
    expect(response.status).toBe(200);
    const detail = await response.json();
    const summary = await pending;
    summary.content("## Goal\n\n- Compact this");
    await tick();
    summary.finish();
    summary.usage({ prompt: 20, completion: 10 });
    summary.end();
    await settle(chat, 8);
    record("compact-send", detail, conn);
    expect(detail.send.kind).toBe("compact");
    chat.app.socket.dispose();
  });

  // ----- the tool-round paths, the real writer over a fake tools cap -----

  test("one tool round then an answer", async () => {
    const fake = fakeTools({
      c1: { result: { content: "12:00 UTC", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "what time");
    watch(chat, conn, sessionId);
    script.reasoning("let me check");
    toolRound(script, [call("c1")]);
    const r2 = await chat.scripted.next();
    r2.reply("It is noon.");
    await settle(chat, 10);
    record("one-tool-round", detail, conn);
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send).toMatchObject({ status: "done", rounds: 2, toolCalls: 1 });
    chat.app.socket.dispose();
  });

  test("an MCP tool round then an answer", async () => {
    const flux = mcpFetch({ recorded: await fixture("flux") });
    const chat = await chatApp({ fetcher: flux.fetcher });
    const { server } = await (
      await chat.admin.call("POST", "/api/mcp", {
        body: {
          name: "flux",
          url: "http://flux.test/mcp",
          keyName: null,
          read: true,
          write: false,
          instructionsOn: true,
          timeoutMs: null,
          readPatterns: ["get_*"],
          writePatterns: [],
          excludedPatterns: [],
        },
      })
    ).json();
    const agent = chat.app.agents.byId(chat.agentId)!;
    const saved = await chat.admin.call("PATCH", `/api/agents/${agent.id}`, {
      body: {
        name: agent.name,
        avatar: agent.avatar,
        providerId: agent.providerId,
        model: agent.model.id,
        thinking: agent.thinking,
        effort: agent.effort,
        prompt: agent.prompt,
        skills: agent.skills,
        servers: [{ serverId: server.id, read: true, write: false }],
        mcpMode: "all",
      },
    });
    expect(saved.status).toBe(200);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "inspect flux");
    watch(chat, conn, sessionId);
    toolRound(script, [
      {
        id: "c1",
        name: "mcp__flux__get_flux_instance",
        arguments: "{}",
      },
    ]);
    const r2 = await chat.scripted.next();
    r2.reply("Flux is ready.");
    await settle(chat, 10);
    record("mcp-call", detail, conn);
    const row = chat.app.sessions
      .messages(sessionId)
      .find((message) => message.kind === "tool")!;
    expect(row).toMatchObject({
      toolName: "mcp__flux__get_flux_instance",
      status: "done",
      content: "called",
    });
    chat.app.socket.dispose();
  });

  test("two tool rounds then an answer", async () => {
    const fake = fakeTools({
      c1: { result: { content: "first", error: false } },
      c2: { result: { content: "second", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "twice");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1")]);
    const r2 = await chat.scripted.next();
    toolRound(r2, [call("c2", { timezone: "Asia/Tokyo" })]);
    const r3 = await chat.scripted.next();
    r3.reply("done at last");
    await settle(chat, 14);
    record("two-tool-rounds", detail, conn);
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send).toMatchObject({ status: "done", rounds: 3, toolCalls: 2 });
    chat.app.socket.dispose();
  });

  test("narration before a call", async () => {
    const fake = fakeTools({
      c1: { result: { content: "noon", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "when");
    watch(chat, conn, sessionId);
    script.content("I will check the clock.");
    await tick();
    toolRound(script, [call("c1")]);
    const r2 = await chat.scripted.next();
    r2.reply("It is noon.");
    await settle(chat, 10);
    record("narration-before-call", detail, conn);
    const work = chat.app.sessions.messages(sessionId)[1]!;
    expect(work.content).toBe("I will check the clock.");
    chat.app.socket.dispose();
  });

  test("calls with no text", async () => {
    const fake = fakeTools({
      c1: { result: { content: "value", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "no text");
    watch(chat, conn, sessionId);
    // the round streams a call with no content before it
    toolRound(script, [call("c1")]);
    const r2 = await chat.scripted.next();
    r2.reply("here it is");
    await settle(chat, 10);
    record("calls-no-text", detail, conn);
    const work = chat.app.sessions.messages(sessionId)[1]!;
    expect(work.content).toBe("");
    chat.app.socket.dispose();
  });

  test("parallel calls finishing out of order", async () => {
    // c1 resolves last, c3 first, so the tool envelopes arrive in an
    // order the calls were not launched in
    const fake = fakeTools({
      c1: { delayTicks: 6, result: { content: "one", error: false } },
      c2: { delayTicks: 3, result: { content: "two", error: false } },
      c3: { delayTicks: 1, result: { content: "three", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "several");
    watch(chat, conn, sessionId);
    toolRound(script, [
      call("c1", { timezone: "UTC" }),
      call("c2", { timezone: "Asia/Tokyo" }),
      call("c3", { timezone: "Europe/Paris" }),
    ]);
    const r2 = await chat.scripted.next();
    r2.reply("all done");
    await settle(chat, 16);
    record("parallel-out-of-order", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.toolCalls).toBe(3);
    chat.app.socket.dispose();
  });

  // ----- the tool-error paths -----

  test("a tool that fails", async () => {
    const fake = fakeTools({
      c1: { result: { content: "the tool broke", error: true } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "fail tool");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1")]);
    const r2 = await chat.scripted.next();
    r2.reply("recovered");
    await settle(chat, 10);
    record("tool-failed", detail, conn);
    const toolRow = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "tool")!;
    expect(toolRow.status).toBe("failed");
    chat.app.socket.dispose();
  });

  test("a tool timeout", async () => {
    // a slow tool that returns a deadline error, as webfetch does when
    // its per-request deadline passes
    const fake = fakeTools({
      c1: { result: { content: "the request timed out", error: true } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "slow tool");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1", { url: "http://slow.test" })]);
    const r2 = await chat.scripted.next();
    r2.reply("gave up on the fetch");
    await settle(chat, 10);
    record("tool-timeout", detail, conn);
    const toolRow = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "tool")!;
    expect(toolRow.status).toBe("failed");
    expect(toolRow.content).toContain("timed out");
    chat.app.socket.dispose();
  });

  test("malformed arguments", async () => {
    // a real tools area turns bad json into a failed result; the fake
    // does the same so the row shape matches
    const fake = fakeTools({
      c1: { result: { content: "arguments were not valid json", error: true } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "bad args");
    watch(chat, conn, sessionId);
    script.toolCall({
      index: 0,
      id: "c1",
      name: "datetime",
      arguments: "{not json",
    });
    script.finish("tool_calls");
    script.usage();
    script.end();
    const r2 = await chat.scripted.next();
    r2.reply("ok");
    await settle(chat, 10);
    record("malformed-arguments", detail, conn);
    const toolRow = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "tool")!;
    expect(toolRow.status).toBe("failed");
    chat.app.socket.dispose();
  });

  test("an unknown tool", async () => {
    const fake = fakeTools({
      c1: {
        result: { content: "tool not found: does_not_exist", error: true },
      },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "call nothing");
    watch(chat, conn, sessionId);
    script.toolCall({
      index: 0,
      id: "c1",
      name: "does_not_exist",
      arguments: "{}",
    });
    script.finish("tool_calls");
    script.usage();
    script.end();
    const r2 = await chat.scripted.next();
    r2.reply("recovered");
    await settle(chat, 10);
    record("unknown-tool", detail, conn);
    const toolRow = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "tool")!;
    expect(toolRow.status).toBe("failed");
    chat.app.socket.dispose();
  });

  test("duplicate call ids", async () => {
    // the provider streams two calls under one id; each still gets a row
    const fake = fakeTools({
      dup: { result: { content: "value", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "dupes");
    watch(chat, conn, sessionId);
    script.toolCall({
      index: 0,
      id: "dup",
      name: "datetime",
      arguments: '{"timezone":"UTC"}',
    });
    script.toolCall({
      index: 1,
      id: "dup",
      name: "datetime",
      arguments: '{"timezone":"Asia/Tokyo"}',
    });
    script.finish("tool_calls");
    script.usage();
    script.end();
    const r2 = await chat.scripted.next();
    r2.reply("done");
    await settle(chat, 12);
    record("duplicate-call-ids", detail, conn);
    expect(
      chat.app.sessions
        .messages(sessionId)
        .filter((row) => row.kind === "tool"),
    ).toHaveLength(2);
    chat.app.socket.dispose();
  });

  test("an abort-ignoring tool", async () => {
    // the tool keeps working after a stop aborts the send; the send ends
    // stopped at once (its open tool row written stopped by the terminal
    // cleanup) and the tool's late finishTool is a guarded no-op, so no
    // further envelope follows the terminal one
    const fake = fakeTools({
      c1: { ignoreAbort: 8, result: { content: "late", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "ignore abort");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1")]);
    // let the round finish and the tool launch, then stop while it runs
    await settle(chat, 2);
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await settle(chat, 12);
    record("abort-ignoring-tool", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("stop");
    const toolRow = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "tool")!;
    // the terminal cleanup wrote the open row stopped; the late result
    // did not overwrite it
    expect(toolRow.status).toBe("stopped");
    chat.app.socket.dispose();
  });

  test("a finishTool failure", async () => {
    // finishTool throws while writing a tool's end; the runner terminates
    // the send with failure, so the terminal envelope is a failed send
    const fake = fakeTools({
      c1: { result: { content: "value", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(
      chat,
      "tool write fail",
    );
    watch(chat, conn, sessionId);
    const original = chat.app.sessions.finishTool.bind(chat.app.sessions);
    let throwOnce = false;
    (chat.app.sessions as { finishTool: unknown }).finishTool = (
      ...args: unknown[]
    ) => {
      // throw on the loop's tool-end write, then restore so finalizeSend
      // can commit the failed terminal envelope (its open-row cleanup and
      // the send row)
      if (throwOnce) {
        throwOnce = false;
        (chat.app.sessions as { finishTool: unknown }).finishTool = original;
        throw new Error("tool row write failed");
      }
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    toolRound(script, [call("c1")]);
    throwOnce = true;
    await settle(chat, 10);
    (chat.app.sessions as { finishTool: unknown }).finishTool = original;
    record("finishtool-failure", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("failure");
    chat.app.socket.dispose();
  });

  // ----- the cap and loop paths -----
  test("the round cap", async () => {
    const fake = fakeTools({});
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, sessionId } = await startChat(chat, "many rounds");
    watch(chat, conn, sessionId);
    // every work round asks a fresh distinct call so the loop check never
    // trips; the cap reserves the last round for the answer
    for (let round = 1; round <= LOOP_LIMITS.rounds; round++) {
      const send = chat.app.sessions.send(detail.send.id)!;
      if (send.status !== "running") break;
      const script = await waitScript(chat.scripted, round);
      if (round === LOOP_LIMITS.rounds) {
        script.reply("done after the cap");
      } else {
        toolRound(script, [
          call(`r${round}`, { timezone: `Etc/GMT+${(round % 12) + 1}` }),
        ]);
      }
      await settle(chat, 6);
    }
    await settle(chat, 10);
    record("cap-rounds", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.rounds).toBe(
      LOOP_LIMITS.rounds,
    );
    chat.app.socket.dispose();
  });

  test("the call cap", async () => {
    const fake = fakeTools({});
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(
      chat,
      "too many at once",
    );
    watch(chat, conn, sessionId);
    const many = Array.from({ length: LOOP_LIMITS.callsPerRound + 1 }, (_, i) =>
      call(`c${i}`, { timezone: `Etc/GMT+${(i % 12) + 1}` }),
    );
    toolRound(script, many);
    const r2 = await chat.scripted.next();
    r2.reply("answered without the tools");
    await settle(chat, 10);
    record("cap-calls", detail, conn);
    const toolRows = chat.app.sessions
      .messages(sessionId)
      .filter((r) => r.kind === "tool");
    expect(toolRows.every((r) => r.status === "stopped")).toBe(true);
    chat.app.socket.dispose();
  });

  test("the time cap", async () => {
    // round 1's tool advances the app clock past MAX_TOOL_MS while it
    // runs, so the tool-ms budget is spent and round 2's call is
    // forbidden: the loop enters the answer round with a tool_limit reply
    const holder: { chat: ChatApp | null } = { chat: null };
    const fake = fakeTools({
      c1: {
        result: { content: "slow", error: false },
        onRun: () => {
          if (holder.chat)
            holder.chat.app.now.value += LOOP_LIMITS.toolMs + 1000;
        },
      },
    });
    const chat = await chatApp(fake);
    holder.chat = chat;
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "long tools");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1")]);
    const r2 = await waitScript(chat.scripted, 2);
    // round 2 asks for another call, but the time budget forbids it
    toolRound(r2, [call("c2")]);
    const r3 = await waitScript(chat.scripted, 3);
    r3.reply("out of time for tools");
    await settle(chat, 12);
    record("cap-time", detail, conn);
    const replies = chat.app.sessions
      .messages(sessionId)
      .filter((r) => r.kind === "reply");
    expect(replies.some((r) => r.finishReason === "tool_limit")).toBe(true);
    chat.app.socket.dispose();
  });

  test("the result cap with a cut result", async () => {
    // each call returns more than MAX_RESULT_CHARS, cut to that before the
    // byte cap weighs it; rounds of callsPerRound such calls accumulate
    // stored bytes until the send is over MAX_RESULT_BYTES, and the next
    // round's calls are forbidden: the loop enters the answer round with a
    // tool_limit reply. Every call id maps to the same big result.
    const big = "x".repeat(TOOL_CAPS.resultCut + 5000);
    const plans: Record<string, ToolPlan> = {};
    for (let r = 1; r <= LOOP_LIMITS.rounds; r++) {
      for (let i = 0; i < LOOP_LIMITS.callsPerRound; i++) {
        plans[`r${r}c${i}`] = { result: { content: big, error: false } };
      }
    }
    const fake = fakeTools(plans);
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, sessionId } = await startChat(chat, "big results");
    watch(chat, conn, sessionId);
    // drive rounds of the max calls until the send is no longer running:
    // the byte budget trips and the loop lands on the answer round
    for (let round = 1; round <= LOOP_LIMITS.rounds; round++) {
      const send = chat.app.sessions.send(detail.send.id)!;
      if (send.status !== "running") break;
      const script = await waitScript(chat.scripted, round);
      const calls = Array.from({ length: LOOP_LIMITS.callsPerRound }, (_, i) =>
        call(`r${round}c${i}`, {
          timezone: `Etc/GMT+${((round * 7 + i) % 12) + 1}`,
        }),
      );
      toolRound(script, calls);
      await settle(chat, 8);
    }
    await settle(chat, 10);
    record("cap-result", detail, conn);
    const toolRow = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "tool")!;
    expect(toolRow.content.length).toBe(TOOL_CAPS.resultCut);
    const replies = chat.app.sessions
      .messages(sessionId)
      .filter((r) => r.kind === "reply");
    expect(replies.some((r) => r.finishReason === "tool_limit")).toBe(true);
    chat.app.socket.dispose();
  });

  test("the loop check", async () => {
    const fake = fakeTools({});
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, sessionId } = await startChat(chat, "loop");
    watch(chat, conn, sessionId);
    // three rounds asking the very same call; the third trips the loop
    // check, records the calls not run and ends tool_loop
    for (let round = 1; round <= 3; round++) {
      const script = await waitScript(chat.scripted, round);
      toolRound(script, [call("same")]);
      await settle(chat, 6);
    }
    await settle(chat, 10);
    record("loop-check", detail, conn);
    const lastReply = chat.app.sessions
      .messages(sessionId)
      .filter((r) => r.kind === "reply")
      .at(-1)!;
    expect(lastReply.finishReason).toBe("tool_loop");
    chat.app.socket.dispose();
  });

  test("calls in the answer round", async () => {
    const fake = fakeTools({});
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "answer calls");
    watch(chat, conn, sessionId);
    // over the per-round cap sends the loop straight to the answer round
    const many = Array.from({ length: LOOP_LIMITS.callsPerRound + 1 }, (_, i) =>
      call(`c${i}`, { timezone: `Etc/GMT+${(i % 12) + 1}` }),
    );
    toolRound(script, many);
    // the answer round: the provider calls anyway, which ends tool_limit
    const answer = await chat.scripted.next();
    toolRound(answer, [call("again")]);
    await settle(chat, 12);
    record("calls-in-answer-round", detail, conn);
    const lastReply = chat.app.sessions
      .messages(sessionId)
      .filter((r) => r.kind === "reply")
      .at(-1)!;
    expect(lastReply.finishReason).toBe("tool_limit");
    chat.app.socket.dispose();
  });

  test("a cut round with partial calls", async () => {
    const fake = fakeTools({});
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "cut round");
    watch(chat, conn, sessionId);
    // a length finish with the call partially assembled: recorded, not run
    script.toolCall(call("c1"));
    script.finish("length");
    script.usage();
    script.end();
    await settle(chat, 8);
    record("cut-round", detail, conn);
    const reply = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "reply")!;
    expect(reply.finishReason).toBe("length");
    chat.app.socket.dispose();
  });

  // ----- the terminal paths mid-work -----

  test("stop during a work round's text after the first delta", async () => {
    const fake = fakeTools({});
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "stop text");
    watch(chat, conn, sessionId);
    script.content("thinking about a tool");
    script.toolCall(call("c1"));
    await tick();
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await settle(chat, 8);
    record("stop-work-text", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("stop");
    chat.app.socket.dispose();
  });

  test("stop after a call delta before the calls assembled", async () => {
    const fake = fakeTools({});
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "stop precall");
    watch(chat, conn, sessionId);
    // a call delta arrives (the slot moves to work), then a stop before
    // the stream ends and the calls are assembled
    script.toolCall(call("c1"));
    await tick();
    await tick();
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await settle(chat, 8);
    record("stop-after-call-delta", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("stop");
    chat.app.socket.dispose();
  });

  test("stop during a tool", async () => {
    // an abort-ignoring tool keeps the send in the tools phase; a stop
    // ends the send and its open tool row is written stopped
    const fake = fakeTools({ c1: { hang: true } });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "stop tool");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1")]);
    // let the round finish and the tool launch, then stop
    await settle(chat, 4);
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await settle(chat, 8);
    record("stop-during-tool", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("stop");
    // a send with no memory phase stops its open tool row inside the
    // terminal transaction, so the stop is one envelope, not two
    const last = conn.frames.filter((f) => f.type === "session").at(-1)!;
    expect(last.send?.cause).toBe("stop");
    expect(last.messages.map((row) => [row.kind, row.status])).toContainEqual([
      "tool",
      "stopped",
    ]);
    chat.app.socket.dispose();
  });

  test("stop during the answer", async () => {
    const fake = fakeTools({
      c1: { result: { content: "value", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "stop answer");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1")]);
    const r2 = await chat.scripted.next();
    // the answer round streams then a stop arrives before it finishes
    r2.content("beginning the answer");
    await tick();
    await tick();
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await settle(chat, 8);
    record("stop-during-answer", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("stop");
    chat.app.socket.dispose();
  });

  test("a provider failure in round 2 after tools", async () => {
    const fake = fakeTools({
      c1: { result: { content: "value", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "fail later");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1")]);
    const r2 = await chat.scripted.next();
    // round 2 ends the stream with no finish: the wire reports it early
    r2.content("partial");
    r2.end();
    await settle(chat, 10);
    record("provider-failure-round2", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("failure");
    chat.app.socket.dispose();
  });

  test("shutdown during a tool", async () => {
    const fake = fakeTools({ c1: { hang: true } });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "shut tool");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1")]);
    await settle(chat, 4);
    await chat.app.shutdown();
    record("shutdown-during-tool", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("shutdown");
    // shutdown disposed the socket already
  });

  test("a finalization failure after a work round", async () => {
    // finishSend throws on every attempt, so the send cannot finalize and
    // stays running; the frames recorded are the work round's, then
    // nothing, since finalizeSend never commits
    const fake = fakeTools({
      c1: { result: { content: "value", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(
      chat,
      "finalize fail",
    );
    watch(chat, conn, sessionId);
    const original = chat.app.sessions.finishSend.bind(chat.app.sessions);
    (chat.app.sessions as { finishSend: unknown }).finishSend = () => {
      throw new Error("db is gone");
    };
    toolRound(script, [call("c1")]);
    const r2 = await chat.scripted.next();
    r2.reply("would answer");
    await settle(chat, 12);
    (chat.app.sessions as { finishSend: unknown }).finishSend = original;
    record("finalization-failure", detail, conn);
    // the send never finalized: it is still running
    expect(chat.app.sessions.send(detail.send.id)!.status).toBe("running");
    chat.app.socket.dispose();
  });

  // ----- the restart paths: compose a second app over the same db -----

  // build an interrupted send left in a given phase, then compose a fresh
  // app over the same db (as the sessions repair suite does) and record
  // the reconnect: the client refetches the now-repaired detail and
  // watches again. No connection is open while compose runs the repair,
  // so the reconnect is a refetch plus the watched answer, not a live
  // envelope; that is the real client path after a restart.
  async function restart(
    name: string,
    plans: Record<string, ToolPlan>,
    build: (chat: ChatApp, sessionId: string, sendId: string) => Promise<void>,
  ) {
    const fake = fakeTools(plans);
    const chat = await chatApp(fake);
    const { detail, sessionId } = await startChat(chat, name);
    await build(chat, sessionId, detail.send.id);
    // drop the first app's socket subscription before the repair fires on
    // the shared bus
    chat.app.socket.dispose();
    const fresh = await compose({
      db: chat.app.db,
      secret: (n) => (n === "admin" ? "hunter2-test" : null),
      clock: () => chat.app.now.value,
      fetcher: chat.scripted.fetcher,
      log: () => silent,
      version: VERSION,
      secureCookie: false,
      trustProxy: false,
      tools: fake.tools,
    });
    // the reconnect: fetch the repaired detail through the fresh app (its
    // runner has nothing running, so live is null), then open a socket on
    // the fresh app and watch again. The member's login row is in the
    // shared db, so its cookie is valid on the fresh app.
    const detailReq = new Request(`${ORIGIN}/api/sessions/${sessionId}`, {
      headers: { cookie: chat.member.cookie!, host: "1ctx.test" },
    });
    const res = (await fresh.handle(detailReq, "127.0.0.1"))!;
    const repaired = await res.json();
    let captured: ConnData | null = null;
    const req = new Request(`${ORIGIN}/api/socket`, {
      headers: {
        cookie: chat.member.cookie!,
        host: "1ctx.test",
        origin: ORIGIN,
      },
    });
    await fresh.handle(req, "127.0.0.1", (data) => {
      captured = data as ConnData;
      return true;
    });
    const conn: FakeConn = {
      data: captured!,
      frames: [],
      closed: [],
      send(text) {
        conn.frames.push(JSON.parse(text));
        return text.length;
      },
      close(code) {
        conn.closed.push(code ?? 1000);
      },
    };
    fresh.socket.open(conn);
    fresh.socket.message(conn, JSON.stringify({ type: "watch", sessionId }));
    write(name, { kind: "fetched", detail: repaired }, conn);
    expect(fresh.sessions.send(detail.send.id)!.cause).toBe("restart");
    fresh.socket.dispose();
  }

  test("restart during tools", async () => {
    await restart(
      "restart-during-tools",
      { c1: { hang: true } },
      async (chat) => {
        const script = chat.scripted.scripts[0];
        toolRound(script, [call("c1")]);
        // the round finishes and the tool launches (and hangs), leaving the
        // send in the tools phase when the crash happens
        await settle(chat, 4);
      },
    );
  });

  test("restart during round 2", async () => {
    await restart(
      "restart-round2",
      { c1: { result: { content: "value", error: false } } },
      async (chat) => {
        const script = chat.scripted.scripts[0];
        toolRound(script, [call("c1")]);
        await settle(chat, 4);
        // round 2 starts streaming, then the crash: a work reply and a new
        // streaming reply exist, the stream left open
        const r2 = await waitScript(chat.scripted, 2);
        r2.content("streaming round 2");
        await tick();
        await tick();
      },
    );
  });

  test("restart after tools before startRound", async () => {
    await restart(
      "restart-after-tools",
      { c1: { result: { content: "v", error: false } } },
      async (chat) => {
        // round 1 is done and its tool row done; the loop writes round 2's
        // reply synchronously after the tool settles, so the earliest
        // interrupted state repair can see is a bare, empty round-2 reply
        // still streaming with no content, distinct from the round-2 case
        // where content had already streamed
        const script = chat.scripted.scripts[0];
        toolRound(script, [call("c1")]);
        await settle(chat, 2);
      },
    );
  });

  // ----- the reconnect and delivery paths -----

  test("reconnect during tools", async () => {
    // a hanging tool keeps the send in the tools phase; the client
    // reconnects, refetches the detail and watches, and the watched
    // answer carries the tools-phase live snapshot
    const fake = fakeTools({ c1: { hang: true } });
    const chat = await chatApp(fake);
    const first = await watcher(chat);
    const { sessionId } = await startChat(chat, "reconnect tools");
    watch(chat, first, sessionId);
    chat.scripted.scripts[0] &&
      toolRound(chat.scripted.scripts[0], [call("c1")]);
    // the round finishes and the tool launches (hangs): the send is in
    // the tools phase, nothing streaming
    await settle(chat, 4);
    // the reconnect: refetch the detail, open a new connection, watch
    const res = await chat.member.call("GET", `/api/sessions/${sessionId}`);
    const detail = await res.json();
    const conn = await watcher(chat);
    watch(chat, conn, sessionId);
    write("reconnect-during-tools", { kind: "fetched", detail }, conn);
    const watched = conn.frames.find((f) => f.type === "watched") as
      | Extract<SocketEvent, { type: "watched" }>
      | undefined;
    expect(watched?.live?.phase).toBe("tools");
    chat.app.socket.dispose();
  });

  test("reconnect during round 2 with a new reply id", async () => {
    const fake = fakeTools({
      c1: { result: { content: "value", error: false } },
    });
    const chat = await chatApp(fake);
    const first = await watcher(chat);
    const { detail: initial, sessionId } = await startChat(
      chat,
      "reconnect r2",
    );
    watch(chat, first, sessionId);
    toolRound(chat.scripted.scripts[0], [call("c1")]);
    await settle(chat, 4);
    // round 2 is streaming a fresh reply row (a new id, not the round-1
    // reply); the client reconnects mid round 2
    const r2 = await waitScript(chat.scripted, 2);
    r2.content("answering now");
    await tick();
    await tick();
    const res = await chat.member.call("GET", `/api/sessions/${sessionId}`);
    const detail = await res.json();
    const conn = await watcher(chat);
    watch(chat, conn, sessionId);
    write("reconnect-round2", { kind: "fetched", detail }, conn);
    const watched = conn.frames.find((f) => f.type === "watched") as
      | Extract<SocketEvent, { type: "watched" }>
      | undefined;
    expect(watched?.live?.phase).toBe("reply");
    // the streaming reply is a new row, not the round-1 reply
    if (watched?.live?.phase === "reply") {
      expect(watched.live.messageId).not.toBe(initial.messages[1].id);
    }
    // let the send finish so the app disposes cleanly
    r2.finish();
    r2.usage();
    r2.end();
    await settle(chat, 8);
    chat.app.socket.dispose();
  });

  test("a stale lower-revision envelope after a full detail", async () => {
    // the client holds a fresh detail (a later revision) and then a lower
    // -revision session envelope arrives: the fixture is the detail at
    // the final revision followed by an earlier envelope the reducer must
    // drop. Recorded by watching from the start, then using an earlier
    // captured envelope as the trailing line against the final detail.
    const chat = await chatApp();
    const conn = await watcher(chat);
    const { script, sessionId } = await startChat(chat, "stale");
    watch(chat, conn, sessionId);
    script.content("Hello.");
    await tick();
    // capture the running (revision 1) session envelope before the send
    // finishes
    const early = conn.frames.find((f) => f.type === "session") as Extract<
      SocketEvent,
      { type: "session" }
    >;
    script.finish();
    script.usage();
    script.end();
    await settle(chat, 8);
    // the final detail is at the higher revision
    const res = await chat.member.call("GET", `/api/sessions/${sessionId}`);
    const finalDetail = await res.json();
    // the fixture: the final detail, then the stale lower-revision
    // envelope the reducer must ignore
    writeLines("stale-envelope", [
      { kind: "detail", detail: finalDetail },
      early,
    ]);
    expect(finalDetail.session.revision).toBeGreaterThan(
      early.session.revision,
    );
    chat.app.socket.dispose();
  });

  test("a dropped envelope then a reconnect", async () => {
    // the connection drops a frame (send returns 0), the socket closes it
    // with 1013, and the client reconnects: refetch the detail and watch.
    // The fixture records the frames up to the drop, then the reconnect's
    // fetched detail and watched answer as a second block is not possible
    // in one file, so the file is the initial detail, the frames before
    // the drop, and then the fetched detail plus watched of the reconnect.
    const chat = await chatApp();
    // a connection whose send fails after the first frame, forcing a drop
    const client = chat.member;
    let captured: ConnData | null = null;
    const req = new Request(`${ORIGIN}/api/socket`, {
      headers: { cookie: client.cookie!, host: "1ctx.test", origin: ORIGIN },
    });
    await chat.app.handle(req, "127.0.0.1", (data) => {
      captured = data as ConnData;
      return true;
    });
    let calls = 0;
    const conn: FakeConn = {
      data: captured!,
      frames: [],
      closed: [],
      send(text) {
        calls += 1;
        conn.frames.push(JSON.parse(text));
        // the hello and the watched go through; the first stream/session
        // frame after that drops
        return calls >= 3 ? 0 : text.length;
      },
      close(code) {
        conn.closed.push(code ?? 1000);
      },
    };
    chat.app.socket.open(conn);
    const { sessionId } = await startChat(chat, "dropped");
    watch(chat, conn, sessionId);
    chat.scripted.scripts[0].content("partial");
    await tick();
    // the connection was closed with 1013 on the dropped frame
    expect(conn.closed).toContain(1013);
    chat.scripted.scripts[0].finish();
    chat.scripted.scripts[0].usage();
    chat.scripted.scripts[0].end();
    await settle(chat, 8);
    // the reconnect: a fresh connection refetches and watches
    const res = await chat.member.call("GET", `/api/sessions/${sessionId}`);
    const detail = await res.json();
    const conn2 = await watcher(chat);
    watch(chat, conn2, sessionId);
    write("dropped-then-reconnect", { kind: "fetched", detail }, conn2);
    chat.app.socket.dispose();
  });

  // ----- a skill tool row, over the real tools cap and a real skill -----

  test("a skill tool round then an answer", async () => {
    // the default chatApp uses the real tools area and the real skills
    // capability, so a skill assigned to the agent is offered and a
    // scripted skill call runs the real skill tool, writing a tool row
    // whose name is "skill", the fixture the client's skill fold reads
    const chat = await chatApp();
    chat.app.skills.create(
      {
        name: "gitops-knowledge",
        description: "Flux CD expert",
        body: "Use the gitops skill.",
        license: "",
        compatibility: "",
        metadata: {},
        allowedTools: "",
        sourceKind: "file",
        sourceUrl: "https://skills.test/gitops.md",
        sourceSelect: "",
        sourceDigest: "",
        digest: "gitops-digest",
        dropped: [],
        droppedMore: 0,
        files: [],
      },
      chat.app.now.value,
    );
    const skill = chat.app.skills.list()[0]!;
    chat.app.skills.assign(chat.agentId, [skill.id]);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "flux help");
    watch(chat, conn, sessionId);
    toolRound(script, [
      {
        id: "c1",
        name: "skill",
        arguments: JSON.stringify({ name: "gitops-knowledge" }),
      },
    ]);
    const r2 = await chat.scripted.next();
    r2.reply("Here is what the skill says.");
    await settle(chat, 10);
    record("skill-tool-round", detail, conn);
    const row = chat.app.sessions
      .messages(sessionId)
      .find((message) => message.kind === "tool")!;
    expect(row.toolName).toBe("skill");
    expect(row.status).toBe("done");
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send).toMatchObject({ status: "done", rounds: 2, toolCalls: 1 });
    chat.app.socket.dispose();
  });
});
